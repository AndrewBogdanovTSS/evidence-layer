import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { artifactId, formatArtifact } from '../src/core/artifact'
import { decide, isProtected, journalOutcome, levelOf } from '../src/core/gate'
import type { GateDecision, GateOptions } from '../src/core/gate'
import { readJournal, summariseGate } from '../src/core/journal'
import { publishRun, sourceFingerprint, stateDir } from '../src/core/seal'
import { sh } from './helpers/git'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'el-gate-'))
  sh(dir, 'init', '-q')
  sh(dir, 'config', 'user.email', 't@t')
  sh(dir, 'config', 'user.name', 't')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.js'), 'a\n')
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-qm', 'init')
  return dir
}

const start = (cwd: string, sessionId = 's1', opts: GateOptions = {}) =>
  decide({ kind: 'session-start', cwd, sessionId, source: 'startup' }, opts)
const stop = (cwd: string, opts: GateOptions = {}, extra: { message?: string; reentry?: boolean; sessionId?: string } = {}) =>
  decide({ kind: 'stop', cwd, sessionId: extra.sessionId ?? 's1', reentry: extra.reentry ?? false, message: extra.message }, opts)

const UNBACKED = '# Review\n\n**Claim**: the suite passes.\n'
const HONEST = '# Review\n\n**Claim**: whether the suite passes.\n**Grounding**: UNVERIFIED\n'

const TESTS_OUTPUT = 'ok\n[SUMMARY tests: passed=3 failed=0 skipped=0 todo=0]'

/** Gathers a sealed run holding one test artifact, the way gatherEvidence would. */
function sealTests(dir: string): { id: string; block: string } {
  const head = sh(dir, 'rev-parse', 'HEAD')
  const id = artifactId('pnpm test', head, TESTS_OUTPUT)
  const block = formatArtifact('pnpm test', TESTS_OUTPUT, 0, { id, commit: head })
  const fp = sourceFingerprint(dir, ['review.md', 'evidence.local.md'])
  if ('unverifiable' in fp) throw new Error(fp.unverifiable)
  publishRun(dir, {
    headSha: head,
    source: fp.fingerprint,
    excluded: ['evidence.local.md', 'review.md'],
    bundle: '# Evidence bundle\n\n' + block + '\n',
    artifacts: [{ id, command: 'pnpm test', exitCode: 0, output: TESTS_OUTPUT }],
  })
  return { id, block }
}

const backedReview = (b: { id: string; block: string }) =>
  '# Review\n\n**Claim**: the suite ran 3 passing tests.\n**Grounding**: VERIFIED[' + b.id + ': exit=0, passed>=3]\n\n' + b.block + '\n'

const gateJournal = (dir: string) => readJournal(join(stateDir(dir)!, 'journal.jsonl'))

describe('session-start', () => {
  it('hands the agent the claim grammar and says whether evidence is sealed', () => {
    const decision = start(repo())
    expect(decision.action).toBe('context')
    if (decision.action === 'context') {
      expect(decision.text).toContain('**Claim**')
      expect(decision.text).toContain('No sealed evidence run')
    }
  })

  it('shows the grammar as a filled-in example, and lists the claims a run for this commit backs', () => {
    const dir = repo()
    const none = start(dir, 'before')
    // No run yet: the example is said to be one, so it is not copied as a real id.
    expect(none.action === 'context' && none.text).toContain('the one above is only an example')
    expect(none.action === 'context' && none.text).not.toContain('<artifact id>')

    const sealed = sealTests(dir)
    const ready = start(dir, 'after')
    expect(ready.action).toBe('context')
    if (ready.action !== 'context') return
    const pair = '**Claim**: The test suite ran 3 passing tests and reports no failures.\n**Grounding**: VERIFIED[' + sealed.id + ': exit=0, passed>=3, failed=0]'
    expect(ready.text).toContain('Ready claims from run')
    expect(ready.text).toContain(pair)
    expect(ready.text).not.toContain('only an example')

    // And a pair pasted as it is passes the stop.
    expect(stop(dir, {}, { sessionId: 'after', message: pair })).toMatchObject({ action: 'allow', level: 'pass' })
  })

  it('outside a git repository, stays out of the way', () => {
    expect(start(mkdtempSync(join(tmpdir(), 'el-nogit-'))).outcome).toBe('not-applicable')
  })
})

describe('stop - which reviews it checks', () => {
  it('checks nothing when this session changed no review and made no claims', () => {
    const dir = repo()
    start(dir)
    expect(stop(dir, {}, { message: 'All done, see the diff.' }).outcome).toBe('not-applicable')
  })

  it('does not check a review left modified before the session started', () => {
    const dir = repo()
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    start(dir)
    expect(stop(dir).outcome).toBe('not-applicable')
  })

  it('keeps the session snapshot across a resume, so a review written before it still counts', () => {
    const dir = repo()
    start(dir)
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    decide({ kind: 'session-start', cwd: dir, sessionId: 's1', source: 'resume' })
    expect(stop(dir).action).toBe('block')
  })

  it('without a snapshot, says it did not check rather than passing', () => {
    const dir = repo()
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    const decision = stop(dir)
    expect(decision.outcome).toBe('no-snapshot')
    expect(decision.level).toBe('unverifiable')
    expect(decision.action).toBe('allow')
  })

  it('finds the repository from a subdirectory the agent cd-ed into', () => {
    const dir = repo()
    start(join(dir, 'src'))
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    expect(stop(join(dir, 'src')).action).toBe('block')
  })
})

describe('stop - retry episodes', () => {
  it('blocks twice, then lets the agent through with the errors still attached', () => {
    const dir = repo()
    start(dir)
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    expect(stop(dir, {}, { reentry: false }).action).toBe('block')
    // The host's reentry flag is true from the second stop on; it must not be
    // what ends the episode while the session file can count.
    expect(stop(dir, {}, { reentry: true }).action).toBe('block')
    const third = stop(dir, {}, { reentry: true })
    expect(third.action).toBe('allow')
    expect(third.outcome).toBe('retry-exhausted')
    expect(third.level).toBe('error')
    // Editing the text without fixing it does not hand out fresh blocks.
    writeFileSync(join(dir, 'review.md'), UNBACKED + '\nmore words\n')
    expect(stop(dir, {}, { reentry: true }).outcome).toBe('retry-exhausted')
  })

  it('closes the episode on a clean check, so a later failure gets fresh blocks', () => {
    const dir = repo()
    start(dir)
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    stop(dir)
    stop(dir)
    writeFileSync(join(dir, 'review.md'), HONEST)
    const clean = stop(dir)
    expect(clean).toMatchObject({ action: 'allow', outcome: 'checked' })
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    expect(stop(dir).action).toBe('block')
  })

  it('keeps blocking when asked to', () => {
    const dir = repo()
    start(dir)
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    for (let i = 0; i < 5; i++) expect(stop(dir, { keepBlocking: true }).action).toBe('block')
  })

  it('falls back to the host reentry flag only when it cannot keep a count', () => {
    const dir = repo()
    start(dir)
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    const sessions = join(stateDir(dir)!, 'sessions')
    for (const f of execFileSync('ls', [sessions], { encoding: 'utf8' }).trim().split('\n')) {
      writeFileSync(join(sessions, f), 'not json')
    }
    // Corrupt state means "changed reviews" is unknown, so the review is not
    // checked; a message with claims still is, and is what exercises the fallback.
    const message = '**Claim**: the suite passes.'
    expect(stop(dir, {}, { message, reentry: false }).action).toBe('block')
    expect(stop(dir, {}, { message, reentry: true })).toMatchObject({ action: 'allow', outcome: 'fail-open-error' })
    expect(stop(dir, { failClosed: true }, { message, reentry: true }).action).toBe('block')
  })
})

describe('stop - the seal', () => {
  it('passes a review whose block came from the sealed run, and blocks once the code changes', () => {
    const dir = repo()
    start(dir)
    const sealed = sealTests(dir)
    writeFileSync(join(dir, 'review.md'), backedReview(sealed))
    expect(stop(dir)).toMatchObject({ action: 'allow', outcome: 'checked', level: 'pass' })

    writeFileSync(join(dir, 'src/a.js'), 'edited after the tests ran\n')
    writeFileSync(join(dir, 'review.md'), backedReview(sealed) + '\n')
    const stale = stop(dir)
    expect(stale.action).toBe('block')
    if (stale.action === 'block') expect(stale.reason).toContain('src/a.js')
  })

  it('blocks a block that was edited after it was gathered', () => {
    const dir = repo()
    start(dir)
    const sealed = sealTests(dir)
    writeFileSync(join(dir, 'review.md'), backedReview(sealed).replace('ok\n', 'ok, and more\n'))
    const decision = stop(dir)
    expect(decision.action).toBe('block')
    if (decision.action === 'block') expect(decision.reason).toContain('edited after it was gathered')
  })

  it('in strict mode, blocks a claim it could not hold to any seal', () => {
    const dir = repo()
    start(dir)
    const id = artifactId('pnpm test', 'f8ae76a', TESTS_OUTPUT)
    const unsealed = { id, block: formatArtifact('pnpm test', TESTS_OUTPUT, 0, { id, commit: 'f8ae76a' }) }
    writeFileSync(join(dir, 'review.md'), backedReview(unsealed))
    expect(stop(dir).level).toBe('unverifiable')
    expect(stop(dir).action).toBe('allow')
    expect(stop(dir, { strict: true }).action).toBe('block')
  })
})

describe('stop - claims in the final message', () => {
  it('resolves a cited id against the sealed bundle, since a chat reply carries no blocks', () => {
    const dir = repo()
    start(dir)
    const sealed = sealTests(dir)
    const message = 'Done.\n\n**Claim**: the suite ran 3 passing tests.\n**Grounding**: VERIFIED[' + sealed.id + ': passed>=3]'
    expect(stop(dir, {}, { message })).toMatchObject({ action: 'allow', level: 'pass' })
  })

  it('blocks a cited id that no sealed run produced, and a predicate the artifact contradicts', () => {
    const dir = repo()
    start(dir)
    const sealed = sealTests(dir)
    expect(stop(dir, {}, { message: '**Claim**: tests pass.\n**Grounding**: VERIFIED[tests-000000]' }).action).toBe('block')
    expect(
      stop(dir, {}, { message: '**Claim**: 5 tests pass.\n**Grounding**: VERIFIED[' + sealed.id + ': passed>=5]', sessionId: 's2' })
        .action,
    ).toBe('block')
  })

  it('does not grade ordinary prose, or a Claim line inside a code example', () => {
    const dir = repo()
    start(dir)
    const message = 'It works now and is much cleaner.\n\n```markdown\n**Claim**: the suite passes.\n```\n'
    expect(stop(dir, {}, { message }).outcome).toBe('not-applicable')
  })
})

describe('the gate journal', () => {
  it('records an exhausted episode as an error and a check it could not make as unverifiable - never a pass', () => {
    const dir = repo()
    start(dir)
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    stop(dir)
    stop(dir)
    stop(dir)
    const dir2 = repo()
    writeFileSync(join(dir2, 'review.md'), UNBACKED)
    stop(dir2)
    expect(gateJournal(dir).map((e) => [e.gate?.outcome, e.outcome])).toEqual([
      ['checked', 'error'],
      ['checked', 'error'],
      ['retry-exhausted', 'error'],
    ])
    expect(gateJournal(dir2).map((e) => [e.gate?.outcome, e.outcome])).toEqual([['no-snapshot', 'unverifiable']])
  })

  it('maps outcomes onto the five levels without inventing a pass', () => {
    expect(journalOutcome('checked', 'warning')).toBe('warning')
    expect(journalOutcome('retry-exhausted', 'error')).toBe('error')
    expect(journalOutcome('fail-open-error', 'unverifiable')).toBe('unverifiable')
    expect(journalOutcome('not-applicable', null)).toBeNull()
    expect(levelOf([{ level: 'warning', claim: '', detail: '' }, { level: 'unverifiable', claim: '', detail: '' }])).toBe(
      'unverifiable',
    )
  })
})

describe('pre-write', () => {
  const write = (cwd: string, path: string): GateDecision => decide({ kind: 'pre-write', cwd, paths: [path] })

  it('denies a write into the ledger, by any route to it', () => {
    const dir = repo()
    const state = join(dir, '.git', 'evidence-layer')
    mkdirSync(state, { recursive: true })
    expect(write(dir, join(state, 'current.json')).action).toBe('deny')
    expect(write(join(dir, 'src'), '../.git/evidence-layer/runs/x/seal.json').action).toBe('deny')
    symlinkSync(join(dir, '.git'), join(dir, 'gitlink'))
    expect(write(dir, join(dir, 'gitlink', 'evidence-layer', 'new.json')).action).toBe('deny')
  })

  it('denies writes into a worktree\'s ledger too, and allows ordinary files', () => {
    const dir = repo()
    const wt = dir + '-wt'
    sh(dir, 'worktree', 'add', '-q', wt)
    const wtState = join(dir, '.git', 'worktrees', basename(wt), 'evidence-layer', 'current.json')
    expect(isProtected(wt, wtState)).toBe(true)
    expect(write(wt, join(wt, 'src', 'a.js')).action).toBe('allow')
    expect(write(dir, join(dir, '.git', 'config')).action).toBe('allow')
  })

  it('records a deny in the gate journal', () => {
    const dir = repo()
    write(dir, join(dir, '.git', 'evidence-layer', 'current.json'))
    expect(readFileSync(join(dir, '.git', 'evidence-layer', 'journal.jsonl'), 'utf8')).toContain('gate:pre-write')
  })
})

describe('the gate journal, summarised', () => {
  it('counts blocks, clean allows and degraded allows separately', async () => {
    const { summariseGate } = await import('../src/core/journal')
    const dir = repo()
    start(dir)
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    stop(dir)
    stop(dir)
    stop(dir)
    writeFileSync(join(dir, 'review.md'), HONEST)
    stop(dir)
    expect(summariseGate(gateJournal(dir))).toMatchObject({ blocks: 2, cleanAllows: 1, degradedAllows: 1, denies: 0 })
  })
})

describe('stop - what the agent is told', () => {
  it('gives a warnings-only allow its warnings, under an intro that says what they are', () => {
    const dir = repo()
    start(dir)
    const sealed = sealTests(dir)
    const claim = (n: number) => '**Claim**: the suite ran 3 passing tests (' + n + ').\n**Grounding**: VERIFIED[' + sealed.id + ': passed>=3]\n'
    const decision = stop(dir, {}, { message: [1, 2, 3].map(claim).join('\n') })
    expect(decision).toMatchObject({
      action: 'allow',
      outcome: 'checked',
      level: 'warning',
      message: expect.stringContaining('- [warning] artifact ' + sealed.id + ' backs 3 claims'),
    })
    expect(decision.action === 'allow' && decision.message).not.toContain('could not be checked')
  })

  it('numbers each failing claim with its problem and fix, then hands over the ready claims and the --fix command', () => {
    const dir = repo()
    start(dir)
    const sealed = sealTests(dir)
    const wrongCount = '**Claim**: the suite ran 4 passing tests.\n**Grounding**: VERIFIED[' + sealed.id + ']\n'
    writeFileSync(join(dir, 'review.md'), '# Review\n\n' + wrongCount + '\n' + sealed.block + '\n\n**Claim**: the suite passes.\n')
    const decision = stop(dir)
    expect(decision.action).toBe('block')
    if (decision.action !== 'block') return
    const reason = decision.reason
    expect(reason).toContain('\n1. review.md:3 - the suite ran 4 passing tests.\n   problem: VERIFIED[' + sealed.id + '] says "4 passing tests"')
    expect(reason).toContain('   fix: replace the claim and its grounding with the lines below - or mark the claim UNVERIFIED:\n     **Claim**: The test suite ran 3 passing tests')
    expect(reason).toContain('\n2. review.md:')
    expect(reason).toContain('`npx evidence-layer claims review.md --fix`')
    expect(reason).toContain('Ready claims from run')
  })

  it('says how to gather on a finding whose fix is to gather again', () => {
    const dir = repo()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { evidence: 'node gather.mjs' }, packageManager: 'pnpm@9.0.0' }))
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-qm', 'manifest')
    start(dir)
    const sealed = sealTests(dir)
    writeFileSync(join(dir, 'src/a.js'), 'changed\n')
    writeFileSync(join(dir, 'review.md'), backedReview(sealed))
    const decision = stop(dir)
    expect(decision.action === 'block' && decision.reason).toContain('fix: gather again with `pnpm run evidence`')
    // A pnpm project runs the CLI through pnpm, and stale claims are not handed out as ready.
    expect(decision.action === 'block' && decision.reason).not.toContain('Ready claims')
  })

  it('does not hand out stale ready claims when nothing cited the run - pasting them would only be blocked again', () => {
    const dir = repo()
    start(dir)
    const sealed = sealTests(dir)
    writeFileSync(join(dir, 'src/a.js'), 'changed after the gather\n')
    // No VERIFIED claim here, so no check of this stop read the run's freshness.
    const first = stop(dir, {}, { message: '**Claim**: the suite passes.\n' })
    expect(first.action).toBe('block')
    expect(first.action === 'block' && first.reason).not.toContain('Ready claims')
    expect(first.action === 'block' && first.reason).not.toContain(sealed.id)
  })

  it('keeps the journal entry id out of the reason the agent reads, so it cannot tag its own block', () => {
    const dir = repo()
    start(dir)
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    const decision = stop(dir)
    const id = gateJournal(dir).at(-1)!.id
    expect(decision.action).toBe('block')
    expect(decision.action === 'block' && decision.reason).not.toContain(id)
    expect(decision.action === 'block' && decision.reason).not.toContain('journal tag')
  })

  it('names the command and the base the current run was gathered with', async () => {
    const { gatherEvidence } = await import('../src/core/gather')
    const dir = repo()
    start(dir)
    await gatherEvidence({ repo: dir, base: 'HEAD', out: join(dir, 'evidence.local.md'), skip: ['lint', 'typecheck', 'lockfile', 'test'], gatherCommand: 'make evidence' })
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    expect(stop(dir)).toMatchObject({ action: 'block', reason: expect.stringContaining('`make evidence` (base HEAD') })
  }, 30_000)

  it('names the project\'s gather command at session start and in a block', () => {
    const dir = repo()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { evidence: 'node gather.js' } }))
    expect(start(dir)).toMatchObject({ action: 'context', text: expect.stringContaining('`npm run evidence`') })
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    expect(stop(dir)).toMatchObject({ action: 'block', reason: expect.stringContaining('`npm run evidence`') })

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ evidenceLayer: { gather: 'make evidence BASE=origin/main' } }))
    expect(start(dir, 's2')).toMatchObject({ text: expect.stringContaining('`make evidence BASE=origin/main`') })
  })
})

describe('stop - after the retries run out', () => {
  it('says nothing and journals nothing while the review, the run and the tree are what they were', () => {
    const dir = repo()
    start(dir)
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    stop(dir)
    stop(dir)
    expect(stop(dir)).toMatchObject({ action: 'allow', outcome: 'retry-exhausted', message: expect.any(String) })
    const repeat = stop(dir)
    expect(repeat).toMatchObject({ action: 'allow', outcome: 'retry-exhausted', level: 'error' })
    expect(repeat.action === 'allow' && repeat.message).toBeFalsy()
    expect(gateJournal(dir)).toHaveLength(3)

    writeFileSync(join(dir, 'review.md'), UNBACKED + '\nmore words\n')
    expect(stop(dir)).toMatchObject({ outcome: 'retry-exhausted', message: expect.any(String) })
    expect(gateJournal(dir)).toHaveLength(4)
  }, 30_000)

  it('speaks again when the findings change, though the review, the run and the tree did not', () => {
    const dir = repo()
    start(dir)
    const head = sh(dir, 'rev-parse', 'HEAD')
    // The base check reads a remote-tracking ref - git state no text, run or
    // tree hash covers. Fetching one changes the findings, and so the verdict.
    const receipt = '**HEAD SHA**: ' + head + '\n**Target branch**: main\n**Base SHA**: ' + head + '\n\n'
    writeFileSync(join(dir, 'review.md'), receipt + UNBACKED)
    stop(dir)
    stop(dir)
    stop(dir)
    expect(stop(dir)).not.toHaveProperty('message')
    sh(dir, 'update-ref', 'refs/remotes/origin/main', head)
    expect(stop(dir)).toMatchObject({ outcome: 'retry-exhausted', message: expect.any(String) })
  }, 30_000)

  it('speaks again once the code a cited run describes changes', () => {
    const dir = repo()
    start(dir)
    const sealed = sealTests(dir)
    writeFileSync(join(dir, 'review.md'), backedReview(sealed).replace('passed>=3', 'passed>=5'))
    stop(dir)
    stop(dir)
    stop(dir)
    const repeat = stop(dir)
    expect(repeat).toMatchObject({ outcome: 'retry-exhausted' })
    expect(repeat.action === 'allow' && repeat.message).toBeFalsy()
    expect(gateJournal(dir)).toHaveLength(3)
    writeFileSync(join(dir, 'src/a.js'), 'edited\n')
    const changed = stop(dir)
    expect(changed).toMatchObject({ outcome: 'retry-exhausted', message: expect.stringContaining('src/a.js') })
  }, 30_000)
})

describe('stop - nothing to check while an episode is open', () => {
  it('closes the episode and journals that it closed without a clean check', () => {
    const dir = repo()
    start(dir)
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    stop(dir)
    stop(dir)
    rmSync(join(dir, 'review.md'))
    const closed = stop(dir)
    expect(closed).toMatchObject({ action: 'allow', outcome: 'closed-unchecked' })
    expect(gateJournal(dir).at(-1)).toMatchObject({ outcome: 'unverifiable', gate: { outcome: 'closed-unchecked' } })
    // Counted on its own, not among the allows that let errors through.
    expect(summariseGate(gateJournal(dir))).toMatchObject({ blocks: 2, closedUnchecked: 1, degradedAllows: 0 })
    // Closed, so the next failure starts a fresh episode with fresh blocks.
    writeFileSync(join(dir, 'review.md'), UNBACKED)
    expect(stop(dir).action).toBe('block')
    // With no episode open, a stop with nothing to check stays silent.
    const quiet = repo()
    start(quiet)
    stop(quiet)
    expect(gateJournal(quiet)).toHaveLength(0)
  }, 30_000)
})

describe('stop - final-message lookups', () => {
  it('says an unknown id is missing from the current sealed run, not from "this document"', () => {
    const dir = repo()
    start(dir)
    sealTests(dir)
    const decision = stop(dir, {}, { message: '**Claim**: tests pass.\n**Grounding**: VERIFIED[tests-000000]' })
    expect(decision).toMatchObject({ action: 'block', reason: expect.stringContaining('the current sealed run') })
    expect(decision.action === 'block' && decision.reason).not.toContain('this document')
  })
})
