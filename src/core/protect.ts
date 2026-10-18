/**
 * The pre-write half of the runtime gate: is a file-write tool aimed at the
 * gate's own ledger?
 *
 * Kept apart from `gate.ts` because it runs before *every* file the agent
 * writes, so it must not pay to load claims, receipts and seals to answer a
 * question about one path. Plain file reads only - no git process: `.git` is
 * found by walking up from the agent's working directory (which follows its
 * `cd`, so in a monorepo it is often a package, not the root), and a
 * worktree's `.git` file is followed to the directory it names.
 *
 * An accidental-write guard, not a sandbox. A shell command can still write
 * into the ledger, and a race between the check and the write is not closed.
 * What it stops is the default move - an agent "fixing" a failing check by
 * editing the evidence instead of the code.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Finding } from './cli'
import { gateFailure, journalOutcome } from './gate-decision'
import type { GateDecision, GateEvent, GateOptions } from './gate-decision'
import { appendEntry } from './journal'
import { gitCapture } from './proc'

/** The nearest `.git` above a directory, as the git directory it names - following `gitdir:` in a worktree. */
function findGitDir(start: string): string | null {
  let dir = resolve(start)
  for (;;) {
    const dotGit = join(dir, '.git')
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dotGit
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
      return pointer ? resolve(dir, pointer) : null
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** A path with every symlink in its existing part resolved, and the part that does not exist yet reattached. */
function realish(path: string): string {
  let existing = resolve(path)
  const rest: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    rest.unshift(basename(existing))
    existing = parent
  }
  let real = existing
  try {
    real = realpathSync.native(existing)
  } catch {
    // Unreadable: compare the path as given rather than failing the write check.
  }
  return join(real, ...rest)
}

const within = (path: string, dir: string) => {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

/**
 * Every place the gate keeps state for the repository around `cwd`: the
 * common git directory's `evidence-layer/`, and each worktree's under
 * `worktrees/<name>/`. Found with plain file reads - no git process - because
 * this runs before every file write the agent makes.
 */
export function protectedRoots(cwd: string): { common: string } | null {
  const gitDir = findGitDir(cwd)
  if (!gitDir) return null
  let common = gitDir
  const commondir = join(gitDir, 'commondir')
  if (existsSync(commondir)) common = resolve(gitDir, readFileSync(commondir, 'utf8').trim())
  return { common: realish(common) }
}

export function isProtected(cwd: string, path: string): boolean {
  const roots = protectedRoots(cwd)
  if (!roots) return false
  const target = realish(isAbsolute(path) ? path : resolve(cwd, path))
  if (!within(target, roots.common)) return false
  const rel = relative(roots.common, target).split(sep)
  return rel[0] === 'evidence-layer' || (rel[0] === 'worktrees' && rel[2] === 'evidence-layer')
}

/** Decides one pre-write event. Never throws. */
export function decidePreWrite(event: Extract<GateEvent, { kind: 'pre-write' }>, opts: GateOptions = {}): GateDecision {
  try {
    const hit = event.paths.find((p) => isProtected(event.cwd, p))
    if (!hit) return { action: 'allow', outcome: 'not-applicable', level: null, findings: [] }
    const finding: Finding = {
      level: 'error',
      claim: 'the evidence ledger is written only by the gatherer',
      detail: hit + ' is evidence-layer state - gather again instead of editing it',
    }
    const decision: GateDecision = {
      action: 'deny',
      reason:
        hit + " is evidence-layer's ledger of gathered evidence. Run the project's evidence script to change it; " +
        'editing it by hand would make every check that reads it meaningless.',
      outcome: 'checked',
      level: 'error',
      findings: [finding],
    }
    if (opts.journal !== false) journalDeny(event.cwd, finding)
    return decision
  } catch (error) {
    return gateFailure('pre-write', error, opts)
  }
}

function journalDeny(cwd: string, finding: Finding): void {
  try {
    const gitDir = findGitDir(cwd)
    if (!gitDir) return
    const state = join(gitDir, 'evidence-layer')
    mkdirSync(state, { recursive: true })
    appendEntry(join(state, 'journal.jsonl'), {
      check: 'gate:pre-write',
      commit: gitCapture(['rev-parse', 'HEAD'], cwd) ?? 'unborn',
      outcome: journalOutcome('checked', 'error')!,
      findings: [finding.claim + ': ' + finding.detail],
      gate: { event: 'pre-write', outcome: 'checked', action: 'deny', reviews: [], elapsedMs: 0 },
    })
  } catch {
    // Never let the journal turn a decision into a failure.
  }
}
