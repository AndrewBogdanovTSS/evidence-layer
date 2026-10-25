/**
 * The seal - a local ledger of what the gatherer actually produced, and of the
 * source it produced it from.
 *
 * The claims it makes falsifiable: "this block is the one the gatherer wrote",
 * and "the code has not changed since it was gathered".
 *
 * `claims` proves a VERIFIED tag points at a block in the document. It cannot
 * tell a block the gatherer wrote from one typed in by hand, an output line
 * edited after the fact, or a block from an older run pasted back in - and it
 * cannot tell a review written right after the tests ran from one written
 * after three more edits. Both are what an agent does by default, not by
 * malice: it edits the code after running the suite, then reports the suite.
 *
 * Every gather publishes one **run**: a directory holding the bundle it wrote
 * and a seal that hashes each artifact block in it, plus a fingerprint of the
 * source it ran against. `current.json` names the newest complete run, and is
 * replaced only once that run's directory is whole - so a reader never pairs
 * one run's bundle with another's seal, and a gather that failed, was
 * interrupted, or saw the tree change under it never becomes current at all.
 *
 *     <git-path>/evidence-layer/
 *       current.json            { "schemaVersion": 1, "runId": "..." }
 *       runs/<run-id>/bundle.md
 *       runs/<run-id>/seal.json
 *
 * The source fingerprint is a git tree id of the working directory's
 * *content*, computed through a throwaway index so the real one is never
 * touched: it does not move when a commit records content that did not
 * change, and it does move when any tracked or non-ignored file does - is
 * edited, added, deleted, renamed, or made executable, or a symbolic link is
 * pointed elsewhere. What git does not record, it cannot see: the executable
 * bit where `core.fileMode` is off (the Windows default), other permission
 * bits, timestamps, and empty directories.
 *
 * What it is not: an attestation. The seal lives in `.git/`, which the same
 * agent can write to. It catches the default failure - a block written by
 * hand, output edited, a stale run, code changed after gathering - and not
 * someone rewriting the ledger on purpose. CI, which gathers its own evidence,
 * stays the independent party. See `docs/plans/runtime-gate-decisions.md` for
 * the choices behind the layout, and why there is no lock.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { classifyCommand, fencedLineNumbers, findArtifactBlocks } from './artifact'
import type { FencedBlock, StopReason } from './artifact'
import { findClaims } from './claims'
import type { CodedFinding } from './codes'
import { isRecord } from './json'
import { git, gitCapture } from './proc'

/** Untracked files above this are compared by size and mtime, not hashed into the tree. */
export const LARGE_UNTRACKED_BYTES = 5 * 1024 * 1024

/** How many run directories a gather keeps. `current.json`'s run is always one of them. */
export const RUNS_KEPT = 5

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// ---------------------------------------------------------------------------
// Where state lives

/** The repository's top level, or `null` outside one. */
export function repoRoot(repo: string): string | null {
  return gitCapture(['rev-parse', '--show-toplevel'], repo)
}

/**
 * `<git-path>/evidence-layer` - per worktree, never in the source tree, and
 * found through git rather than by assuming `.git` is a directory: in a linked
 * worktree or a submodule it is a file.
 */
export function stateDir(repo: string): string | null {
  const path = gitCapture(['rev-parse', '--git-path', 'evidence-layer'], repo)
  return path === null ? null : resolve(repo, path)
}

/** A path as git names it relative to the top level - forward slashes, no `./` - or `null` when it lies outside. */
function rootRelative(root: string, cwd: string, path: string): string | null {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  const rel = relative(root, absolute)
  // Outside the repository: `../` up and out, or - across Windows drives,
  // where `relative` has no way up - the other path returned whole.
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/**
 * Paths as the seal records them: relative to the repository's top level, so a
 * later comparison from another directory - or a moved checkout - leaves out
 * exactly the same files. Relative inputs are resolved against `cwd`.
 */
export function toRootRelative(repo: string, paths: string[], cwd = repo): string[] {
  const root = repoRoot(repo)
  if (!root) return paths
  // A path outside the repository is not part of the source surface anyway,
  // and git refuses to be handed one.
  const inside = paths.map((p) => rootRelative(root, cwd, p)).filter((p) => p !== null)
  return [...new Set(inside)].sort()
}

// ---------------------------------------------------------------------------
// The source fingerprint

export interface LargeUntracked {
  path: string
  size: number
  mtimeMs: number
}

export interface SourceFingerprint {
  /** `git write-tree` over a throwaway index holding the working directory's content. */
  treeId: string
  /** Untracked files too large to hash, recorded by metadata - which is weaker evidence. */
  largeUntracked: LargeUntracked[]
  /** `partial` when some of the surface was compared by metadata or not at all. */
  coverage: 'complete' | 'partial'
  partialBecause: string[]
}

export type FingerprintResult = { fingerprint: SourceFingerprint } | { unverifiable: string }

/**
 * The working directory's content, as a tree id.
 *
 * `excluded` names files that must never move the fingerprint - the review
 * under check and the bundle copy - since writing them is the very thing that
 * happens after evidence is gathered. The list is fixed by the caller and
 * recorded in the seal; it is not configurable to anything wider, because an
 * ignore list that can name `src/` is a way around freshness.
 *
 * A repository mode the throwaway index would not describe faithfully - a
 * sparse checkout, a split index, unresolved conflicts - is `unverifiable`
 * rather than a guess.
 *
 * `root` is the repository's top level, for a caller that has resolved it
 * already - one git process fewer on a path that runs at every stop.
 */
export function sourceFingerprint(repo: string, excluded: string[] = [], root = repoRoot(repo)): FingerprintResult {
  if (!root) return { unverifiable: 'not inside a git repository' }

  for (const key of ['core.sparseCheckout', 'core.splitIndex']) {
    if (gitCapture(['config', '--bool', key], root) === 'true') {
      return { unverifiable: key + ' is on - a throwaway index would not describe the files on disk' }
    }
  }
  if ((gitCapture(['ls-files', '--unmerged'], root) ?? '') !== '') {
    return { unverifiable: 'the index has unresolved conflicts' }
  }

  const skip = new Set(excluded.map((p) => rootRelative(root, repo, p)).filter((p) => p !== null))
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], root, 60_000)
  if (untracked.exitCode !== 0) return { unverifiable: 'could not list untracked files: ' + untracked.stderr.trim() }
  const largeUntracked: LargeUntracked[] = []
  for (const path of untracked.stdout.split('\0').filter(Boolean)) {
    if (skip.has(path)) continue
    let stat
    try {
      stat = lstatSync(join(root, path))
    } catch {
      continue
    }
    if (stat.isFile() && stat.size > LARGE_UNTRACKED_BYTES) {
      largeUntracked.push({ path, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  largeUntracked.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const indexPath = gitCapture(['rev-parse', '--git-path', 'index'], root)
  // A path that does not exist yet, not an empty file: git rejects an empty
  // file as an index ("index file smaller than expected"), and a repository
  // with nothing added yet has no index to copy.
  const dir = mkdtempSync(join(tmpdir(), 'evidence-layer-index-'))
  const tmpIndex = join(dir, 'index')
  try {
    if (indexPath && existsSync(resolve(root, indexPath))) {
      const source = resolve(root, indexPath)
      copyFileSync(source, tmpIndex)
      // The copy keeps the index's own timestamp. git trusts an entry whose
      // stat data matches only when the entry is older than the index; one
      // from the index's own second is "racily clean" and its file is reread.
      // A copy stamped with the moment it was made is newer than every entry,
      // so a same-size edit made in that second - what an agent does when it
      // edits straight after a commit or a gather - read as no change, and the
      // seal called stale code fresh. Rounded down to the second: an earlier
      // stamp only marks more entries racy, which costs a reread, never a miss.
      const second = Math.floor(statSync(source).mtimeMs / 1000)
      utimesSync(tmpIndex, second, second)
    }
    const env = { GIT_INDEX_FILE: tmpIndex }
    const add = git(
      ['add', '-A', '--', '.', ...largeUntracked.map((f) => ':(exclude,literal)' + f.path)],
      root,
      120_000,
      env,
    )
    if (add.exitCode !== 0) return { unverifiable: 'git add into a throwaway index failed: ' + add.stderr.trim() }
    if (skip.size > 0) {
      const rm = git(['--literal-pathspecs', 'rm', '-q', '--cached', '--ignore-unmatch', '--', ...skip], root, 60_000, env)
      if (rm.exitCode !== 0) return { unverifiable: 'could not drop the excluded paths: ' + rm.stderr.trim() }
    }
    const tree = git(['write-tree'], root, 60_000, env)
    if (tree.exitCode !== 0) return { unverifiable: 'git write-tree failed: ' + tree.stderr.trim() }

    const partialBecause: string[] = []
    if (largeUntracked.length > 0) {
      partialBecause.push(
        largeUntracked.length + ' untracked file(s) over ' + LARGE_UNTRACKED_BYTES / 1024 / 1024 +
          ' MB compared by size and mtime only',
      )
    }
    // A submodule is covered as the commit its gitlink names; files changed
    // inside it are not, so a clean comparison cannot claim them.
    if (existsSync(join(root, '.gitmodules'))) partialBecause.push('submodule contents are not covered')
    return {
      fingerprint: {
        treeId: tree.stdout.trim(),
        largeUntracked,
        coverage: partialBecause.length > 0 ? 'partial' : 'complete',
        partialBecause,
      },
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Paths that differ between two fingerprints: a recursive tree diff (`-r`, or
 * git names only the top-level directory; `-z`, or non-ASCII paths come back
 * quoted) plus every large untracked file added, removed or re-stamped.
 * `null` when the old tree is gone from the object database.
 */
export function changedPaths(repo: string, before: SourceFingerprint, after: SourceFingerprint): string[] | null {
  const paths = new Set<string>()
  if (before.treeId !== after.treeId) {
    const diff = git(['diff-tree', '-r', '-z', '--name-only', before.treeId, after.treeId], repo)
    if (diff.exitCode !== 0) return null
    for (const p of diff.stdout.split('\0').filter(Boolean)) paths.add(p)
  }
  const key = (f: LargeUntracked) => f.path + '\0' + f.size + '\0' + f.mtimeMs
  const was = new Set(before.largeUntracked.map(key))
  const is = new Set(after.largeUntracked.map(key))
  for (const f of before.largeUntracked) if (!is.has(key(f))) paths.add(f.path)
  for (const f of after.largeUntracked) if (!was.has(key(f))) paths.add(f.path)
  return [...paths].sort()
}

/** Whether two fingerprints describe the same source - covered content and large-file metadata both. */
export function sameSource(a: SourceFingerprint, b: SourceFingerprint): boolean {
  return (
    a.treeId === b.treeId &&
    JSON.stringify(a.largeUntracked) === JSON.stringify(b.largeUntracked)
  )
}

// ---------------------------------------------------------------------------
// Canonical blocks

/**
 * The one serialisation both sides hash: the block's lines from opening fence
 * to closing fence, each trimmed, joined with `\n` (CRLF is gone already -
 * the document is split on `\r?\n`). Trimming means an editor stripping or
 * adding trailing spaces does not read as tampering, and it changes no fact
 * any rule reads.
 */
export function canonicalBlock(lines: string[], block: FencedBlock): string {
  return lines
    .slice(block.start, block.end + 1)
    .map((l) => l.trim())
    .join('\n')
}

// ---------------------------------------------------------------------------
// Runs

export interface SealedArtifact {
  command: string
  commit?: string
  exitCode: number
  stopped?: StopReason
  /** The full captured output, before the display trimmed its middle. */
  outputSha256: string
  /** `canonicalBlock` of the block as the gatherer wrote it. */
  blockSha256: string
}

export interface Seal {
  schemaVersion: 1
  runId: string
  headSha: string
  source: SourceFingerprint
  /** The paths the fingerprint left out, so a later comparison leaves out exactly the same. */
  excluded: string[]
  bundleSha256: string
  artifacts: Record<string, SealedArtifact>
  writtenAt: string
  /** The command that gathered this run, when the gatherer knew it - how the gate says "gather again". Since 0.10.0. */
  gatherCommand?: string
  /** The base ref it gathered against, as given. Since 0.10.0. */
  base?: string
}

export interface RunArtifact {
  id: string
  command: string
  commit?: string
  exitCode: number
  stopped?: StopReason
  output: string
}

export interface PublishInput {
  headSha: string
  source: SourceFingerprint
  excluded: string[]
  bundle: string
  artifacts: RunArtifact[]
  gatherCommand?: string
  base?: string
}

export interface Run {
  dir: string
  seal: Seal
  bundle: string
}

function writeAtomic(path: string, text: string): void {
  const tmp = path + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

function newRunId(): string {
  // Sortable by time, unique across two gathers in the same millisecond.
  return new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomBytes(3).toString('hex')
}

const RUN_ID_RE = /^[0-9TZ]+-[0-9a-f]{6}$/

/**
 * The seal for a bundle: every addressed block in it, hashed canonically.
 * Two different blocks under one short id make this throw, naming both
 * commands - a map entry silently replaced is an artifact silently lost.
 */
export function buildSeal(input: PublishInput, runId: string): Seal {
  const lines = input.bundle.split(/\r?\n/)
  const byId = new Map(input.artifacts.map((a) => [a.id, a]))
  const artifacts: Record<string, SealedArtifact> = {}
  for (const block of findArtifactBlocks(lines)) {
    if (!block.id) continue
    const blockSha256 = sha256(canonicalBlock(lines, block))
    const existing = artifacts[block.id]
    if (existing) {
      if (existing.blockSha256 === blockSha256) continue
      throw new Error(
        'two different artifacts share the id ' + block.id + ': `' + existing.command + '` and `' + block.command +
          '` - the short id collided; gather again',
      )
    }
    const source = byId.get(block.id)
    artifacts[block.id] = {
      command: block.command,
      ...(block.commit !== undefined && { commit: block.commit }),
      exitCode: block.exitCode,
      ...(block.stopped !== undefined && { stopped: block.stopped }),
      outputSha256: sha256(source ? source.output : block.output),
      blockSha256,
    }
  }
  return {
    schemaVersion: 1,
    runId,
    headSha: input.headSha,
    source: input.source,
    excluded: input.excluded,
    bundleSha256: sha256(input.bundle),
    artifacts,
    writtenAt: new Date().toISOString(),
    ...(input.gatherCommand !== undefined && { gatherCommand: input.gatherCommand }),
    ...(input.base !== undefined && { base: input.base }),
  }
}

/**
 * Writes a complete run and only then makes it current. Old runs beyond the
 * newest `RUNS_KEPT` are removed, never the one just published.
 */
export function publishRun(repo: string, input: PublishInput): Run {
  const state = stateDir(repo)
  if (!state) throw new Error('not inside a git repository - nowhere to keep a seal')
  const runId = newRunId()
  const seal = buildSeal(input, runId)
  const runs = join(state, 'runs')
  const dir = join(runs, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'bundle.md'), input.bundle, 'utf8')
  writeFileSync(join(dir, 'seal.json'), JSON.stringify(seal, null, 2) + '\n', 'utf8')
  writeAtomic(join(state, 'current.json'), JSON.stringify({ schemaVersion: 1, runId }) + '\n')

  const all = readdirSync(runs).filter((d) => RUN_ID_RE.test(d)).sort()
  for (const old of all.slice(0, Math.max(0, all.length - RUNS_KEPT))) {
    if (old !== runId) rmSync(join(runs, old), { recursive: true, force: true })
  }
  return { dir, seal, bundle: input.bundle }
}


/** Shape-checks a parsed seal. A cast is not a check: the file is on disk, and anything can be on disk. */
export function validateSeal(value: unknown): Seal | string {
  if (!isRecord(value)) return 'not an object'
  if (value.schemaVersion !== 1) return 'unknown schemaVersion ' + String(value.schemaVersion)
  if (typeof value.runId !== 'string' || !RUN_ID_RE.test(value.runId)) return 'bad runId'
  if (typeof value.headSha !== 'string') return 'bad headSha'
  if (typeof value.bundleSha256 !== 'string') return 'bad bundleSha256'
  if (!Array.isArray(value.excluded) || !value.excluded.every((p) => typeof p === 'string')) return 'bad excluded'
  const src = value.source
  if (!isRecord(src) || typeof src.treeId !== 'string' || !Array.isArray(src.largeUntracked)) return 'bad source'
  if (src.coverage !== 'complete' && src.coverage !== 'partial') return 'bad source.coverage'
  if (!isRecord(value.artifacts)) return 'bad artifacts'
  if (value.gatherCommand !== undefined && typeof value.gatherCommand !== 'string') return 'bad gatherCommand'
  if (value.base !== undefined && typeof value.base !== 'string') return 'bad base'
  for (const [id, a] of Object.entries(value.artifacts)) {
    if (!isRecord(a) || typeof a.blockSha256 !== 'string' || typeof a.command !== 'string') return 'bad artifact ' + id
  }
  return value as unknown as Seal
}

export type CurrentRun = { run: Run } | { none: string } | { broken: string }

/**
 * The run `current.json` names, read once and checked whole: the pointer, the
 * seal's shape, and the bundle against the seal's hash of it. `none` when
 * nothing was ever published; `broken` when something is there but does not
 * hold together - never a run anyone should trust. `state` is the checkout's
 * state directory, for a caller that has resolved it already.
 */
export function readCurrentRun(repo: string, state = stateDir(repo)): CurrentRun {
  if (!state) return { none: 'not inside a git repository' }
  const pointerPath = join(state, 'current.json')
  if (!existsSync(pointerPath)) return { none: 'no evidence has been gathered in this checkout' }
  let pointer: unknown
  try {
    pointer = JSON.parse(readFileSync(pointerPath, 'utf8'))
  } catch {
    return { broken: 'current.json is not valid JSON' }
  }
  if (!isRecord(pointer) || pointer.schemaVersion !== 1 || typeof pointer.runId !== 'string') {
    return { broken: 'current.json has an unknown shape' }
  }
  // Checked before it is joined onto a path: a run id is a directory name, and
  // `../../somewhere` is not one.
  if (!RUN_ID_RE.test(pointer.runId)) return { broken: 'current.json names an invalid run id' }
  const dir = join(state, 'runs', pointer.runId)
  let seal: Seal | string
  let bundle: string
  try {
    seal = validateSeal(JSON.parse(readFileSync(join(dir, 'seal.json'), 'utf8')))
    bundle = readFileSync(join(dir, 'bundle.md'), 'utf8')
  } catch (error) {
    return { broken: 'run ' + pointer.runId + ' cannot be read: ' + (error instanceof Error ? error.message : String(error)) }
  }
  if (typeof seal === 'string') return { broken: 'run ' + pointer.runId + ' has a malformed seal: ' + seal }
  if (seal.runId !== pointer.runId) return { broken: 'run ' + pointer.runId + ' carries the seal of ' + seal.runId }
  if (sha256(bundle) !== seal.bundleSha256) {
    return { broken: 'the bundle of run ' + pointer.runId + ' was edited after it was gathered' }
  }
  return { run: { dir, seal, bundle } }
}

// ---------------------------------------------------------------------------
// Checks

/**
 * Every addressed VERIFIED claim's block, held to the seal: the id must be one
 * the gatherer produced in this run, and each block carrying it must be
 * byte-for-byte (canonically) the one it wrote. Claims whose id resolves to no
 * block are left to `lintClaims`, which already reports them.
 */
export function checkProvenance(markdown: string, file: string, run: Run): CodedFinding[] {
  const lines = markdown.split(/\r?\n/)
  const blocks = findArtifactBlocks(lines)
  const findings: CodedFinding[] = []
  const seen = new Set<string>()
  for (const claim of findClaims(lines, fencedLineNumbers(lines))) {
    const id = claim.gradeId
    if (!id || seen.has(id)) continue
    seen.add(id)
    const cited = blocks.filter((b) => b.id === id)
    if (cited.length === 0) continue
    const where = { file, line: claim.line + 1 }
    const sealed = run.seal.artifacts[id]
    if (!sealed) {
      findings.push({
        level: 'error',
        code: 'seal/not-gathered',
        claim: 'artifact ' + id + ' came from the gatherer',
        detail: notGatheredDetail(run, id, cited[0]!.command),
        fix: notGatheredFix(run, cited[0]!.command),
        ...where,
      })
      continue
    }
    const edited = cited.find((b) => sha256(canonicalBlock(lines, b)) !== sealed.blockSha256)
    findings.push(
      edited
        ? {
            level: 'error',
            code: 'seal/edited',
            claim: 'artifact ' + id + ' came from the gatherer',
            detail:
              'the block at line ' + (edited.start + 1) + ' differs from the one run ' + run.seal.runId +
              ' wrote - it was edited after it was gathered. Copy it from the bundle again',
            fix: 'copy the ' + id + ' block from the evidence bundle again, unedited - or mark the claims citing it UNVERIFIED',
            ...where,
          }
        : {
            level: 'pass',
            code: 'seal/provenance',
            claim: 'artifact ' + id + ' came from the gatherer',
            detail: 'identical to the block run ' + run.seal.runId + ' wrote',
            ...where,
          },
    )
  }
  return findings
}

/**
 * Whether the source is still the source the run was gathered from. Content,
 * not commits: committing unchanged content does not make evidence stale, and
 * editing a file without committing does.
 *
 * `error` when covered content changed, naming the paths; `unverifiable` when
 * it did not but part of the surface was only compared by metadata, or the
 * comparison could not be made; `pass` otherwise - and the pass says exactly
 * what it covers.
 *
 * `now` is today's fingerprint, taken with the run's own exclusions, for a
 * caller that checks several texts against one run: the tree is the same for
 * all of them, and fingerprinting it is the expensive part.
 */
export function checkFreshness(repo: string, run: Run, now = sourceFingerprint(repo, run.seal.excluded)): CodedFinding {
  const claim = 'the code is what run ' + run.seal.runId + ' was gathered from'
  if ('unverifiable' in now) return { level: 'unverifiable', code: 'seal/unhashable', claim, detail: now.unverifiable }
  const current = now.fingerprint
  if (!sameSource(run.seal.source, current)) {
    const paths = changedPaths(repo, run.seal.source, current)
    return {
      level: 'error',
      code: 'seal/stale',
      claim,
      detail:
        'the code changed after the evidence was gathered' +
        (paths && paths.length > 0 ? ' (' + summarisePaths(paths) + ')' : '') +
        ' - gather again before citing it',
      fix: 'gather the evidence again, then cite the runs the new bundle lists',
      expected: run.seal.source.treeId,
      observed: current.treeId,
    }
  }
  if (current.coverage === 'partial') {
    return {
      level: 'unverifiable',
      code: 'seal/partial-coverage',
      claim,
      detail: 'the hashed content matches, but ' + current.partialBecause.join('; ') + ' - that part cannot be shown unchanged',
    }
  }
  return {
    level: 'pass',
    code: 'seal/fresh',
    claim,
    detail: 'every tracked and non-ignored file has the content it had when the run was gathered (not ignored files, dependencies or the environment)',
  }
}

/**
 * Why a cited id is not in the current run, as specifically as the kept runs
 * allow: the earlier gather that produced it, when one is still kept, and the
 * id the current run gave the same command - the citation an author is about
 * to go looking for.
 */
function notGatheredDetail(run: Run, id: string, command: string): string {
  const keptIn = keptRunWith(run, id)
  const sameCommand = Object.entries(run.seal.artifacts).find(([, a]) => a.command === command)?.[0]
  return (
    'run ' + run.seal.runId + ' produced no artifact ' + id + ' - ' +
    (keptIn
      ? 'it came from run ' + keptIn + ', an earlier gather'
      : 'the block was written by hand, or copied from a run that is no longer kept') +
    (sameCommand
      ? '. The current run\'s `' + command + '` block is ' + sameCommand + ' - cite that one, copied from the current bundle'
      : '. Cite a block from the current bundle')
  )
}

/** What to cite instead of a block the current run did not produce. */
function notGatheredFix(run: Run, command: string): string {
  const sameCommand = Object.entries(run.seal.artifacts).find(([, a]) => a.command === command)?.[0]
  return sameCommand
    ? 'cite ' + sameCommand + ' instead, with its block copied from the current evidence bundle unedited - or mark the claim UNVERIFIED'
    : 'cite a block from the current evidence bundle, copied unedited - or mark the claim UNVERIFIED'
}

/** The newest kept run, other than `run`, whose seal lists `id` - or `undefined`. A seal that does not read is skipped. */
function keptRunWith(run: Run, id: string): string | undefined {
  const runs = dirname(run.dir)
  let names: string[]
  try {
    names = readdirSync(runs).filter((d) => RUN_ID_RE.test(d) && d !== run.seal.runId).sort().reverse()
  } catch {
    return undefined
  }
  for (const name of names) {
    try {
      const seal = validateSeal(JSON.parse(readFileSync(join(runs, name, 'seal.json'), 'utf8')))
      if (typeof seal !== 'string' && seal.artifacts[id]) return name
    } catch {
      // A kept run that cannot be read names nothing; the finding stays an error either way.
    }
  }
  return undefined
}

function summarisePaths(paths: string[]): string {
  return paths.length <= 5 ? paths.join(', ') : paths.slice(0, 5).join(', ') + ' and ' + (paths.length - 5) + ' more'
}

/** Whether a sealed artifact is one whose success a stale tree undermines: lint, types, tests. */
export function freshnessMatters(command: string): boolean {
  const kind = classifyCommand(command)
  return kind === 'lint' || kind === 'types' || kind === 'tests'
}
