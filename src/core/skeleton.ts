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

export interface SkeletonArtifact {
  command: string
  output: string
  exitCode: number
  id: string
  commit: string
}

/** One plausible claim sentence per command kind. Never asserts success when exitCode says otherwise. */
function claimSentence(command: string, exitCode: number): string | null {
  const kind = classifyCommand(command)
  const ok = exitCode === 0
  switch (kind) {
    case 'tests':
      return ok ? 'The test suite reports no failures.' : 'The test suite reports failures.'
    case 'lint':
      return ok ? 'Lint reports no violations.' : 'Lint reports violations.'
    case 'types':
      return ok ? 'Typecheck reports no errors.' : 'Typecheck reports errors.'
    case 'engine':
      return ok ? 'Recorded engine behaviour is unchanged.' : 'Engine behaviour changed - a fingerprint moved.'
    case 'diff':
      // Context, not a claim someone would grade VERIFIED - the diff summary
      // does not assert anything a reader would ask "could this be wrong?" about.
      return null
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
    const sentence = claimSentence(a.command, a.exitCode)
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
 * One `**Sample integrity**` line per file the caller supplies, quoting its
 * first non-blank line at the reviewed commit. Improvement 6 requires one
 * quote per *cited* file, not per changed file - this over-generates on
 * purpose, because deleting the lines a review does not need is cheaper than
 * typing new ones from scratch, which is again the cost rule from the file
 * header. Capping which files get fetched at all is the caller's job, since
 * only the caller knows the cost of reading each one.
 */
export function generateSampleSkeleton(samples: { path: string; line: string }[], omittedCount = 0): string {
  const lines = samples.map((s) => '**Sample integrity**: `' + s.path + '` -> `' + s.line + '`')
  if (omittedCount > 0) {
    lines.push('<!-- ' + omittedCount + ' more changed files omitted - add their quotes if you cite them -->')
  }
  return lines.join('\n')
}
