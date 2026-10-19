import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { artifactId, formatArtifact } from '../src/core/artifact'
import { gatherEvidence } from '../src/core/gather'
import {
  LARGE_UNTRACKED_BYTES,
  RUNS_KEPT,
  buildSeal,
  changedPaths,
  checkFreshness,
  checkProvenance,
  publishRun,
  readCurrentRun,
  sourceFingerprint,
  stateDir,
  toRootRelative,
} from '../src/core/seal'
import type { SourceFingerprint } from '../src/core/seal'
import { sh } from './helpers/git'

function repo(files: Record<string, string> = { 'src/a.js': 'a\n' }, commit = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'el-seal-'))
  sh(dir, 'init', '-q')
  sh(dir, 'config', 'user.email', 't@t')
  sh(dir, 'config', 'user.name', 't')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  if (commit) {
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-qm', 'init')
  }
  return dir
}

function fp(dir: string, excluded: string[] = ['review.md']): SourceFingerprint {
  const result = sourceFingerprint(dir, excluded)
  if ('unverifiable' in result) throw new Error(result.unverifiable)
  return result.fingerprint
}

const block = (output: string, commit = 'f8ae76a', command = 'pnpm test') => {
  const id = artifactId(command, commit, output)
  return { id, text: formatArtifact(command, output, 0, { id, commit }) }
}

function publish(dir: string, blocks: { id: string; text: string }[], excluded = ['review.md']) {
  const bundle = '# Evidence bundle\n\n' + blocks.map((b) => b.text).join('\n\n') + '\n'
  return publishRun(dir, { headSha: sh(dir, 'rev-parse', 'HEAD'), source: fp(dir, excluded), excluded, bundle, artifacts: [] })
}

const review = (b: { id: string; text: string }) => '**Claim**: the suite passes.\n**Grounding**: VERIFIED[' + b.id + ']\n\n' + b.text

describe('sourceFingerprint', () => {
  it('ignores the review being written, and a commit of unchanged content - but not an edit to code', () => {
    const dir = repo()
    const gathered = fp(dir).treeId

    writeFileSync(join(dir, 'review.md'), '# review\n')
    expect(fp(dir).treeId).toBe(gathered)

    writeFileSync(join(dir, 'src/b.js'), 'b\n')
    const withB = fp(dir).treeId
    expect(withB).not.toBe(gathered)
    sh(dir, 'add', 'src/b.js')
    sh(dir, 'commit', '-qm', 'b')
    expect(fp(dir).treeId).toBe(withB)

    writeFileSync(join(dir, 'src/a.js'), 'changed\n')
    expect(fp(dir).treeId).not.toBe(withB)
  })

  it('never touches the real index', () => {
    const dir = repo()
    writeFileSync(join(dir, 'src/new.js'), 'n\n')
    const before = readFileSync(join(dir, '.git', 'index'))
    fp(dir)
    expect(readFileSync(join(dir, '.git', 'index')).equals(before)).toBe(true)
    expect(sh(dir, 'status', '--porcelain')).toContain('?? src/new.js')
  })

  it('works in a repository with no commits and no index file yet', () => {
    const dir = repo({ 'a.js': 'a\n' }, false)
    expect(existsSync(join(dir, '.git', 'index'))).toBe(false)
    expect(fp(dir).treeId).toMatch(/^[0-9a-f]{40}$/)
    expect(existsSync(join(dir, '.git', 'index'))).toBe(false)
  })

  it('records a large untracked file by metadata and calls the coverage partial', () => {
    const dir = repo()
    writeFileSync(join(dir, 'dump.bin'), '')
    truncateSync(join(dir, 'dump.bin'), LARGE_UNTRACKED_BYTES + 1)
    const result = fp(dir)
    expect(result.largeUntracked.map((f) => f.path)).toEqual(['dump.bin'])
    expect(result.coverage).toBe('partial')
    expect(sh(dir, 'cat-file', '-p', result.treeId + ':')).not.toContain('dump.bin')
  })

  it('is unverifiable in a sparse checkout rather than guessing', () => {
    const dir = repo()
    sh(dir, 'config', 'core.sparseCheckout', 'true')
    expect(sourceFingerprint(dir)).toEqual({ unverifiable: expect.stringContaining('core.sparseCheckout') })
  })

  it('keeps its state per worktree, where git puts it', () => {
    const dir = repo()
    const wt = dir + '-wt'
    sh(dir, 'worktree', 'add', '-q', wt)
    expect(readFileSync(join(wt, '.git'), 'utf8')).toMatch(/^gitdir: /)
    expect(stateDir(wt)).toBe(join(dir, '.git', 'worktrees', wt.split('/').at(-1)!, 'evidence-layer'))
    expect(fp(wt).treeId).toBe(fp(dir).treeId)
  })
})

describe('sourceFingerprint moves for every change git can see, and names it', () => {
  // DEC-0005: editing any non-ignored file always moves the fingerprint. An
  // edit is one kind of change; these are the others a working tree has.
  const cases: [string, (dir: string) => void, string[]][] = [
    ['a deleted tracked file', (dir) => rmSync(join(dir, 'src/a.js')), ['src/a.js']],
    ['a renamed file - as its old path and its new one', (dir) => renameSync(join(dir, 'src/a.js'), join(dir, 'src/b.js')), ['src/a.js', 'src/b.js']],
    ['a deleted directory, every file in it', (dir) => rmSync(join(dir, 'src'), { recursive: true }), ['src/a.js', 'src/nested/c.js']],
    ['a deleted untracked file', (dir) => rmSync(join(dir, 'notes.txt')), ['notes.txt']],
    ['a symbolic link pointed elsewhere', (dir) => (rmSync(join(dir, 'link')), symlinkSync('src/nested/c.js', join(dir, 'link'))), ['link']],
  ]
  if (process.platform !== 'win32') {
    // Git records only the executable bit, and only where `core.fileMode` is
    // on - the default on POSIX; Windows has no bit to record, so no change.
    cases.push(['a file made executable', (dir) => chmodSync(join(dir, 'src/a.js'), 0o755), ['src/a.js']])
  }

  for (const [what, change, named] of cases) {
    it(what, () => {
      const dir = repo({ 'src/a.js': 'a\n', 'src/nested/c.js': 'c\n' })
      symlinkSync('src/a.js', join(dir, 'link'))
      writeFileSync(join(dir, 'notes.txt'), 'untracked, not ignored\n')
      const before = fp(dir)
      change(dir)
      const after = fp(dir)
      expect(after.treeId).not.toBe(before.treeId)
      expect(changedPaths(dir, before, after)).toEqual(named)
    })
  }

  it('comes back to the same id when the change is undone, and does not move for an ignored file', () => {
    const dir = repo({ 'src/a.js': 'a\n', '.gitignore': 'build/\n' })
    const before = fp(dir).treeId
    renameSync(join(dir, 'src/a.js'), join(dir, 'src/b.js'))
    renameSync(join(dir, 'src/b.js'), join(dir, 'src/a.js'))
    expect(fp(dir).treeId).toBe(before)
    mkdirSync(join(dir, 'build'))
    writeFileSync(join(dir, 'build/out.js'), 'generated\n')
    expect(fp(dir).treeId).toBe(before)
  })

  it('makes a sealed run stale for a rename, naming both paths', () => {
    const dir = repo({ 'src/a.js': 'a\n' })
    const b = block('Tests 1 passed (1)')
    publish(dir, [b])
    renameSync(join(dir, 'src/a.js'), join(dir, 'src/renamed.js'))
    const current = readCurrentRun(dir)
    const finding = 'run' in current ? checkFreshness(dir, current.run) : null
    expect(finding).toMatchObject({ level: 'error', code: 'seal/stale' })
    expect(finding!.detail).toContain('src/a.js')
    expect(finding!.detail).toContain('src/renamed.js')
  })
})

describe('changedPaths', () => {
  it('names nested files in full, non-ASCII paths unquoted, and large untracked files', () => {
    const dir = repo({ 'src/core/a.ts': 'a\n', 'docs/ü.md': 'u\n' })
    const before = fp(dir)
    writeFileSync(join(dir, 'src/core/a.ts'), 'changed\n')
    writeFileSync(join(dir, 'docs/ü.md'), 'changed\n')
    writeFileSync(join(dir, 'big.log'), '')
    truncateSync(join(dir, 'big.log'), LARGE_UNTRACKED_BYTES + 1)
    expect(changedPaths(dir, before, fp(dir))).toEqual(['big.log', 'docs/ü.md', 'src/core/a.ts'])
  })
})

describe('runs', () => {
  it('publishes a run and reads back the same seal and bundle', () => {
    const dir = repo()
    const b = block('ok')
    const run = publish(dir, [b])
    const current = readCurrentRun(dir)
    expect('run' in current && current.run.seal.runId).toBe(run.seal.runId)
    expect(Object.keys(run.seal.artifacts)).toEqual([b.id])
  })

  it('says nothing was gathered rather than pretending, and refuses an edited bundle', () => {
    const dir = repo()
    expect(readCurrentRun(dir)).toEqual({ none: expect.stringContaining('no evidence') })
    const run = publish(dir, [block('ok')])
    writeFileSync(join(run.dir, 'bundle.md'), run.bundle + 'tampered\n')
    expect(readCurrentRun(dir)).toEqual({ broken: expect.stringContaining('edited after it was gathered') })
  })

  it('refuses a pointer that tries to leave the runs directory', () => {
    const dir = repo()
    publish(dir, [block('ok')])
    writeFileSync(join(stateDir(dir)!, 'current.json'), JSON.stringify({ schemaVersion: 1, runId: '../../x' }))
    expect(readCurrentRun(dir)).toEqual({ broken: 'current.json names an invalid run id' })
  })

  it('refuses a seal of the wrong shape', () => {
    const dir = repo()
    const run = publish(dir, [block('ok')])
    writeFileSync(join(run.dir, 'seal.json'), JSON.stringify({ schemaVersion: 2 }))
    expect(readCurrentRun(dir)).toEqual({ broken: expect.stringContaining('malformed seal') })
  })

  it('keeps the newest runs and the current one, and the last to finish is current', () => {
    const dir = repo()
    let last
    for (let i = 0; i < RUNS_KEPT + 2; i++) last = publish(dir, [block('ok ' + i)])
    const runs = readdirSync(join(stateDir(dir)!, 'runs'))
    expect(runs).toHaveLength(RUNS_KEPT)
    const current = readCurrentRun(dir)
    expect('run' in current && current.run.seal.runId).toBe(last!.seal.runId)
  })

  it('refuses two different artifacts under one short id instead of losing one', () => {
    const dir = repo()
    const a = block('one')
    const forged = a.text.replace('one', 'two')
    expect(() =>
      buildSeal({ headSha: 'x', source: fp(dir), excluded: [], bundle: a.text + '\n\n' + forged, artifacts: [] }, '20261018T000000000Z-000000'),
    ).toThrow(/share the id/)
  })
})

describe('checkProvenance', () => {
  it('passes a block the gatherer wrote, including one with empty output', () => {
    const dir = repo()
    const b = block('ok')
    const empty = block('', 'f8ae76a', 'git status --porcelain=v1 --untracked-files=all')
    const run = publish(dir, [b, empty])
    const md = review(b) + '\n\n**Claim**: the tree is clean.\n**Grounding**: VERIFIED[' + empty.id + ']\n\n' + empty.text
    expect(checkProvenance(md, 'review.md', run).map((f) => f.level)).toEqual(['pass', 'pass'])
  })

  it('fails a block edited after it was gathered', () => {
    const dir = repo()
    const b = block('Tests 3 passed (3)')
    const run = publish(dir, [b])
    const found = checkProvenance(review(b).replace('3 passed (3)', '4 passed (4)'), 'review.md', run)
    expect(found[0]!.level).toBe('error')
    expect(found[0]!.detail).toContain('edited after it was gathered')
  })

  it('fails a block the gatherer never produced in this run', () => {
    const dir = repo()
    const run = publish(dir, [block('ok')])
    const found = checkProvenance(review(block('handwritten')), 'review.md', run)
    expect(found[0]!.detail).toContain('produced no artifact')
  })

  it('does not count trailing spaces, or CRLF line endings, as an edit', () => {
    const dir = repo()
    const b = block('ok')
    const run = publish(dir, [b])
    const reformatted = review({ ...b, text: b.text.split('\n').map((l) => l + '  ').join('\r\n') })
    expect(checkProvenance(reformatted, 'review.md', run)[0]!.level).toBe('pass')
  })
})

describe('checkFreshness', () => {
  it('passes until the code changes, and names what changed', () => {
    const dir = repo()
    const run = publish(dir, [block('ok')])
    writeFileSync(join(dir, 'review.md'), 'written after gathering\n')
    expect(checkFreshness(dir, run).level).toBe('pass')

    writeFileSync(join(dir, 'src/a.js'), 'edited after the tests ran\n')
    const stale = checkFreshness(dir, run)
    expect(stale.level).toBe('error')
    expect(stale.detail).toContain('src/a.js')
  })

  it('stays fresh across a commit that records content which did not change', () => {
    const dir = repo()
    writeFileSync(join(dir, 'src/b.js'), 'b\n')
    const run = publish(dir, [block('ok')])
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-qm', 'b')
    expect(checkFreshness(dir, run).level).toBe('pass')
  })

  it('is unverifiable, not a pass, when part of the source is only compared by metadata', () => {
    const dir = repo()
    writeFileSync(join(dir, 'dump.bin'), '')
    truncateSync(join(dir, 'dump.bin'), LARGE_UNTRACKED_BYTES + 1)
    const run = publish(dir, [block('ok')])
    expect(checkFreshness(dir, run).level).toBe('unverifiable')
    // Same size, new mtime: the metadata moved, so this is a change, not a gap.
    utimesSync(join(dir, 'dump.bin'), new Date(), new Date(Date.now() + 60_000))
    expect(checkFreshness(dir, run).level).toBe('error')
  })
})

describe('gatherEvidence publishes a sealed run', () => {
  const skipAll = ['typecheck', 'lockfile', 'test']

  it('seals a gather whose steps left the tree alone, leaving out the bundle and the review', async () => {
    const dir = repo()
    const out = join(dir, 'evidence.local.md')
    const result = await gatherEvidence({
      repo: dir,
      base: 'HEAD',
      out,
      skip: skipAll,
      plan: { lintCommand: () => 'node -e "process.stdout.write(\'lint ok\')"' },
    })
    expect(result.sealed).toBe(true)
    expect(result.treeChanged).toEqual([])
    const current = readCurrentRun(dir)
    expect('run' in current && current.run.seal.runId).toBe(result.runId)
    expect('run' in current && current.run.seal.excluded).toEqual(toRootRelative(dir, [out, join(dir, 'review.md')], dir))
    expect('run' in current && current.run.bundle).toBe(readFileSync(out, 'utf8'))
  })

  it('does not seal a gather whose step wrote into the tree, and says which step and which file', async () => {
    const dir = repo()
    const out = join(dir, 'evidence.local.md')
    const result = await gatherEvidence({
      repo: dir,
      base: 'HEAD',
      out,
      skip: skipAll,
      plan: { lintCommand: () => 'node -e "require(\'fs\').writeFileSync(\'src/generated.js\', \'x\')"' },
    })
    expect(result.sealed).toBe(false)
    expect(result.treeChanged).toEqual(['src/generated.js'])
    expect(readFileSync(out, 'utf8')).toContain('- during lint: `src/generated.js`')
    expect(readCurrentRun(dir)).toEqual({ none: expect.any(String) })
  })

  it('leaves the previous run current when a later gather is not sealed', async () => {
    const dir = repo()
    const out = join(dir, 'evidence.local.md')
    const good = await gatherEvidence({ repo: dir, base: 'HEAD', out, skip: [...skipAll, 'lint'] })
    await gatherEvidence({
      repo: dir,
      base: 'HEAD',
      out,
      skip: skipAll,
      plan: { lintCommand: () => 'node -e "require(\'fs\').writeFileSync(\'src/generated.js\', \'x\')"' },
    })
    const current = readCurrentRun(dir)
    expect('run' in current && current.run.seal.runId).toBe(good.runId)
    rmSync(join(dir, 'src/generated.js'))
  })
})

describe('checkProvenance - a block from an earlier gather', () => {
  it('names the kept run it came from and the current id for the same command', () => {
    const dir = repo()
    const old = block('Tests 3 passed (3)')
    const kept = publish(dir, [old])
    const now = block('Tests 4 passed (4)')
    const run = publish(dir, [now])
    const found = checkProvenance(review(old), 'review.md', run)
    expect(found[0]).toMatchObject({ level: 'error', code: 'seal/not-gathered' })
    expect(found[0]!.detail).toContain('run ' + kept.seal.runId)
    expect(found[0]!.detail).toContain(now.id)
  })

  it('still says "by hand" when no kept run produced the block', () => {
    const dir = repo()
    const run = publish(dir, [block('ok')])
    const found = checkProvenance(review(block('handwritten', 'f8ae76a', 'pnpm lint')), 'review.md', run)
    expect(found[0]!.detail).toContain('written by hand')
    expect(found[0]!.detail).not.toContain('current run\'s')
  })
})

describe('gatherEvidence - what it calls the change', () => {
  const skipAll = ['typecheck', 'lockfile', 'test']

  it('counts uncommitted and untracked changes in the plan and the diff block, but not the review or the bundle', async () => {
    const dir = repo({ 'src/a.js': 'a\n', 'src/c.js': 'c\n' })
    writeFileSync(join(dir, 'src/a.js'), 'edited\n')
    writeFileSync(join(dir, 'src/new.js'), 'new\n')
    writeFileSync(join(dir, 'review.md'), '# review\n')
    const out = join(dir, 'evidence.local.md')
    let planned: string[] = []
    const result = await gatherEvidence({
      repo: dir,
      base: 'HEAD',
      out,
      skip: skipAll,
      plan: { lintCommand: (files) => ((planned = files), 'node -e "process.stdout.write(\'lint ok\')"') },
    })
    expect(result.changedFiles).toEqual(['src/a.js', 'src/new.js'])
    expect(planned).toEqual(['src/a.js', 'src/new.js'])
    const bundle = readFileSync(out, 'utf8')
    expect(bundle).toContain('- Files in diff: 2')
    const diff = /## diff\n\n```artifact:[^\n]*\n\$ ([^\n]*)\n([\s\S]*?)```/.exec(bundle)!
    expect(diff[2]).toContain('src/a.js')
    expect(diff[2]).toContain('src/new.js')
    expect(diff[2]).not.toContain('review.md')
  })

  it('names the configured gather command, and prints each artifact block once', async () => {
    const dir = repo({ 'src/a.js': 'a\n', 'package.json': JSON.stringify({ scripts: { evidence: 'node gather.js' } }) })
    const out = join(dir, 'evidence.local.md')
    // Two steps running one command - this repository's own lint and typecheck
    // - give one artifact, which is still printed only once.
    const check = () => 'node -e "process.stdout.write(\'checked\')"'
    const result = await gatherEvidence({
      repo: dir,
      base: 'HEAD',
      out,
      skip: ['lockfile', 'test'],
      plan: { lintCommand: check, typecheckCommand: check },
    })
    const bundle = readFileSync(out, 'utf8')
    expect(bundle).toContain('Generated by `npm run evidence`.')
    const current = readCurrentRun(dir)
    const ids = 'run' in current ? Object.keys(current.run.seal.artifacts) : []
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) expect(bundle.split('```artifact:' + id).length - 1, id).toBe(1)
    expect(result.sealed).toBe(true)

    await gatherEvidence({ repo: dir, base: 'HEAD', out, skip: [...skipAll, 'lint'], gatherCommand: 'make evidence' })
    expect(readFileSync(out, 'utf8')).toContain('Generated by `make evidence`.')
  })
})
