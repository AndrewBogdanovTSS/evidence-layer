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
