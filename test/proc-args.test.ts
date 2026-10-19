import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runAsync } from '../src/core/proc'

const IS_WINDOWS = process.platform === 'win32'
const dir = mkdtempSync(join(tmpdir(), 'el-args-'))
const print = join(dir, 'print-args.js')
writeFileSync(print, 'console.log(JSON.stringify(process.argv.slice(2)))\n')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const argsSeen = async (program: string, args: string[]) => JSON.parse((await runAsync(program, { args })).output) as string[]

describe('runAsync with an argument array', { timeout: 20_000 }, () => {
  it('passes each argument as exactly one argument, spaces and all', async () => {
    expect(await argsSeen('node', [print, 'a b', 'c', ''])).toEqual(['a b', 'c', ''])
  })

  it('gives a shell nothing to read in an argument', async () => {
    const hostile = ['$(echo pwned)', '`id`', 'a;b', 'a&b', 'a|b', '<x>', "it's"]
    expect(await argsSeen('node', [print, ...hostile])).toEqual(hostile)
  })

  it('keeps a trailing backslash literal', async () => {
    expect(await argsSeen('node', [print, 'dir with space\\'])).toEqual(['dir with space\\'])
  })

  // No temporary path in the line: whether one needs quoting is itself
  // platform-dependent (`C:\...` does, `/tmp/...` does not).
  it('shows one command line on every platform, so the artifact id does not depend on it', async () => {
    const res = await runAsync('node', { args: ['-e', 'console.log(1)', 'a b', "it's", 'plain'] })
    expect(res.output).toBe('1')
    expect(res.command).toBe("node -e 'console.log(1)' 'a b' 'it'\\''s' plain")
  })

  it('runs a .cmd shim on Windows, the way pnpm is installed there', { skip: !IS_WINDOWS }, async () => {
    const shim = join(dir, 'shim.cmd')
    writeFileSync(shim, '@node "%~dp0print-args.js" %*\r\n')
    expect(await argsSeen(shim, ['a b', 'c'])).toEqual(['a b', 'c'])
  })

  it('refuses an argument cmd.exe cannot be trusted with, rather than running something else', { skip: !IS_WINDOWS }, async () => {
    await expect(runAsync('node', { args: [print, 'say "hi"'] })).rejects.toThrow(RangeError)
    await expect(runAsync('node', { args: [print, '%PATH%'] })).rejects.toThrow(RangeError)
  })

  it('passes the same arguments untouched where no shell is involved', { skip: IS_WINDOWS }, async () => {
    expect(await argsSeen('node', [print, 'say "hi"', '%PATH%'])).toEqual(['say "hi"', '%PATH%'])
  })

  it('records a program that cannot start as a failed run, not a pass', { skip: IS_WINDOWS }, async () => {
    const res = await runAsync('evidence-layer-no-such-program', { args: ['x'] })
    expect(res.exitCode).not.toBe(0)
  })
})
