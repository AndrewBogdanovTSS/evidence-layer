// `npm run ci:local` - what this project's CI would report, before you push.
//
//   npm run ci:local                         # against origin/main, or main when there is no remote
//   npm run ci:local -- --base main          # against a base you name
//   npm run ci:local -- --review-skeleton    # review = the bundle's suggested claims; no model
//   npm run ci:local -- --review notes.md    # review = a file you wrote; no model
//   npm run ci:local -- --no-review          # the two required jobs only
//
// It runs the jobs of .github/workflows/ci.yml in the order and shape CI does:
// `evidence` and `governance` side by side, then - only once `evidence`
// passed - `review`, whose checks read the bundle from a separate directory,
// the way the review job reads the artifact the evidence job uploaded. So a
// review that cites a block the gather did not write fails here as it would
// there, and a broken suite stops the review before it costs a token.
//
// The review job's model step - its prompt, its `claude_args` and its
// settings - is read out of the workflow, not written here a second time: a
// copy would drift, and a local run that asks the model something CI does not
// is a simulation of nothing. Anything in those inputs a local run cannot
// evaluate (a secret, an expression other than `vars.NAME || 'default'`) is
// refused rather than guessed. `vars.REVIEW_MODEL` is read from the
// environment, as `REVIEW_MODEL=...`.
//
// What it deliberately does not do:
//   - check out a clean copy or run `npm ci`. It runs on this working tree and
//     its node_modules, so an uncommitted edit is in the evidence - the bundle
//     says so, and so does the summary below - where CI would not have it.
//   - post the review, or make anything a required check. It prints the review
//     and says which jobs CI requires.
//   - run the model on an empty diff. CI would; locally that is usually a run
//     on the base branch itself, and tokens spent on reviewing nothing.
//
// It refuses to run inside evidence-layer's checkout, where git answers for
// evidence-layer rather than this project - make a copy with `npm run
// standalone` first. Every command gets its arguments as a list, never through
// a shell, except `npm` on Windows, where the base is refused if cmd.exe would
// read anything in it.
//
// Exit codes: 0 every job that ran passed - 1 a job failed - 2 bad usage, or
// the workflow could not be read.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = join(project, '.github', 'workflows', 'ci.yml')

function usage(message) {
  console.error('ci:local: ' + message)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Arguments

const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const value = (name) => {
  const i = argv.indexOf('--' + name)
  if (i === -1) return undefined
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) usage('--' + name + ' needs a value')
  return v
}
const known = new Set(['--base', '--review', '--review-skeleton', '--no-review'])
for (const [i, a] of argv.entries()) {
  if (a.startsWith('--') && !known.has(a)) usage('unknown option ' + a)
  if (!a.startsWith('--') && !['--base', '--review'].includes(argv[i - 1])) usage('unexpected argument ' + a)
}
const reviewFile = value('review')
const reviewMode = flag('no-review') ? 'none' : flag('review-skeleton') ? 'skeleton' : reviewFile ? 'file' : 'model'
if ([flag('no-review'), flag('review-skeleton'), reviewFile !== undefined].filter(Boolean).length > 1) {
  usage('--no-review, --review-skeleton and --review are alternatives - give one')
}
if (reviewFile !== undefined && !existsSync(reviewFile)) usage('no such review file: ' + reviewFile)

// ---------------------------------------------------------------------------
// Where we are

const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const tryGit = (...args) => {
  try {
    return git(...args)
  } catch {
    return null
  }
}

const top = tryGit('rev-parse', '--show-toplevel')
if (top === null || resolve(top) !== project) {
  usage(
    'this project is not a repository of its own here, so git would answer for ' + (top ?? 'nothing') +
      ' - run `npm run standalone` and use ci:local in the copy it makes',
  )
}

const resolves = (ref) => tryGit('rev-parse', '--verify', '--quiet', '--end-of-options', ref + '^{commit}') !== null
const named = value('base')
const base = named ?? (resolves('origin/main') ? 'origin/main' : resolves('main') ? 'main' : undefined)
if (base === undefined) usage('neither origin/main nor main resolves here - name the base with --base <ref>')
if (!resolves(base)) usage('--base ' + base + ' is not a commit here')
if (process.platform === 'win32' && /["%!^&|<>\r\n]/.test(base)) usage('cannot pass "' + base + '" through cmd.exe to npm')

const head = git('rev-parse', 'HEAD')
const dirty = git('status', '--porcelain') !== ''

// The installed evidence-layer's CLI, the one the action runs in CI.
let cli
try {
  const manifestPath = createRequire(join(project, 'package.json')).resolve('evidence-layer/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  cli = join(dirname(manifestPath), manifest.bin['evidence-layer'])
  if (!manifest.evidenceLayer?.claimsAgainst?.includes('bundle')) {
    usage('the installed evidence-layer ' + manifest.version + ' cannot check a review against a bundle - upgrade it')
  }
} catch (error) {
  if (error?.code === 'MODULE_NOT_FOUND') usage('evidence-layer is not installed here - run `npm install`')
  throw error
}

// ---------------------------------------------------------------------------
// The review job's model step, as the workflow writes it

/** The `with:` inputs of the `uses: anthropics/claude-code-action` step, and the review file the next check names. */
function readReviewStep(text) {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((l) => /^\s*- uses: anthropics\/claude-code-action@/.test(l))
  if (at === -1) return { broken: 'no `uses: anthropics/claude-code-action` step' }
  const stepIndent = lines[at].indexOf('-')
  const step = []
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() !== '' && l.search(/\S/) <= stepIndent) break
    step.push(l)
  }
  /** A `key: |` block, its lines with their common indentation removed, or a one-line `key: 'value'`. */
  const input = (key) => {
    const i = step.findIndex((l) => new RegExp('^\\s*' + key + ':').test(l))
    if (i === -1) return undefined
    const keyIndent = step[i].search(/\S/)
    const rest = step[i].slice(step[i].indexOf(':') + 1).trim()
    if (rest !== '|') return rest.startsWith("'") && rest.endsWith("'") ? rest.slice(1, -1).replace(/''/g, "'") : rest
    const body = []
    for (const l of step.slice(i + 1)) {
      if (l.trim() !== '' && l.search(/\S/) <= keyIndent) break
      body.push(l)
    }
    const indent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)))
    return body.map((l) => l.slice(indent)).join('\n').trim()
  }
  const prompt = input('prompt')
  const args = input('claude_args')
  if (!prompt || !args) return { broken: 'the claude-code-action step has no `prompt` or no `claude_args`' }
  // The first `claims:` after the model step: the file the review job checks and posts.
  const after = lines.slice(at + 1 + step.length).find((l) => /^\s*claims:\s*\S/.test(l))
  const review = after?.split(':')[1].trim()
  if (!review) return { broken: 'no `claims:` check after the claude-code-action step names the review file' }
  return { prompt, args, settings: input('settings'), review }
}

/** `${{ vars.NAME || 'default' }}` from the environment; anything else a local run cannot evaluate. */
function evaluate(text) {
  const done = text.replace(/\$\{\{\s*vars\.([A-Za-z_]\w*)\s*\|\|\s*'([^']*)'\s*\}\}/g, (_, name, fallback) => process.env[name] || fallback)
  return done.includes('${{') ? { cannot: done.slice(done.indexOf('${{')).split('}}')[0] + '}}' } : { text: done }
}

if (!existsSync(WORKFLOW)) usage('no ' + WORKFLOW + ' - this runs the jobs that workflow defines')
const reviewStep = readReviewStep(readFileSync(WORKFLOW, 'utf8'))
if ('broken' in reviewStep) usage('cannot read the review job from ' + WORKFLOW + ': ' + reviewStep.broken)
const modelInputs = {}
for (const key of ['prompt', 'args', 'settings']) {
  if (reviewStep[key] === undefined) continue
  const result = evaluate(reviewStep[key])
  if ('cannot' in result) usage('the review step\'s ' + key + ' uses ' + result.cannot + ', which only CI can evaluate')
  modelInputs[key] = result.text
}
if (/["']/.test(modelInputs.args)) usage('the review step\'s claude_args quote a value, which this reads as separate words - unquote it')

// ---------------------------------------------------------------------------
// Running jobs

/** Runs a command, its output captured; resolves to the exit code and the output, never rejects. */
function run(command, args, opts = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: project, shell: opts.shell ?? false, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    child.on('error', (error) => done({ code: null, output: output + error.message + '\n', error }))
    child.on('close', (code) => done({ code, output }))
  })
}

const evidenceLayer = (...args) => run(process.execPath, [cli, ...args])
const npm = (...args) => run('npm', args, { shell: process.platform === 'win32' })

function section(title, output) {
  console.log('\n=== ' + title + ' ' + '='.repeat(Math.max(0, 66 - title.length)))
  process.stdout.write(output.endsWith('\n') || output === '' ? output : output + '\n')
}

const results = []
const record = (job, required, status, why) => results.push({ job, required, status, why })

console.log('ci:local - the jobs of .github/workflows/ci.yml, at ' + head.slice(0, 10) + ' against ' + base)
if (dirty) console.log('the working tree has uncommitted changes: they are in this evidence, and would not be in CI\'s')
console.log('running evidence and governance side by side, as CI does...')

// The artifact: what the evidence job uploads, kept apart from the working
// tree so the review's checks read the uploaded copy, not the local file.
const artifact = mkdtempSync(join(tmpdir(), 'ci-local-artifact-'))
writeFileSync(join(project, 'change.diff'), git('diff', base + '...HEAD') + '\n')

const [evidence, governance] = await Promise.all([
  npm('run', 'evidence', '--', '--base', base),
  evidenceLayer('governance', '--enforce', '--no-journal'),
])

section('evidence', evidence.output)
const bundlePath = join(project, 'evidence.local.md')
if (evidence.code === 0 && existsSync(bundlePath)) {
  record('evidence', true, 'pass')
} else {
  record('evidence', true, 'fail', evidence.error ? evidence.error.message : 'exit ' + evidence.code)
}
for (const file of ['evidence.local.md', 'change.diff']) {
  if (existsSync(join(project, file))) copyFileSync(join(project, file), join(artifact, file))
}

// The JSON block is for a program reading CI's log; the report above it is the same findings for a person.
section('governance', governance.output.replace(/---GOVERNANCE-JSON-BEGIN---[\s\S]*---GOVERNANCE-JSON-END---\n?/, '(its JSON report block, for a program, left out)\n'))
record('governance', true, governance.code === 0 ? 'pass' : 'fail', governance.code === 0 ? undefined : 'exit ' + governance.code)

// ---------------------------------------------------------------------------
// The review job

const reviewPath = join(project, reviewStep.review)
const skip = (why) => record('review', false, 'skipped', why)

if (reviewMode === 'none') skip('--no-review')
else if (results[0].status !== 'pass') skip('it needs evidence, which did not pass')
else if (reviewMode === 'model' && readFileSync(join(artifact, 'change.diff'), 'utf8').trim() === '') skip('nothing changed between ' + base + ' and HEAD - no model run for an empty diff')
else {
  // A runner starts without one: a review left by an earlier run must not
  // stand in for a model step that wrote nothing.
  rmSync(reviewPath, { force: true })
  let wrote
  if (reviewMode === 'skeleton') {
    // What the model is asked to copy, standing in for it: the bundle's suggested claims.
    const bundle = readFileSync(join(artifact, 'evidence.local.md'), 'utf8')
    const suggested = /^## Suggested claims\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(bundle)?.[1]
    wrote = suggested ? (writeFileSync(reviewPath, suggested.trim() + '\n'), 'the bundle\'s suggested claims') : undefined
    if (!wrote) skip('the bundle suggests no claims to stand in for a review')
  } else if (reviewMode === 'file') {
    copyFileSync(reviewFile, reviewPath)
    wrote = reviewFile
  } else {
    console.log('\nrunning the review job\'s model step - this spends tokens, as it does in CI...')
    const args = ['-p', modelInputs.prompt, ...modelInputs.args.split(/\s+/).filter(Boolean)]
    if (modelInputs.settings !== undefined) args.push('--settings', modelInputs.settings)
    const model = await run('claude', args)
    section('review: the model', model.output)
    if (model.error?.code === 'ENOENT') skip('no `claude` on PATH - install Claude Code, or pass --review-skeleton or --review <file>')
    else if (model.code !== 0) record('review', false, 'fail', 'the model step exited ' + model.code)
    else if (!existsSync(reviewPath)) record('review', false, 'fail', 'the model wrote no ' + reviewStep.review)
    else wrote = 'the model'
  }

  if (wrote) {
    const bundle = join(artifact, 'evidence.local.md')
    const fixed = await evidenceLayer('claims', reviewStep.review, '--bundle', bundle, '--sha', head, '--fix')
    section('review: mark what the evidence does not back UNVERIFIED', fixed.output)
    const checked = await evidenceLayer('claims', reviewStep.review, '--bundle', bundle, '--sha', head)
    section('review: the review, held to the bundle', checked.output)
    section('review: what CI would post as the pull request comment', readFileSync(reviewPath, 'utf8'))
    record('review', false, checked.code === 0 && fixed.code === 0 ? 'pass' : 'fail', (checked.code !== 0 ? 'exit ' + checked.code + ', ' : '') + 'review from ' + wrote)
  }
}

// ---------------------------------------------------------------------------
// The summary

console.log('\n=== what CI would report ' + '='.repeat(43))
for (const r of results) {
  console.log('  ' + r.job.padEnd(12) + (r.required ? 'required' : 'optional').padEnd(10) + r.status + (r.why ? ' - ' + r.why : ''))
}
console.log('\nthe bundle and the diff, as the evidence job would upload them: ' + artifact)
if (dirty) console.log('uncommitted changes were part of this run; CI runs on the commit')
process.exit(results.some((r) => r.status === 'fail') ? 1 : 0)
