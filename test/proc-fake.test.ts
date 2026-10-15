// The kill and close logic against a fake child process and fake timers -
// instant and deterministic. Its own file, because the module mock below would
// otherwise replace the real `spawn` that proc-async.test.ts depends on.
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type FakeChild = EventEmitter & { pid: number; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }

const fake = vi.hoisted(() => ({ child: null as unknown as FakeChild }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(() => fake.child),
  // `taskkill` on Windows: report success without touching a real process.
  spawnSync: vi.fn(() => ({ status: 0 })),
}))

const { runAsync } = await import('../src/core/proc')

describe('runAsync with a fake process', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fake.child = Object.assign(new EventEmitter(), {
      // No real process has this pid, so the POSIX group kill throws and the
      // runner falls back to killing the direct child.
      pid: 2 ** 22 - 7,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a timeout once the killed tree closes its output', async () => {
    const pending = runAsync('pnpm typecheck', { timeoutMs: 1_000 })
    await vi.advanceTimersByTimeAsync(1_000)
    fake.child.emit('close', null, 'SIGKILL')
    await expect(pending).resolves.toMatchObject({ exitCode: 124, timedOut: true, stopped: 'timeout' })
  })

  it('still reports when the tree never closes its output', async () => {
    const pending = runAsync('pnpm typecheck', { timeoutMs: 1_000, killGraceMs: 5_000 })
    await vi.advanceTimersByTimeAsync(1_000 + 5_000)
    const res = await pending
    expect(res).toMatchObject({ exitCode: 124, timedOut: true, stopped: 'timeout' })
    expect(res.output).toContain('still held its output 5000 ms after the kill')
  })

  it('reports a kill from outside as a kill, never as a timeout', async () => {
    const pending = runAsync('pnpm typecheck', { timeoutMs: 1_000 })
    fake.child.emit('close', null, 'SIGKILL')
    const res = await pending
    expect(res).toMatchObject({ exitCode: 137, timedOut: false, stopped: 'killed SIGKILL' })
    expect(res.output).toContain('[killed by SIGKILL]')
  })

  it('settles on a start failure, which has no tree and may never close', async () => {
    const pending = runAsync('pnpm typecheck')
    fake.child.emit('error', new Error('spawn EACCES'))
    await expect(pending).resolves.toMatchObject({ exitCode: 1, timedOut: false })
  })
})
