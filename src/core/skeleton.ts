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
 */
import { classifyCommand, formatArtifact } from './artifact'
import { formatCodeSpan } from './receipt'

export interface SkeletonArtifact {
  command: string
  output: string
  exitCode: number
  id: string
  commit: string
  /**
   * The run was killed by its time limit, as `run()` reports it. Its exit code
   * is the conventional `124`, which only says the command was stopped - left
   * to the exit code alone, a killed typecheck would be suggested as "reports
   * errors", a claim its own artifact cannot back. Passed explicitly rather than
   * read from `124`, because a real tool may exit 124 on its own.
   */
  timedOut?: boolean
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

/** One plausible claim sentence per command kind. Never asserts success when exitCode says otherwise. */
function claimSentence(command: string, exitCode: number, timedOut = false): string | null {
  const kind = classifyCommand(command)
  // Context, not a claim someone would grade VERIFIED - neither the diff
  // summary nor the working-tree status asserts anything a reader would
  // ask "could this be wrong?" about. Checked first, so a slow diff that
  // timed out still yields no claim.
  if (kind === 'diff' || kind === 'tree') return null
  // A run that was stopped never reported a result, so the only claim its
  // artifact backs is that it did not finish - not a pass, and not a failure.
  if (timedOut) return (TIMED_OUT_SUBJECT[kind] ?? 'This command') + ' did not complete - it timed out before reporting a result.'
  const ok = exitCode === 0
  switch (kind) {
    case 'tests':
      return ok ? 'The test suite reports no failures.' : 'The test suite reports failures.'
    case 'lint':
      return ok ? 'Lint reports no violations.' : 'Lint reports violations.'
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
 * One `**Claim**` / `**Grounding**: VERIFIED[id]` / artifact block per gathered
 * artifact whose kind maps to a claim. Delete what you did not mean to assert -
 * that is the only edit the honest path requires.
 */
export function generateClaimSkeleton(artifacts: SkeletonArtifact[]): string {
  const parts: string[] = []
  for (const a of artifacts) {
    const sentence = claimSentence(a.command, a.exitCode, a.timedOut)
    if (!sentence) continue
    parts.push(
      '**Claim**: ' + sentence,
      '**Grounding**: VERIFIED[' + a.id + ']',
      '',
      formatArtifact(a.command, a.output, a.exitCode, { id: a.id, commit: a.commit }),
      '',
    )
  }
  return parts.join('\n')
}

/**
 * One Sample integrity table row per file the caller supplies, quoting its
 * first non-blank line at the reviewed commit. Improvement 6 requires one
 * quote per *cited* file, not per changed file - this over-generates on
 * purpose, because deleting the rows a review does not need is cheaper than
 * typing new ones from scratch, which is again the cost rule from the file
 * header. Capping which files get fetched at all is the caller's job, since
 * only the caller knows the cost of reading each one.
 */
export function generateSampleSkeleton(samples: { path: string; line: string }[], omittedCount = 0): string {
  // A table since 0.2.0. The line form repeated its label once per file and ran
  // together into one paragraph in any Markdown preview; `parseReceipt` still
  // reads it, so reviews written against 0.1.x keep verifying.
  const lines = [
    '**Sample integrity**:',
    '',
    '| File | First non-blank line |',
    '|---|---|',
    ...samples.map((s) => '| ' + formatCodeSpan(s.path, true) + ' | ' + formatCodeSpan(s.line, true) + ' |'),
  ]
  if (omittedCount > 0) {
    lines.push('', '<!-- ' + omittedCount + ' more changed files omitted - add their quotes if you cite them -->')
  }
  return lines.join('\n')
}
