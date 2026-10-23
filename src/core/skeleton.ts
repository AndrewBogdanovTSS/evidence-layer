/**
 * The review skeleton - the reason addressed evidence does not make honesty
 * more expensive.
 *
 * The claim it makes falsifiable: nothing on its own - this is the mandatory
 * companion to `claims.ts`'s addressed `VERIFIED[id]` form, not a checker.
 *
 * A naive reading of "address every artifact by id" makes the correct path
 * *more* expensive: writing `VERIFIED[tests-a3f91c]` requires going and finding
 * the id, where bare `VERIFIED` is typed in an instant. That is a direct
 * violation of the layer's own cross-cutting rule - the honest path has to be
 * the cheap one - so it must not ship without this half.
 *
 * `pnpm evidence` calls this after gathering, and writes a skeleton with the
 * ids already substituted straight into `evidence.local.md`. Referencing an
 * artifact then means **leaving a ready-made block in place**; writing a bare
 * `VERIFIED` means **deleting part of the template**. Correct becomes strictly
 * cheaper than convenient, which is the only version of this feature allowed
 * to ship.
 *
 * The same pair - `suggestedClaim` - is what a failing claim's finding offers
 * as its fix, and what the runtime gate hands an agent as the claims it can
 * make: a writer who cannot work out the right sentence and the right
 * predicates is given them, read off the run.
 */
import { classifyCommand, formatArtifact, formatExitLine, parseWorkSummary } from './artifact'
import type { StopReason } from './artifact'
import { suggestPredicates } from './predicates'
import { formatCodeSpan } from './receipt'

export interface SkeletonArtifact {
  command: string
  output: string
  exitCode: number
  id: string
  commit: string
  /**
   * Why the run stopped before reporting a result, as `run()` / `runAsync()`
   * report it. Left to the exit code alone, a killed typecheck would be
   * suggested as "reports errors", a claim its own artifact cannot back. Passed
   * explicitly rather than read from `124`, because a real tool may exit 124
   * on its own. Written onto the artifact's exit line.
   */
  stopped?: StopReason
  /** @deprecated Since 0.4.0 - pass `stopped: 'timeout'`. Still honoured. */
  timedOut?: boolean
}

/** How a skeleton is laid out - the claims and quotes in it are the same either way. */
export interface SkeletonOptions {
  /**
   * Put each artifact block, and the Sample integrity table, in a `<details>`
   * fold, so a review posted as a pull request comment opens on its claims
   * instead of on command logs. The Claim and Grounding lines stay outside the
   * fold - they are what a reader grades. Off by default: a fold is HTML, and
   * only a host that renders `<details>` (GitHub, Azure DevOps) is better for it.
   */
  fold?: boolean
}

/**
 * One `<details>` fold. The 8px spacer keeps the opened content off the
 * summary line, and the blank lines are load-bearing: CommonMark ends an HTML
 * block only at a blank line, so without them the fence or table inside would
 * be read as HTML, not Markdown. The summary keeps its native disclosure
 * triangle - it is the control's only affordance for keyboard and screen
 * reader users, so there is no option to hide it.
 */
export function foldDetails(summary: string, body: string): string {
  return ['<details>', '<summary>' + summary + '</summary>', '<div style="height:8px"></div>', '', body, '', '</details>'].join('\n')
}

// A shell word: bare characters and quoted runs, so `NODE_OPTIONS='--a --b'` stays one token.
const SHELL_WORD_RE = /(?:[^\s'"]+|'[^']*'|"[^"]*")+/g

/**
 * The command as a fold's summary names it: environment assignments kept,
 * `NODE_OPTIONS`, `--flags` and anything path-like dropped. A summary sits
 * outside every fence, so a verifier that reads prose for citations reads a
 * path there as a file the review cites and asks for its quote - the file list
 * of a lint run would fail the review. The full command is the block's first
 * line, one click away.
 */
export function summaryCommand(command: string): string {
  return (command.match(SHELL_WORD_RE) ?? [])
    .filter((word) => !word.startsWith('NODE_OPTIONS=') && !word.startsWith('--') && !/[/\\]/.test(word))
    .join(' ')
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** `📄 Output - <command> - exit N, L lines`, where L counts the block's lines between its fences. */
function artifactSummary(command: string, block: string, exitCode: number, stopped?: StopReason): string {
  const lines = block.split('\n').length - 2
  const name = summaryCommand(command)
  return [
    '📄 <b>Output</b>',
    ...(name ? ['<code>' + escapeHtml(name) + '</code>'] : []),
    formatExitLine(exitCode, stopped).replace('exit: ', 'exit ') + ', ' + lines + (lines === 1 ? ' line' : ' lines'),
  ].join(' - ')
}

/** Who did not finish, per command kind - the subject of a timed-out claim. */
const TIMED_OUT_SUBJECT: Record<string, string> = {
  tests: 'The test suite',
  lint: 'Lint',
  types: 'Typecheck',
  lockfile: 'The lockfile check',
  audit: 'The dependency audit',
  engine: 'The engine fingerprint check',
}

/** How a stopped run is described: the reason it never reported a result. */
function stoppedBecause(stopped: StopReason): string {
  if (stopped === 'timeout') return 'it timed out before reporting a result.'
  if (stopped === 'overflow') return 'its output overflowed the capture limit and it was stopped.'
  return 'it was killed by ' + stopped.slice('killed '.length) + ' before reporting a result.'
}

/** One plausible claim sentence per command kind. Never asserts success when exitCode says otherwise. */
function claimSentence(command: string, exitCode: number, stopped?: StopReason, output = ''): string | null {
  const kind = classifyCommand(command)
  // Context, not a claim someone would grade VERIFIED - neither the diff
  // summary nor the working-tree status asserts anything a reader would
  // ask "could this be wrong?" about. Checked first, so a slow diff that
  // timed out still yields no claim.
  if (kind === 'diff' || kind === 'tree') return null
  // A run that was stopped never reported a result, so the only claim its
  // artifact backs is that it did not finish - not a pass, and not a failure.
  if (stopped) return (TIMED_OUT_SUBJECT[kind] ?? 'This command') + ' did not complete - ' + stoppedBecause(stopped)
  const ok = exitCode === 0
  // The work summary, when the run has one, puts the amount of work in the
  // sentence: "no failures" over zero tests is not a claim anyone means.
  const summary = parseWorkSummary(output)
  switch (kind) {
    // Each summary branch words its claim so `outcomeProblem` accepts it -
    // the zero-work sentences carry no success verb on purpose.
    case 'tests': {
      if (!ok || summary?.kind !== 'tests') return ok ? 'The test suite reports no failures.' : 'The test suite reports failures.'
      const c = summary.counts
      if (c.failed! > 0) return 'The test suite reports failures.'
      if (c.passed === 0) return 'The test suite ran 0 tests to completion - ' + c.skipped + ' skipped, ' + c.todo + ' todo.'
      return 'The test suite ran ' + c.passed + ' passing tests and reports no failures.'
    }
    case 'lint': {
      if (!ok || summary?.kind !== 'lint') return ok ? 'Lint reports no violations.' : 'Lint reports violations.'
      const c = summary.counts
      if (c.errors! + c.warnings! > 0) return 'Lint reports violations.'
      if (c.files! - c.ignored! <= 0) return 'Lint checked no files - every file given to it was ignored.'
      return 'Lint checked ' + (c.files! - c.ignored!) + ' files and reports no violations.'
    }
    case 'types':
      return ok ? 'Typecheck reports no errors.' : 'Typecheck reports errors.'
    case 'lockfile':
      return ok ? 'The lockfile matches package.json.' : 'The lockfile is out of sync with package.json.'
    case 'audit':
      return ok ? 'A dependency audit reports no known vulnerabilities.' : 'A dependency audit reports known vulnerabilities.'
    case 'engine':
      return ok ? 'Recorded engine behaviour is unchanged.' : 'Engine behaviour changed - a fingerprint moved.'
    default:
      return 'This command exits ' + exitCode + '.'
  }
}

/**
 * One `**Claim**` / `**Grounding**: VERIFIED[id: predicates]` / artifact block
 * per gathered artifact whose kind maps to a claim. Delete what you did not
 * mean to assert - that is the only edit the honest path requires.
 *
 * The predicates are read off the same run the sentence describes, so they
 * cost the author nothing: they arrive filled in, and keeping them is the same
 * edit as keeping the tag. What they buy is a sentence whose numbers a script
 * can hold the artifact to - "ran 71 passing tests" stops being prose.
 *
 * With `fold`, each artifact block sits in a `<details>` fold under its
 * Grounding line, summarised by command, exit code and line count.
 */
export function generateClaimSkeleton(artifacts: SkeletonArtifact[], options: SkeletonOptions = {}): string {
  const parts: string[] = []
  // One claim per id. Two steps that run the same command at the same commit
  // with the same output - a project whose lint step is its typechecker - get
  // the same id, and the bundle printed the same claim twice: an agent that
  // kept both made one claim twice, and spent half the shotgun budget on it.
  const seen = new Set<string>()
  for (const a of artifacts) {
    if (seen.has(a.id)) continue
    const stopped = a.stopped ?? (a.timedOut ? 'timeout' : undefined)
    const ready = suggestedClaim({ ...a, stopped })
    if (!ready) continue
    seen.add(a.id)
    const block = formatArtifact(a.command, a.output, a.exitCode, { id: a.id, commit: a.commit, stopped })
    parts.push(
      ready.claim,
      ready.grounding,
      '',
      options.fold ? foldDetails(artifactSummary(a.command, block, a.exitCode, stopped), block) : block,
      '',
    )
  }
  return parts.join('\n')
}

/** The parts of a gathered run a ready claim is written from. `ArtifactBlock` with an id satisfies it. */
export interface ClaimableArtifact {
  command: string
  output: string
  exitCode: number
  id: string
  stopped?: StopReason
}

/** A claim and its grounding, as the two lines a review keeps. */
export interface SuggestedClaim {
  claim: string
  grounding: string
}

/**
 * The claim one gathered run backs, as the two lines a review keeps - `null`
 * for a run that backs none (a diff, the tree's status). The same pair the
 * skeleton writes, so a fix a finding suggests, a claim the gate lists and a
 * claim in the bundle are one sentence, not three that drift: written from
 * the run, never from what the writer hoped it showed.
 */
export function suggestedClaim(artifact: ClaimableArtifact): SuggestedClaim | null {
  const sentence = claimSentence(artifact.command, artifact.exitCode, artifact.stopped, artifact.output)
  if (!sentence) return null
  return {
    claim: '**Claim**: ' + sentence,
    grounding: '**Grounding**: VERIFIED[' + artifact.id + ': ' + suggestPredicates(artifact) + ']',
  }
}

/**
 * One Sample integrity table row per file the caller supplies, quoting its
 * first non-blank line at the reviewed commit. Improvement 6 requires one
 * quote per *cited* file, not per changed file - this over-generates on
 * purpose, because deleting the rows a review does not need is cheaper than
 * typing new ones from scratch, which is again the cost rule from the file
 * header. Capping which files get fetched at all is the caller's job, since
 * only the caller knows the cost of reading each one.
 *
 * With `fold`, the table sits in a `<details>` fold whose summary takes the
 * label's place - `parseReceipt` finds a table by its header row, not by the
 * label - and says how many files it quotes, never which.
 */
export function generateSampleSkeleton(
  samples: { path: string; line: string }[],
  omittedCount = 0,
  options: SkeletonOptions = {},
): string {
  // A table since 0.2.0. The line form repeated its label once per file and ran
  // together into one paragraph in any Markdown preview; `parseReceipt` still
  // reads it, so reviews written against 0.1.x keep verifying.
  const table = [
    '| File | First non-blank line |',
    '|---|---|',
    ...samples.map((s) => '| ' + formatCodeSpan(s.path, true) + ' | ' + formatCodeSpan(s.line, true) + ' |'),
  ]
  if (omittedCount > 0) {
    table.push('', '<!-- ' + omittedCount + ' more changed files omitted - add their quotes if you cite them -->')
  }
  if (options.fold) {
    const summary = '🔍 <b>Sample integrity</b> - ' + samples.length + (samples.length === 1 ? ' file' : ' files')
    return foldDetails(summary, table.join('\n'))
  }
  return ['**Sample integrity**:', '', ...table].join('\n')
}
