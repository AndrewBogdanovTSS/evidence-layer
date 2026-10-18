/**
 * The GitHub Action as the runner starts it: `node action/run.mjs` with its
 * inputs in `INPUT_*`, writing `exit-code` and `conclusion` to `GITHUB_OUTPUT`.
 * Which evidence-layer it runs, and that a misconfigured step never passes.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const ACTION = join(root, 'action', 'run.mjs')
const GOOD = readFileSync(join(root, 'examples', 'plain-node-project', 'reviews', 'good-claims.md'), 'utf8')
const BAD = readFileSync(join(root, 'examples', 'plain-node-project', 'reviews', 'bad-claims.md'), 'utf8')

function workspace(pkg: 'installed' | 'old' | 'unbuilt-self' | 'none'): string {
  const dir = mkdtempSync(join(tmpdir(), 'el-action-'))
  writeFileSync(join(dir, 'good.md'), GOOD)
  writeFileSync(join(dir, 'bad.md'), BAD)
  if (pkg === 'installed') {
    mkdirSync(join(dir, 'node_modules'))
    symlinkSync(root, join(dir, 'node_modules', 'evidence-layer'))
  }
  if (pkg === 'old') {
    mkdirSync(join(dir, 'node_modules', 'evidence-layer'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'evidence-layer', 'package.json'), '{"name":"evidence-layer","version":"0.6.0","evidenceLayer":{"hookProtocol":1}}')
  }
  if (pkg === 'unbuilt-self') writeFileSync(join(dir, 'package.json'), '{"name":"evidence-layer","version":"9.9.9"}')
  return dir
}

function action(dir: string, inputs: Record<string, string>, extraEnv: Record<string, string> = {}) {
  const output = join(dir, 'github-output')
  writeFileSync(output, '')
  const env: Record<string, string> = { ...(process.env as Record<string, string>), GITHUB_WORKSPACE: dir, GITHUB_OUTPUT: output, ...extraEnv }
  for (const [key, value] of Object.entries(inputs)) env['INPUT_' + key.toUpperCase()] = value
  const res = spawnSync(process.execPath, [ACTION], { encoding: 'utf8', env })
  const outputs = Object.fromEntries(
    readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('=') as [string, string]),
  )
  return { status: res.status, stdout: res.stdout, outputs }
}

describe('action.yml', () => {
  it('declares exactly the inputs the action reads, and points at a file that exists', () => {
    const yml = readFileSync(join(root, 'action.yml'), 'utf8')
    const declared = [...(/^inputs:\n([\s\S]*?)^\S/m.exec(yml)?.[1] ?? '').matchAll(/^ {2}([a-z-]+):/gm)].map((m) => m[1]!).sort()
    const read = [...readFileSync(ACTION, 'utf8').matchAll(/input\('([a-z-]+)'\)/g)].map((m) => m[1]!)
    expect([...new Set(read)].sort()).toEqual(declared)
    expect(/^ {2}main: action\/run\.mjs$/m.test(yml)).toBe(true)
    expect(/^ {2}using: node24$/m.test(yml)).toBe(true)
  })
})

describe('the action', () => {
  it('runs the evidence-layer the project installed, and reports the worst exit code', () => {
    const dir = workspace('installed')
    const clean = action(dir, { claims: 'good.md' })
    expect(clean.stdout).toContain('installed in the project')
    expect(clean.outputs).toEqual({ 'exit-code': '0', conclusion: 'success' })

    const mixed = action(dir, { claims: 'good.md, bad.md' })
    expect(mixed.status).toBe(1)
    expect(mixed.outputs).toEqual({ 'exit-code': '1', conclusion: 'failure' })
    expect(mixed.stdout).toMatch(/^::error file=bad\.md,line=\d+,title=claims\//m)
  })

  it('ranks a misconfigured step above a failing one - a missing review is not a clean run', () => {
    const res = action(workspace('installed'), { claims: 'bad.md\nmissing.md' })
    expect(res.status).toBe(2)
    expect(res.outputs.conclusion).toBe('misconfigured')
  })

  it('refuses an installed package that cannot write annotations, rather than printing plain text', () => {
    const res = action(workspace('old'), { claims: 'good.md' })
    expect(res.status).toBe(2)
    expect(res.stdout).toContain('cannot write GitHub annotations')
  })

  it('in evidence-layer\'s own repository, needs it built', () => {
    const res = action(workspace('unbuilt-self'), { claims: 'good.md' })
    expect(res.status).toBe(2)
    expect(res.stdout).toContain('pnpm build')
  })

  it('pins the version it fetches, and refuses one that is not exact', () => {
    const res = action(workspace('none'), { claims: 'good.md', version: 'latest' })
    expect(res.status).toBe(2)
    expect(res.stdout).toContain('exact version')
  })

  // The registry, stood in for: an `npx` on PATH that writes down what it was
  // asked for and then runs this checkout's build as the package it fetched.
  // POSIX only - the stand-in is a shell script.
  it.skipIf(process.platform === 'win32')('with nothing installed, fetches exactly the version the action was released with, or the one asked for', () => {
    const bin = mkdtempSync(join(tmpdir(), 'el-fake-npx-'))
    const log = join(bin, 'npx.log')
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\necho "$@" >> "$NPX_LOG"\nshift 2\nexec "$NODE" "$EL_BIN" "$@"\n', { mode: 0o755 })
    const env = { PATH: bin + ':' + process.env.PATH, NPX_LOG: log, NODE: process.execPath, EL_BIN: join(root, 'dist', 'bin', 'evidence-layer.mjs') }
    const released = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version

    const fetched = action(workspace('none'), { claims: 'good.md, bad.md' }, env)
    expect(fetched.stdout).toContain('evidence-layer ' + released + ', from npm')
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      '--yes evidence-layer@' + released + ' claims good.md --format github',
      '--yes evidence-layer@' + released + ' claims bad.md --format github',
    ])
    // What npx ran decides the step, exactly as an installed package would.
    expect(fetched.outputs).toEqual({ 'exit-code': '1', conclusion: 'failure' })
    expect(fetched.stdout).toMatch(/^::error file=bad\.md,line=\d+,title=claims\//m)

    writeFileSync(log, '')
    expect(action(workspace('none'), { claims: 'good.md', version: '0.6.0' }, env).outputs.conclusion).toBe('success')
    expect(readFileSync(log, 'utf8').trim()).toBe('--yes evidence-layer@0.6.0 claims good.md --format github')
  })

  it('treats nothing to check as misconfigured, not as a pass', () => {
    const res = action(workspace('installed'), { claims: '', receipt: '', governance: 'false' })
    expect(res.status).toBe(2)
    expect(res.outputs.conclusion).toBe('misconfigured')
  })
})
