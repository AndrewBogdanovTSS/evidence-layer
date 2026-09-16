/**
 * The reporter's one environment dependency, checked rather than assumed.
 *
 * `useColor` is decided once at module load, so each case needs a fresh module
 * registry - which is also the honest shape of the thing being tested: a
 * process does not change its mind about colour half way through a run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const FINDING = [{ level: 'pass' as const, claim: 'a claim', detail: '' }]
const ESC = String.fromCharCode(27)

async function iconFor(noColor: string | undefined): Promise<string> {
  vi.resetModules()
  const before = process.env.NO_COLOR
  if (noColor === undefined) delete process.env.NO_COLOR
  else process.env.NO_COLOR = noColor

  const lines: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.join(' '))
  })
  try {
    const { report } = await import('../src/core/cli')
    report('t', FINDING)
    return lines.find((l) => l.includes('a claim')) ?? ''
  } finally {
    log.mockRestore()
    if (before === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = before
  }
}

afterEach(() => {
  vi.resetModules()
})

describe('NO_COLOR, as no-color.org defines it', () => {
  it('colours the status icon when the variable is absent', async () => {
    expect(await iconFor(undefined)).toContain(ESC)
  })

  it('drops the colour when the variable is set to anything', async () => {
    expect(await iconFor('1')).not.toContain(ESC)
  })

  it('keeps the colour when the variable is present but empty - that is a cancellation, not an opt-out', async () => {
    expect(await iconFor('')).toContain(ESC)
  })
})
