/**
 * The GitHub Action: runs evidence-layer's checks in a workflow step, with
 * `--format github`, so every finding that is not a pass becomes an annotation
 * and the step's summary lists them.
 *
 * Which evidence-layer it runs, in order:
 *
 *   1. the one the project installed (`node_modules/evidence-layer`) - the
 *      version the project chose, the one its developers run locally, so CI
 *      and a laptop give the same verdict;
 *   2. this checkout's own build, when the project *is* evidence-layer - how
 *      this repository runs its action on itself;
 *   3. otherwise `npx evidence-layer@<version>`, where the version is the one
 *      this action was released with (or the `version` input). Pinned, never
 *      `latest`: a workflow that names `@v0.7.0` gets 0.7.0's checks next year.
 *
 * It does not carry a copy of the checks. A copy would be a second build of
 * the package, published by a different route, without the provenance the npm
 * release has.
 *
 * Dependency-free and with no build step, because an action runs straight from
 * the repository at the ref the workflow names, and `dist/` is not committed.
 *
 * Exit codes are the checks' own: the worst of them, with bad usage (2) ranked
 * first - a misconfigured step must not pass for a clean one - then error (1),
 * then flaky (3).
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FORMAT_CAPABILITY = 'github'
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const input = (name) => (process.env['INPUT_' + name.toUpperCase()] ?? '').trim()
const list = (value) => value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
const workspace = process.env.GITHUB_WORKSPACE || process.cwd()
const actionRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Ends the step as misconfigured: an annotation saying why, and exit 2. */
function misconfigured(message) {
  console.log('::error title=evidence-layer::' + message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'))
  finish(2)
}

function finish(code) {
  const conclusion = { 0: 'success', 1: 'failure', 2: 'misconfigured', 3: 'flaky' }[code] ?? 'failure'
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'exit-code=' + code + '\nconclusion=' + conclusion + '\n')
  process.exit(code)
}

/** `{ command, prefix, source }` - what to spawn, and a sentence saying which evidence-layer it is. */
function resolveCli() {
  const installed = join(workspace, 'node_modules', 'evidence-layer', 'package.json')
  const manifest = existsSync(installed) ? readJson(installed) : null
  if (manifest) {
    // A capability, not a version comparison - the same rule the plugin's
    // launcher follows. An older package would ignore `--format github` and
    // print plain text, and the step would look like it worked.
    if (!manifest.evidenceLayer?.outputFormats?.includes(FORMAT_CAPABILITY)) {
      misconfigured(
        'the installed evidence-layer ' + (manifest.version ?? '') + ' cannot write GitHub annotations - upgrade it to 0.7.0 or later',
      )
    }
    // The same rule for `--bundle`: an older package would ignore the flag,
    // check nothing against the bundle, and pass.
    if (input('bundle') && !manifest.evidenceLayer?.claimsAgainst?.includes('bundle')) {
      misconfigured('the installed evidence-layer ' + (manifest.version ?? '') + ' cannot check claims against a bundle - upgrade it')
    }
    const bin = join(dirname(installed), manifest.bin?.['evidence-layer'] ?? 'dist/bin/evidence-layer.mjs')
    return { command: process.execPath, prefix: [bin], source: 'evidence-layer ' + manifest.version + ', installed in the project' }
  }

  const own = readJson(join(workspace, 'package.json'))
  const ownBin = join(workspace, 'dist', 'bin', 'evidence-layer.mjs')
  if (own?.name === 'evidence-layer') {
    if (!existsSync(ownBin)) misconfigured('this is evidence-layer\'s own repository, and it is not built - run `pnpm build` before this step')
    return { command: process.execPath, prefix: [ownBin], source: 'this checkout\'s build of evidence-layer ' + own.version }
  }

  const version = input('version') || readJson(join(actionRoot, 'package.json'))?.version
  if (!version || !EXACT_VERSION.test(version)) misconfigured('`version` must be an exact version like 0.7.0, got "' + (version ?? '') + '"')
  return { command: 'npx', prefix: ['--yes', 'evidence-layer@' + version], source: 'evidence-layer ' + version + ', from npm' }
}

/**
 * `npx` on Windows is `npx.cmd`, which Node runs only through a shell. The
 * arguments are the workflow's own inputs, not review text, but a shell is
 * still a shell: anything it would interpret is refused rather than escaped.
 */
function spawnCli(cli, args) {
  const viaShell = process.platform === 'win32' && cli.command === 'npx'
  const argv = [...cli.prefix, ...args]
  if (viaShell) {
    const unsafe = argv.find((a) => /["%!^&|<>\r\n]/.test(a))
    if (unsafe !== undefined) misconfigured('cannot pass "' + unsafe + '" through cmd.exe to npx - rename it, or install evidence-layer in the project')
  }
  const result = spawnSync(cli.command, viaShell ? argv.map((a) => '"' + a + '"') : argv, {
    cwd: workspace,
    stdio: 'inherit',
    shell: viaShell,
  })
  if (result.error) misconfigured('could not run ' + cli.command + ': ' + result.error.message)
  return result.status ?? 1
}

const strict = input('strict') === 'true'
// Passed as their own arguments, never spliced into one: a path is not a flag.
const against = [
  ...(input('bundle') ? ['--bundle', input('bundle')] : []),
  ...(input('sha') ? ['--sha', input('sha')] : []),
]
const runs = [
  ...list(input('claims')).map((path) => ['claims', path, ...against, '--format', 'github', ...(strict ? ['--strict'] : [])]),
  ...list(input('receipt')).map((path) => ['receipt', path, '--format', 'github', ...(strict ? ['--strict'] : [])]),
  ...(input('governance') === 'true' ? [['governance', '--enforce', '--no-journal', '--format', 'github']] : []),
]
if (runs.length === 0) misconfigured('nothing to check - set `claims`, `receipt` or `governance`')

const cli = resolveCli()
console.log('Running ' + cli.source + '.')
const codes = runs.map((args) => spawnCli(cli, args))
finish(codes.includes(2) ? 2 : codes.includes(1) ? 1 : codes.includes(3) ? 3 : codes.find((c) => c !== 0) ?? 0)
