// The project's evidence script - run it before writing the review, not after.
//
//   node scripts/evidence.mjs --base origin/main
//
// It runs this project's own commands, appends how much each one checked
// (`[SUMMARY tests: passed=3 ...]`, read off Node's own test-runner totals),
// writes evidence.local.md - artifact blocks and ready-made claims to cite -
// and seals the run in .git, so `evidence-layer claims review.md --seal` can
// tell a block it wrote from one typed in by hand.
//
// What is this project's business, and so lives here rather than in the
// package: which commands to run. There is no typechecker and no pnpm
// lockfile, so those steps are skipped, and the bundle says they were. The
// lint script is a placeholder that checks nothing and exits 0 - gathered, it
// would hand the skeleton a "lint reports no violations" claim about no lint
// at all, so it is skipped too rather than cited.
//
// A failing test still gets its block - a failing run is evidence - and then
// the script exits 1. That is what lets CI run this instead of `npm test`
// rather than as well as it: the job fails when the suite does, and the suite
// runs once.
import { gatherEvidence, stepFailed } from 'evidence-layer'
import { summariseNodeTest } from 'evidence-layer/adapters/test-reports'

const arg = (name) => {
  const i = process.argv.indexOf('--' + name)
  return i === -1 ? undefined : process.argv[i + 1]
}

const result = await gatherEvidence({
  repo: process.cwd(),
  base: arg('base') ?? 'origin/main',
  skip: ['lint', 'typecheck', 'lockfile'],
  plan: { testCommand: () => 'npm test' },
  summaries: { test: summariseNodeTest() },
})

const failed = result.steps.filter(stepFailed).map((s) => s.name)
if (failed.length > 0) {
  console.error('failed: ' + failed.join(', ') + ' - the bundle records how')
  process.exitCode = 1
}
