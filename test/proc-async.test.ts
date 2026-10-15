import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAsync } from '../src/core/proc'

describe('runAsync', { timeout: 20_000 }, () => {
  it('captures stdout, a zero exit code and how long it took', async () => {
    const res = await runAsync('node -e "console.log(1+1)"')
    expect(res.output).toBe('2')
    expect(res.exitCode).toBe(0)
    expect(res.timedOut).toBe(false)
    expect(res).not.toHaveProperty('stopped')
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('records a non-zero exit rather than throwing', async () => {
    expect((await runAsync('node -e "process.exit(7)"')).exitCode).toBe(7)
  })

  it('passes the environment it is given', async () => {
    const res = await runAsync('node -e "console.log(process.env.EVIDENCE_PROBE)"', {
      env: { ...process.env, EVIDENCE_PROBE: 'seen' },
    })
    expect(res.output).toBe('seen')
  })

  it('stops a run that overflows the capture limit, and says so', async () => {
    const res = await runAsync('node -e "process.stdout.write(\'x\'.repeat(1000)); setTimeout(() => {}, 60000)"', {
      maxBufferBytes: 100,
    })
    expect(res.stopped).toBe('overflow')
    expect(res.exitCode).toBe(1)
    expect(res.timedOut).toBe(false)
    expect(res.output).toContain('output exceeded 100 bytes')
  })

  // The real case is `pnpm typecheck` -> nuxi -> vue-tsc: the direct child is a
  // shell or a shim, and the work sits below it. A node parent that starts a
  // node sleeper is the same shape without needing pnpm installed.
  //
  // Liveness is a heartbeat, not `kill(pid, 0)`: on Linux a killed process
  // whose new parent never reaps it (a CI container's PID 1) stays a zombie
  // that `kill(pid, 0)` still reports as existing. A zombie cannot write, so a
  // heartbeat file that stops growing is the observation that matters.
  it('kills the whole process tree on timeout, not just the direct child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-tree-'))
    const beat = join(dir, 'beat')
    const sleeper = join(dir, 'sleeper.cjs')
    const parent = join(dir, 'parent.cjs')
    writeFileSync(
      sleeper,
      "const fs = require('node:fs')\nsetInterval(() => fs.appendFileSync(" + JSON.stringify(beat) + ", '.'), 50)\nconsole.log('sleeper started')\n",
    )
    writeFileSync(
      parent,
      "require('node:child_process').spawn(process.execPath, [" + JSON.stringify(sleeper) + "], { stdio: 'inherit' })\nsetTimeout(() => {}, 60000)\n",
    )
    try {
      const res = await runAsync('node "' + parent + '"', { timeoutMs: 1_500 })
      expect(res.stopped).toBe('timeout')
      expect(res.exitCode).toBe(124)
      expect(res.output).toContain('sleeper started')
      expect(res.output).toContain('timed out after 1500 ms')
      const beatsAtSettle = statSync(beat).size
      expect(beatsAtSettle).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(statSync(beat).size).toBe(beatsAtSettle)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})
