/**
 * `pnpm evidence --base <ref>` - gather the proof before writing the review.
 *
 * Thin wrapper. The orchestration - the working-tree guard, the diff, running
 * each step, addressing every artifact, writing the claim skeleton - lives in
 * `src/core/gather.ts`, and the skeleton is mandatory there rather than a
 * nicety: addressing evidence without a generator would make citing an
 * artifact more expensive than a bare, unbacked tag, which is the one thing
 * this package refuses to ship.
 *
 * What this file supplies is the only part that is this repository's business:
 * the lint step, which this repository does not have. It has no ESLint - the
 * boundary that mattered is `test/boundary.test.ts` - so the step runs the
 * typechecker and says so, rather than planning a `pnpm lint` that would fail
 * for the uninteresting reason that the script does not exist.
 *
 * No `coverageParser` is wired in for the same kind of reason: this
 * repository has not turned coverage on in `pnpm test`, so there is nothing
 * for one to parse, and passing one anyway would either find nothing or
 * quietly start asserting a number nobody asked this suite to measure.
 *
 * Exit codes: 0 bundle written - 1 refs unresolvable or the guard failed - 2 bad usage.
 */
import { EXIT, gatherEvidence, help, parseArgs, usage } from '../src/index'

const HELP = `
pnpm evidence --base <ref> [--head <ref>] [--out <file>] [--skip <steps>] [--repo <path>] [--audit]

Runs typecheck, tests, a lockfile check and the diff summary for a change, and
writes them - plus the working tree's own status - as addressed artifact
blocks and a ready-to-paste claim skeleton.

  --base   the baseline ref (use origin/<branch>, not a bare local branch name)
  --head   the commit under review (default HEAD)
  --out    output file (default evidence.local.md, which is gitignored)
  --skip   comma-separated: diff, tree, lint, typecheck, lockfile, test
  --repo   repository root (default: current directory)
  --audit  also run \`pnpm audit\` - needs network, and can change with no code
           change, so it is not planned by default

exit 0 = bundle written, 1 = could not gather, 2 = bad usage
`

/** This repository has no linter to run; the typechecker is what stands in its place. */
export function typecheckInsteadOfLint(): string {
  return 'pnpm typecheck'
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) help(HELP)

  const repo = typeof args.repo === 'string' ? args.repo : process.cwd()
  const base = typeof args.base === 'string' ? args.base : undefined
  const head = typeof args.head === 'string' ? args.head : undefined
  const out = typeof args.out === 'string' ? args.out : undefined
  const skip = typeof args.skip === 'string' ? args.skip.split(',').map((s) => s.trim()) : []
  const audit = args.audit === true
  if (!base) usage(HELP)

  try {
    gatherEvidence({ repo, base, head, out, skip, audit, plan: { lintCommand: typecheckInsteadOfLint } })
  } catch (err) {
    console.error((err as Error).message)
    process.exit(EXIT.failed)
  }
  process.exit(EXIT.ok)
}

main()
