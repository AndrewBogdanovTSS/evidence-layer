/**
 * Tiny argument parser and reporter shared by every check in this package.
 *
 * The claim it makes falsifiable: none - this is plumbing. It exists so that
 * every check agrees on what `--help` prints and what an exit code means,
 * because a checker whose exit codes are inconsistent teaches the wrong lesson
 * on its very first run.
 */

/**
 * Exit codes are a contract.
 *
 * `usage` (2) is bad usage, and bad usage is never a pass. `flaky` (3) is its
 * own code, distinct from `failed` - a caller that only checks "was it zero"
 * still sees a non-zero exit, but a caller that wants to treat instability
 * differently from a real failure can tell the two apart without parsing text.
 */
export const EXIT = { ok: 0, failed: 1, usage: 2, flaky: 3 } as const

export interface Args {
  /** Positional arguments, in order. */
  _: string[]
  /** `--flag value`, and bare `--flag` which becomes `true`. */
  [key: string]: string | boolean | string[]
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (!token.startsWith('--')) {
      ;(args._ as string[]).push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
      continue
    }
    args[key] = next
    i++
  }
  return args
}

/**
 * Five outcomes, not the three or four an ordinary linter uses.
 *
 * `unverifiable` is deliberately not an error and deliberately not a pass: a
 * checker that reports success when it could not run is worse than no checker
 * at all, because it manufactures confidence out of nothing.
 *
 * `flaky` is deliberately not the same as `error`: a test that failed for
 * reasons unrelated to the change under review is real information, but it is
 * not the same claim as "the change broke something," and collapsing the two
 * teaches people to bypass the check the first time noise looks like signal.
 */
export type Level = 'pass' | 'warning' | 'error' | 'unverifiable' | 'flaky'

export interface Finding {
  level: Level
  /** What was claimed, in the words of whoever claimed it. */
  claim: string
  /** What the repository says instead, or why nobody can tell. */
  detail: string
  /** Where the claim lives, when it has a location. */
  file?: string
  line?: number
  /**
   * The same two facts as `claim` and `detail`, as values rather than prose.
   *
   * `claim`/`detail` are written to be read by a person and are the only thing
   * the text reporter prints. They are English, so anything downstream that
   * wants the number has to parse the sentence back apart - and a consumer that
   * regex-scrapes "measured 4.15 MB" is a claim about the wording, not about
   * the build. These two fields are for that consumer.
   *
   * Both optional on purpose. Plenty of honest findings have no scalar to
   * report ("no test-count claim found to check"), and inventing one so the
   * shape looks uniform would mean fabricating an observation - which is the
   * failure this package exists to make impossible. Absent means absent.
   */
  expected?: unknown
  observed?: unknown
}

/**
 * No color library - this package's whole pitch is zero runtime dependencies,
 * and three ANSI codes don't earn one.
 *
 * Not gated on `process.stdout.isTTY`: governance itself runs checks as a
 * captured subprocess and re-prints their output, and plenty of legitimate
 * callers (a sandboxed session with no real terminal attached, a CI log
 * viewer that renders ANSI) have no TTY but still want to see color. NO_COLOR
 * (https://no-color.org) is the opt-out for the ones that do not.
 */
const useColor = process.env.NO_COLOR === undefined
const paint = (code: number, text: string) => (useColor ? '[' + code + 'm' + text + '[0m' : text)

const ICON: Record<Level, string> = {
  pass: paint(32, '✔'),
  warning: paint(33, '⚠'),
  error: paint(31, '✘'),
  unverifiable: '❓',
  flaky: '↻',
}

export function report(title: string, findings: Finding[]): void {
  console.log('')
  console.log(title)
  console.log('-'.repeat(title.length))
  for (const f of findings) {
    const where = f.file ? ' (' + f.file + (f.line ? ':' + f.line : '') + ')' : ''
    console.log(ICON[f.level] + ' ' + f.claim + where)
    if (f.detail) console.log('        ' + f.detail)
  }
  console.log('')
  console.log(summarise(findings))
  console.log('')
}

export function summarise(findings: Finding[]): string {
  const n = (level: Level) => findings.filter((f) => f.level === level).length
  return (
    findings.length +
    ' checked - ' +
    n('error') +
    ' failed, ' +
    n('flaky') +
    ' flaky, ' +
    n('warning') +
    ' warnings, ' +
    n('unverifiable') +
    ' unverifiable'
  )
}

/**
 * `unverifiable` and `flaky` are deliberately not the same thing as a pass, and
 * deliberately not the same thing as an error either. Three or more outcomes,
 * never collapsed to two.
 */
export function exitCodeFor(findings: Finding[], strict = false): number {
  if (findings.some((f) => f.level === 'error')) return EXIT.failed
  if (findings.some((f) => f.level === 'flaky')) return EXIT.flaky
  if (strict && findings.some((f) => f.level === 'warning' || f.level === 'unverifiable')) {
    return EXIT.failed
  }
  return EXIT.ok
}

/**
 * Prints the same text and exits `0`. Asking for help is not a usage error:
 * a CLI that exits non-zero on `--help` fails a shell pipeline for doing the
 * one thing its own output told the caller to do, and teaches whoever wired it
 * into CI to stop trusting its exit codes.
 */
export function help(text: string): never {
  console.log(text.trim())
  process.exit(EXIT.ok)
}

/** Prints usage text and exits `2`. Called when the arguments make no sense. */
export function usage(text: string): never {
  console.log(text.trim())
  process.exit(EXIT.usage)
}
