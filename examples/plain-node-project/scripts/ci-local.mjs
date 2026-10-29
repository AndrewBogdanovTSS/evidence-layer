// `npm run ci:local` - what this project's CI would report, before you push.
//
//   npm run ci:local                         # against origin/main, or main when there is no remote
//   npm run ci:local -- --base main          # against a base you name
//   npm run ci:local -- --review-skeleton    # review = the bundle's suggested claims; no model
//   npm run ci:local -- --review notes.md    # review = a file you wrote; no model
//   npm run ci:local -- --no-review          # the two required jobs only
//   npm run ci:local -- --pipeline azure     # azure-pipelines.yml's jobs, not the GitHub workflow's
//
// It runs the jobs of .github/workflows/ci.yml - or, with `--pipeline azure`,
// of azure-pipelines.yml; without the option, whichever of the two exists,
// GitHub's when both do - in the order and shape CI does:
// `evidence` and `governance` side by side, then - only once `evidence`
// passed - `review`, whose checks read the bundle from a separate directory,
// the way the review job reads the artifact the evidence job uploaded. So a
// review that cites a block the gather did not write fails here as it would
// there, and a broken suite stops the review before it costs a token.
//
// The review job's model step is read out of the pipeline, not written here a
// second time: a copy would drift, and a local run that asks the model
// something CI does not is a simulation of nothing. From the GitHub workflow,
// that is the action's `prompt`, `claude_args` and `settings`; from the
// Azure pipeline, the words of its `claude -p` script step, as the shell
// would split them. Anything a local run cannot evaluate (a secret, a pipeline
// expression, a shell expansion other than `$NAME` from the step's own env or
// `${NAME:-default}`) is refused rather than guessed. The repository's
// REVIEW_MODEL variable is read from the environment, as `REVIEW_MODEL=...`.
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
// the pipeline could not be read.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PIPELINES = { github: '.github/workflows/ci.yml', azure: 'azure-pipelines.yml' }

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
const known = new Set(['--base', '--review', '--review-skeleton', '--no-review', '--pipeline'])
for (const [i, a] of argv.entries()) {
  if (a.startsWith('--') && !known.has(a)) usage('unknown option ' + a)
  if (!a.startsWith('--') && !['--base', '--review', '--pipeline'].includes(argv[i - 1])) usage('unexpected argument ' + a)
}
const asked = value('pipeline')
if (asked !== undefined && !Object.hasOwn(PIPELINES, asked)) usage('--pipeline is github or azure, not ' + asked)
const pipeline = asked ?? (existsSync(join(project, PIPELINES.github)) || !existsSync(join(project, PIPELINES.azure)) ? 'github' : 'azure')
const PIPELINE = join(project, PIPELINES[pipeline])
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
// The review job's model step, as the pipeline writes it

/** The lines of the YAML list item that starts at `at`, its `- ` blanked so its first key reads like the rest. */
function stepAt(lines, at) {
  const indent = lines[at].indexOf('-')
  const step = [lines[at].slice(0, indent) + ' ' + lines[at].slice(indent + 1)]
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() !== '' && l.search(/\S/) <= indent) break
    step.push(l)
  }
  return step
}

/** A `key: |` block in a step, its lines with their common indentation removed, or a one-line `key: 'value'`. */
function valueOf(step, key) {
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

/** The GitHub workflow: the `uses: anthropics/claude-code-action` step's inputs, and the review file the next check names. */
function readGithubReviewStep(text) {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((l) => /^\s*- uses: anthropics\/claude-code-action@/.test(l))
  if (at === -1) return { broken: 'no `uses: anthropics/claude-code-action` step' }
  const step = stepAt(lines, at)
  const inputs = { prompt: valueOf(step, 'prompt'), args: valueOf(step, 'claude_args'), settings: valueOf(step, 'settings') }
  if (!inputs.prompt || !inputs.args) return { broken: 'the claude-code-action step has no `prompt` or no `claude_args`' }
  // The first `claims:` after the model step: the file the review job checks and posts.
  const after = lines.slice(at + step.length).find((l) => /^\s*claims:\s*\S/.test(l))
  const review = after?.split(':')[1].trim()
  if (!review) return { broken: 'no `claims:` check after the claude-code-action step names the review file' }

  for (const key of Object.keys(inputs)) {
    if (inputs[key] === undefined) continue
    // `${{ vars.NAME || 'default' }}` from the environment; anything else a local run cannot evaluate.
    const done = inputs[key].replace(/\$\{\{\s*vars\.([A-Za-z_]\w*)\s*\|\|\s*'([^']*)'\s*\}\}/g, (_, name, fallback) => process.env[name] || fallback)
    if (done.includes('${{')) return { broken: 'the step\'s ' + key + ' uses ' + done.slice(done.indexOf('${{')).split('}}')[0] + '}}, which only CI can evaluate' }
    inputs[key] = done
  }
  if (/["']/.test(inputs.args)) return { broken: 'the step\'s claude_args quote a value, which this reads as separate words - unquote it' }
  const argv = ['-p', inputs.prompt, ...inputs.args.split(/\s+/).filter(Boolean)]
  if (inputs.settings !== undefined) argv.push('--settings', inputs.settings)
  return { argv, review }
}

/**
 * A command's words as sh would split and expand them, for the forms a model
 * step needs and no others: single quotes, double quotes, `\` before a
 * newline, and inside double quotes `$NAME` from the step's env or
 * `${NAME:-default}` from the environment - how a pipeline variable reaches
 * a script. Anything else sh would interpret is refused, never guessed.
 */
function shellWords(command, stepEnv) {
  const expand = (text, at) => {
    const fallback = /^\$\{([A-Za-z_]\w*):-([^}$`"'\\]*)\}/.exec(text.slice(at))
    if (fallback) return { value: stepEnv(fallback[1]) ?? (process.env[fallback[1]] || fallback[2]), length: fallback[0].length }
    const plain = /^\$([A-Za-z_]\w*)/.exec(text.slice(at))
    const value = plain ? stepEnv(plain[1]) : undefined
    if (value === undefined || value === null) return { cannot: plain ? '$' + plain[1] + ', which the step\'s env does not set' : text.slice(at, at + 2) }
    return { value, length: plain[0].length }
  }
  const text = command.replace(/\\\r?\n/g, ' ')
  if (text.trim().includes('\n')) return { cannot: 'more than one command' }
  const words = []
  let word = null
  for (let i = 0; i < text.length; ) {
    const c = text[i]
    if (/\s/.test(c)) {
      if (word !== null) words.push(word)
      word = null
      i++
      continue
    }
    word ??= ''
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      if (end === -1) return { cannot: 'an unclosed quote' }
      word += text.slice(i + 1, end)
      i = end + 1
    } else if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; ) {
        if (text[i] === '\\' && /["\\$`]/.test(text[i + 1] ?? '')) {
          word += text[i + 1]
          i += 2
        } else if (text[i] === '$') {
          const e = expand(text, i)
          if ('cannot' in e) return e
          word += e.value
          i += e.length
        } else if (text[i] === '`') {
          return { cannot: '`' }
        } else word += text[i++]
      }
      if (text[i] !== '"') return { cannot: 'an unclosed quote' }
      i++
    } else if (/[$`\\;&|<>(){}[\]*?~#]/.test(c)) {
      return { cannot: c === '$' ? 'an unquoted expansion' : c }
    } else word += text[i++]
  }
  if (word !== null) words.push(word)
  return { words }
}

/** The Azure pipeline: the `bash:` or `script:` step that runs `claude -p`, and the review file the next check names. */
function readAzureReviewStep(text) {
  const lines = text.split(/\r?\n/)
  for (let at = 0; at < lines.length; at++) {
    if (!/^\s*- (?:bash|script):\s*\|\s*$/.test(lines[at])) continue
    const step = stepAt(lines, at)
    const body = valueOf(step, 'bash') ?? valueOf(step, 'script') ?? ''
    if (!/^claude\s+-p\s/.test(body)) continue
    // The step's own env, as Azure hands it to the script: a value still holding a macro was never evaluated here.
    const stepEnv = (name) => {
      const value = valueOf(step, name)
      if (value === undefined) return undefined
      return /\$\(|\$\[|\$\{\{/.test(value) ? null : value
    }
    const parsed = shellWords(body, stepEnv)
    if ('cannot' in parsed) return { broken: 'the `claude -p` step uses ' + parsed.cannot + ', which this does not evaluate' }
    const review = lines.slice(at + step.length).map((l) => /evidence-layer claims (\S+)/.exec(l)?.[1]).find(Boolean)
    if (!review) return { broken: 'no `evidence-layer claims` check after the `claude -p` step names the review file' }
    return { argv: parsed.words.slice(1), review }
  }
  return { broken: 'no `bash:` step that runs `claude -p`' }
}

if (!existsSync(PIPELINE)) usage('no ' + PIPELINES[pipeline] + ' - this runs the jobs that pipeline defines')
const reviewStep = (pipeline === 'github' ? readGithubReviewStep : readAzureReviewStep)(readFileSync(PIPELINE, 'utf8'))
if ('broken' in reviewStep) usage('cannot read the review job from ' + PIPELINES[pipeline] + ': ' + reviewStep.broken)

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

console.log('ci:local - the jobs of ' + PIPELINES[pipeline] + ', at ' + head.slice(0, 10) + ' against ' + base)
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
    const model = await run('claude', reviewStep.argv)
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
