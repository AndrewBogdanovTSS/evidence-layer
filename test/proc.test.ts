import { describe, expect, it } from 'vitest'
import { capture, run } from '../src/core/proc'

describe('run', () => {
  it('captures stdout and a zero exit code', () => {
    const res = run('node -e "console.log(1+1)"')
    expect(res.output).toBe('2')
    expect(res.exitCode).toBe(0)
    expect(res.timedOut).toBe(false)
  })

  it('records a non-zero exit rather than throwing', () => {
    expect(run('node -e "process.exit(7)"').exitCode).toBe(7)
  })

  it('records a timeout as exit 124, not as a crash', () => {
    const res = run('node -e "setTimeout(()=>{}, 5000)"', { timeoutMs: 100 })
    expect(res.exitCode).toBe(124)
    expect(res.timedOut).toBe(true)
    expect(res.output).toContain('timed out')
  })

  it('strips a leading package-manager echo line, so it does not collide with an artifact block header', () => {
    // Simulates `pnpm <script>` announcing the resolved command as its first
    // line of output, ahead of the program's real stdout - found by running
    // `pnpm fingerprint` for real while building a fixture.
    const res = run('node -e "console.log(\'$ tsx scripts/fingerprint.ts\'); console.log(\'real output\')"')
    expect(res.output).toBe('real output')
  })
})

describe('capture', () => {
  it('returns trimmed stdout on success', () => {
    expect(capture('node -e "console.log(\'  hi  \')"')).toBe('hi')
  })

  it('returns null on failure rather than empty output someone might mistake for a real answer', () => {
    expect(capture('node -e "process.exit(1)"')).toBeNull()
  })
})

describe('captured output is evidence, so the terminal must not appear in it', () => {
  it('strips colour a child emits, so an artifact id does not depend on FORCE_COLOR', () => {
    // Node colours a bare number in `console.log` when it believes colour is
    // supported, and FORCE_COLOR makes it believe that even through a pipe.
    // Same command, same commit, different machine setting - the id must not
    // move, so the escape sequences cannot survive into the output.
    const before = process.env.FORCE_COLOR
    try {
      process.env.FORCE_COLOR = '1'
      const coloured = run('node -e "console.log(1+1)"')
      expect(coloured.output).toBe('2')
      // ...and the colour is still there for anything that re-prints it.
      expect(coloured.raw).toContain('2')
      expect(coloured.raw).not.toBe('2')
    } finally {
      if (before === undefined) delete process.env.FORCE_COLOR
      else process.env.FORCE_COLOR = before
    }
  })

  it('leaves text that was never coloured exactly as it was', () => {
    expect(run('node -e "process.stdout.write(String(41 + 1))"').output).toBe('42')
  })
})
