import { describe, expect, it } from 'vitest'
import { planStepsDefault } from '../src/core/gather'

describe('planStepsDefault - the zero-config default', () => {
  it('plans lint, typecheck and test with no options at all', () => {
    const steps = planStepsDefault(['a.ts'], [])
    expect(steps.map((s) => s.name)).toEqual(['lint', 'typecheck', 'test'])
    expect(steps[0]!.command).toBe('pnpm lint')
    expect(steps[2]!.command).toBe('pnpm test')
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
    const steps = planStepsDefault(['a.ts'], ['lint', 'typecheck', 'test'])
    for (const step of steps) expect(step.skipReason).toBe('skipped by --skip')
  })
})
