import { describe, expect, it } from 'vitest'
import { planStepsDefault, stepFailed } from '../src/core/gather'
import { gatherOneStep, gatherableRepo, printAndExit } from './helpers/gather'

describe('planStepsDefault - the zero-config default', () => {
  it('plans lint, typecheck, a lockfile check and test with no options at all', () => {
    const steps = planStepsDefault(['a.ts'], [])
    expect(steps.map((s) => s.name)).toEqual(['lint', 'typecheck', 'lockfile', 'test'])
    expect(steps[0]!.command).toBe('pnpm lint')
    expect(steps[3]!.command).toBe('pnpm test')
  })

  it('plans the lockfile check assuming a lockfile exists, unless told otherwise', () => {
    const steps = planStepsDefault(['a.ts'], [])
    const lockfile = steps.find((s) => s.name === 'lockfile')
    expect(lockfile?.command).toBe('pnpm install --frozen-lockfile --lockfile-only')
    expect(lockfile?.skipReason).toBeUndefined()
  })

  it('skips the lockfile check honestly, with a reason, when the caller says there is none', () => {
    const steps = planStepsDefault(['a.ts'], [], { hasLockfile: false })
    expect(steps.find((s) => s.name === 'lockfile')?.skipReason).toBe('no pnpm-lock.yaml in this repository')
  })

  it('always includes the test step by default - a project must opt into scoping it', () => {
    const steps = planStepsDefault(['README.md'], [])
    expect(steps.find((s) => s.name === 'test')?.skipReason).toBeUndefined()
  })

  it('honours a project-supplied test gate', () => {
    const gate = (files: string[]) => files.some((f) => f.startsWith('src/'))
    const skipped = planStepsDefault(['README.md'], [], { testGate: gate })
    expect(skipped.find((s) => s.name === 'test')?.skipReason).toBeDefined()

    const kept = planStepsDefault(['src/x.ts'], [], { testGate: gate })
    expect(kept.find((s) => s.name === 'test')?.skipReason).toBeUndefined()
  })

  it('honours a project-supplied scoped lint command', () => {
    const steps = planStepsDefault(['a.ts', 'b.ts'], [], { lintCommand: (files) => 'eslint ' + files.join(' ') })
    expect(steps[0]!.command).toBe('eslint a.ts b.ts')
  })

  it('records a --skip as a skip, with a reason - silence is not evidence', () => {
    const steps = planStepsDefault(['a.ts'], ['lint', 'typecheck', 'lockfile', 'test'])
    for (const step of steps) expect(step.skipReason).toBe('skipped by --skip')
  })

  it('a --skip of lockfile wins even when a lockfile genuinely exists', () => {
    const steps = planStepsDefault(['a.ts'], ['lockfile'], { hasLockfile: true })
    expect(steps.find((s) => s.name === 'lockfile')?.skipReason).toBe('skipped by --skip')
  })
})

describe('gatherEvidence - how every step ended', () => {
  it('records each planned step in order, a skip with its reason, and a failure that stepFailed reads', async () => {
    const { result } = await gatherOneStep(gatherableRepo('el-gather-'), printAndExit('two problems', 1))
    expect(result.steps.map((s) => s.name)).toEqual(['lint', 'typecheck', 'lockfile', 'test'])
    expect(result.steps[1]).toEqual({ name: 'typecheck', command: 'pnpm typecheck', skipReason: 'skipped by --skip' })
    expect(result.steps[0]).toMatchObject({ name: 'lint', exitCode: 1, id: expect.stringMatching(/^cmd-[0-9a-f]{6}$/) })
    expect(result.steps.filter(stepFailed).map((s) => s.name)).toEqual(['lint'])
  })

  it('counts a step stopped at its time limit as failed, and a passing one as not', async () => {
    const dir = gatherableRepo('el-gather-')
    const stopped = (await gatherOneStep(dir, 'node -e "setTimeout(() => {}, 20000)"', 500)).result
    expect(stopped.steps[0]).toMatchObject({ stopped: 'timeout' })
    expect(stepFailed(stopped.steps[0]!)).toBe(true)
    expect((await gatherOneStep(dir)).result.steps.some(stepFailed)).toBe(false)
  }, 30_000)
})
