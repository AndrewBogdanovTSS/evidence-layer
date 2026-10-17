/**
 * The published package, exercised with nothing but Node.
 *
 * Two claims the vitest suite structurally cannot make, because it runs with
 * `node_modules/` present and a toolchain with its own, newer engine floor:
 *
 *   1. **Zero runtime dependencies.** This file runs with nothing installed.
 *      If it passes, the claim is demonstrated rather than asserted.
 *   2. **The floor in `engines.node`.** The oldest Node the package claims to
 *      support is not always one the test runner can start on, and narrowing
 *      the package's claim to fit its toolchain would be the easy fix and the
 *      dishonest one.
 *
 * `node scripts/smoke.mjs`, after `dist/` exists, is the whole contract.
 *
 * Exit codes: 0 every check passed - 1 at least one did not.
 */
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const bin = join(root, pkg.bin['evidence-layer'])

const checks = []
const check = (name, fn) => checks.push({ name, fn })

const cli = (args) =>
  spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' })

check('the package entry point imports and exports what the README promises', async () => {
  // `import()` of an absolute path needs a file:// URL, or Windows drive
  // letters are read as a URL scheme.
  const api = await import(pathToFileURL(join(root, 'dist', 'index.mjs')).href)
  for (const name of ['lintClaims', 'checkReceipt', 'parseReceipt', 'gatherEvidence', 'artifactId', 'EXIT']) {
    assert.ok(name in api, 'missing export: ' + name)
  }
})

check('the adapter subpath imports', async () => {
  const adapter = await import(pathToFileURL(join(root, 'dist', 'adapters', 'node-default.mjs')).href)
  assert.equal(typeof adapter.parseTestCount, 'function')
  assert.equal(adapter.parseTestCount('Tests  3 passed (3)'), 3)
})

check('the CLI reports the version package.json declares', () => {
  const result = cli(['--version'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), pkg.version)
})

check('the CLI exits 2 on an unknown command and 0 on --help', () => {
  assert.equal(cli(['definitely-not-a-command']).status, 2)
  assert.equal(cli(['--help']).status, 0)
})

check('governance runs against the fixture with no configuration', () => {
  const fixture = join(root, 'examples', 'plain-node-project')
  const result = cli(['governance', '--repo', fixture, '--decisions', join(fixture, 'docs', 'decisions'), '--no-json'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /is reachable from a wired trigger/)
})

check('claims passes the backed review and fails the unbacked one', () => {
  const reviews = join(root, 'examples', 'plain-node-project', 'reviews')
  assert.equal(cli(['claims', join(reviews, 'good-claims.md')]).status, 0)
  assert.equal(cli(['claims', join(reviews, 'bad-claims.md')]).status, 1)
})

/**
 * Cold start, printed as a number rather than asserted. An agent's hook starts
 * this executable on every tool call, so the number is worth watching - but a
 * timing on a shared runner is noise as often as signal, and a check that
 * fails on noise is `flaky`, not a finding. Over budget is printed as a
 * warning and changes nothing about the exit code.
 */
const COLD_START_BUDGET_MS = 100
function measureColdStart() {
  const runs = []
  for (let i = 0; i < 5; i++) {
    const start = process.hrtime.bigint()
    cli(['--version'])
    runs.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  runs.sort((a, b) => a - b)
  return runs[Math.floor(runs.length / 2)]
}

let failed = 0
console.log('\nSmoke test on Node ' + process.version)
console.log('-'.repeat(28 + process.version.length))
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log('✔ ' + name)
  } catch (err) {
    failed++
    console.log('✘ ' + name)
    console.log('        ' + (err instanceof Error ? err.message : String(err)))
  }
}
const coldStart = measureColdStart()
console.log(
  (coldStart <= COLD_START_BUDGET_MS ? 'ℹ' : '⚠') +
    ' cold start: ' + coldStart.toFixed(0) + ' ms median of 5 (budget ' + COLD_START_BUDGET_MS + ' ms, not enforced)',
)
console.log('')
console.log(checks.length + ' checked - ' + failed + ' failed')
console.log('')
process.exit(failed === 0 ? 0 : 1)
