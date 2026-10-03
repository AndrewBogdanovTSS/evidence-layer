/**
 * `pnpm check:ladder [<commit>]` - did this commit climb the ladder it says it
 * climbed?
 *
 * The decision ladder (does it need to exist / is it already here / does the
 * platform do it / does an installed dependency / only then the minimum) is an
 * instruction to whoever writes the change, and an instruction an agent says it
 * followed is a self-report. This turns the parts of it that can fail
 * deterministically into claims:
 *
 * 1. **The trailer.** A commit names the rung that held in its own message -
 *    `Ladder-Rung: 2 reuse formatPrice` - read by git itself, the same way
 *    `Missed-By:` is. Each rung's one machine-checkable consequence is checked:
 *    rung 2, the named symbol already existed, the diff uses it, and the diff
 *    adds no renamed copy of it; rung 3, no manifest changed; rung 4, the
 *    dependency was already declared and still is. Rungs 1 and 5 are judgement,
 *    and are reported `unverifiable` - not passed.
 * 2. **The clone check.** Every function the diff adds is compared with every
 *    function in the tree, up to renaming: identifiers are replaced by their
 *    order of first appearance, property names are kept. A function that is an
 *    existing one with its names changed is an error, whatever the trailer says.
 *
 * Why the clone check is written here rather than installed: the off-the-shelf
 * detector tried first (jscpd 4.3) matches exact token sequences, and the copy
 * an agent actually writes renames its parameters - tested, missed. The parser
 * is TypeScript's own, already a devDependency, so nothing new is installed.
 *
 * Read entirely from git - the commit, its parent, the files at each - so it
 * checks commits that are not checked out, which is what the demo refs are.
 * Repository business, not portable core, same as `check-docs.ts`: which files
 * count as source and how big a function must be to count as a copy are this
 * repository's calls.
 *
 * Exit codes: 0 clean - 1 at least one error - 2 bad usage.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { exitCodeFor, help, parseArgs, report, usage } from '../src/index'
import type { Finding } from '../src/index'

const HELP = `
pnpm check:ladder [<commit>] [--repo <path>]

Checks the commit's Ladder-Rung trailers against its diff, and every function
the diff adds against every function in the tree, up to renaming.

  <commit>  default HEAD; any revision git resolves (demo/ladder-bad works)
  --repo    repository root (default: the one this script lives in)

exit 0 = clean, 1 = at least one error, 2 = bad usage
`

const SOURCE = /\.(?:[cm]?js|[cm]?ts)$/
const IGNORED = /(?:^|\/)(?:node_modules|dist)\//
/** Below this, two functions agreeing says more about the language than about copying. */
const MIN_TOKENS = 12

interface Fn {
  name: string
  file: string
  line: number
  endLine: number
  shape: string
  tokens: number
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { ok: res.status === 0, out: (res.stdout ?? '').replace(/\r\n/g, '\n') }
}

/**
 * The names a function binds itself - parameters, and anything declared inside
 * it. Only these are renamed. A free name (an import, a global, a call to some
 * other function) is part of what the function does: renaming those too made
 * every one-line test callback "a copy" of every other one, which the first run
 * against this repository's own history showed within twenty-five commits.
 */
function boundNames(fn: ts.SignatureDeclaration): Set<string> {
  const bound = new Set<string>()
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) bound.add(name.text)
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) bind(node.name)
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) bound.add(node.name.text)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(fn, visit)
  return bound
}

/** A function's parameters and body as tokens, its own bound names renamed by order of first appearance. */
function shapeOf(sf: ts.SourceFile, fn: ts.SignatureDeclaration, from: number, to: number): { shape: string; tokens: number } {
  const bound = boundNames(fn)
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, sf.languageVariant, sf.text.slice(from, to))
  const names = new Map<string, string>()
  const out: string[] = []
  let previous = ts.SyntaxKind.Unknown
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const text = scanner.getTokenText()
    const isName = kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.PrivateIdentifier
    const isProperty = previous === ts.SyntaxKind.DotToken || previous === ts.SyntaxKind.QuestionDotToken
    if (isName && !isProperty && bound.has(text)) {
      if (!names.has(text)) names.set(text, '$' + (names.size + 1))
      out.push(names.get(text)!)
    } else {
      out.push(text)
    }
    previous = kind
  }
  return { shape: out.join(' '), tokens: out.length }
}

function nameOf(node: ts.Node): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) return node.name.getText()
  const parent = node.parent
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent))) return parent.name.getText()
  return '<anonymous>'
}

function functionsIn(file: string, text: string): Fn[] {
  const kind = /ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const found: Fn[] = []
  const visit = (node: ts.Node): void => {
    const isFn =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    // Named functions only. A copied helper has a name - that is what makes it
    // a helper - while an anonymous callback is shaped by the call it is passed
    // to, and two of them agreeing is the API talking, not someone copying.
    const name = isFn ? nameOf(node) : '<anonymous>'
    if (isFn && node.body && name !== '<anonymous>') {
      // From the opening parenthesis on: the function's own name is a property
      // of where it lives, not of what it does, so it is not part of its shape.
      const { shape, tokens } = shapeOf(sf, node, node.parameters.pos - 1, node.body.end)
      found.push({
        name,
        file,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        endLine: sf.getLineAndCharacterOfPosition(node.end).line + 1,
        shape,
        tokens,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function functionsAt(repo: string, rev: string): Fn[] {
  const files = git(repo, ['ls-tree', '-r', '--name-only', rev]).out.split('\n')
  return files
    .filter((f) => SOURCE.test(f) && !IGNORED.test(f) && !f.endsWith('.d.ts'))
    .flatMap((f) => functionsIn(f, git(repo, ['show', rev + ':' + f]).out))
}

interface Diff {
  /** Added line numbers in the new file, per path. */
  added: Map<string, Set<number>>
  /** The text of every added line, all files. */
  addedText: string
  files: string[]
}

function diffOf(repo: string, parent: string, rev: string): Diff {
  const raw = git(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', parent, rev]).out
  const added = new Map<string, Set<number>>()
  const addedLines: string[] = []
  let file = ''
  let line = 0
  for (const l of raw.split('\n')) {
    const path = /^\+\+\+ b\/(.+)$/.exec(l)
    if (path) {
      file = path[1]!
      added.set(file, new Set())
      continue
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,\d+)? @@/.exec(l)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (l.startsWith('+') && !l.startsWith('+++') && file) {
      added.get(file)!.add(line++)
      addedLines.push(l.slice(1))
    }
  }
  const files = git(repo, ['diff', '--name-only', parent, rev]).out.split('\n').filter(Boolean)
  return { added, addedText: addedLines.join('\n'), files }
}

type Deps = Record<string, string>

function manifestDeps(repo: string, rev: string, file: string): Deps | null {
  const res = git(repo, ['show', rev + ':' + file])
  if (!res.ok) return null
  const pkg = JSON.parse(res.out) as { dependencies?: Deps; devDependencies?: Deps; peerDependencies?: Deps }
  return { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies }
}

function manifestsChanged(repo: string, parent: string, rev: string, diff: Diff): string[] {
  return diff.files
    .filter((f) => f === 'package.json' || f.endsWith('/package.json'))
    .filter((f) => JSON.stringify(manifestDeps(repo, parent, f)) !== JSON.stringify(manifestDeps(repo, rev, f)))
}

interface Clone {
  copy: Fn
  original: Fn
}

function findClones(added: Fn[], all: Fn[]): Clone[] {
  return added.flatMap((copy) => {
    const original = all.find((fn) => fn.shape === copy.shape && !(fn.file === copy.file && fn.line === copy.line))
    return original ? [{ copy, original }] : []
  })
}

const where = (fn: Fn) => fn.file + ':' + fn.line

function checkRung(
  value: string,
  ctx: { repo: string; parent: string; rev: string; diff: Diff; clones: Clone[] },
): Finding {
  const claim = 'Ladder-Rung: ' + value
  const match = /^([1-5])\s*(\S+)?\s*(\S+)?/.exec(value)
  if (!match) {
    return { level: 'error', claim, detail: 'not a rung - expected a number from 1 to 5, a verb and what it names' }
  }
  const rung = Number(match[1])
  const subject = match[3] ?? match[2]
  const mentioned = subject !== undefined && new RegExp('\\b' + subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(ctx.diff.addedText)

  if (rung === 1 || rung === 5) {
    return {
      level: 'unverifiable',
      claim,
      detail:
        rung === 1
          ? 'whether it needed to exist is judgement - review it, nothing here can'
          : 'the minimum is judgement - the tests say it works, not that it is minimal',
    }
  }

  if (rung === 2) {
    if (!subject) return { level: 'error', claim, detail: 'rung 2 has to name what was reused' }
    const existed = git(ctx.repo, ['grep', '-q', '-w', '-F', subject, ctx.parent, '--']).ok
    if (!existed) {
      return { level: 'error', claim, detail: subject + ' does not exist before this commit - it was not already here' }
    }
    if (!mentioned) return { level: 'error', claim, detail: 'the diff never uses ' + subject }
    const copies = ctx.clones.filter((c) => c.original.name === subject)
    if (copies.length > 0) {
      return {
        level: 'error',
        claim,
        detail: copies.map((c) => c.copy.name + ' (' + where(c.copy) + ') is ' + subject + ' renamed').join('; '),
      }
    }
    return { level: 'pass', claim, detail: subject + ' existed, the diff uses it, and adds no copy of it' }
  }

  const changed = manifestsChanged(ctx.repo, ctx.parent, ctx.rev, ctx.diff)
  if (changed.length > 0) {
    return { level: 'error', claim, detail: 'dependencies changed in ' + changed.join(', ') + ' - rung ' + rung + ' installs nothing' }
  }
  if (rung === 4) {
    if (!subject) return { level: 'error', claim, detail: 'rung 4 has to name the dependency' }
    const declared = manifestDeps(ctx.repo, ctx.parent, 'package.json') ?? {}
    if (!(subject in declared)) {
      return { level: 'error', claim, detail: subject + ' is not a declared dependency of this repository' }
    }
  }
  if (subject && !mentioned) return { level: 'error', claim, detail: 'the diff never uses ' + subject }
  return { level: 'pass', claim, detail: 'no dependency added' + (subject ? ', and the diff uses ' + subject : '') }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) help(HELP)
  const here = fileURLToPath(new URL('.', import.meta.url))
  const repo = typeof args.repo === 'string' ? args.repo : join(here, '..')
  const target = args._[0] ?? 'HEAD'

  const rev = git(repo, ['rev-parse', '--verify', '--quiet', target + '^{commit}'])
  if (!rev.ok) usage('not a commit: ' + target + '\n' + HELP)
  const sha = rev.out.trim()
  const parentRes = git(repo, ['rev-parse', '--verify', '--quiet', sha + '^'])
  const findings: Finding[] = []

  if (!parentRes.ok) {
    findings.push({ level: 'unverifiable', claim: 'the commit has a parent to diff against', detail: 'a root commit has no diff to check' })
  } else {
    const parent = parentRes.out.trim()
    const diff = diffOf(repo, parent, sha)
    const all = functionsAt(repo, sha)
    const added = all.filter((fn) => {
      const lines = diff.added.get(fn.file)
      if (!lines || fn.tokens < MIN_TOKENS) return false
      for (let l = fn.line; l <= fn.endLine; l++) if (lines.has(l)) return true
      return false
    })
    const clones = findClones(added, all)

    const trailers = git(repo, ['log', '-1', '--format=%(trailers:key=Ladder-Rung,valueonly)', sha])
      .out.split('\n')
      .map((v) => v.trim())
      .filter(Boolean)
    const touchesSource = diff.files.some((f) => SOURCE.test(f))
    if (trailers.length === 0) {
      findings.push({
        level: touchesSource ? 'warning' : 'pass',
        claim: 'the commit says which rung held',
        detail: touchesSource ? 'no Ladder-Rung trailer - the decision is invisible in the diff' : 'no source changed',
      })
    }
    for (const value of trailers) findings.push(checkRung(value, { repo, parent, rev: sha, diff, clones }))

    findings.push(
      clones.length === 0
        ? {
            level: 'pass',
            claim: 'no function this commit adds is an existing one renamed',
            detail: added.length + ' added function(s) compared against ' + all.length,
          }
        : {
            level: 'error',
            claim: 'no function this commit adds is an existing one renamed',
            detail: clones
              .map((c) => c.copy.name + ' (' + where(c.copy) + ') is ' + c.original.name + ' (' + where(c.original) + ') up to renaming')
              .join('; '),
            file: clones[0]!.copy.file,
            line: clones[0]!.copy.line,
          },
    )
  }

  report('The ladder, checked against ' + target + ' (' + sha.slice(0, 7) + ')', findings)
  process.exit(exitCodeFor(findings))
}

main()
