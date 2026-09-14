/**
 * `evidence` core - gather the proof before writing, and hand over a skeleton
 * that makes citing it the cheap option.
 *
 * The claim it makes falsifiable: every "I checked that" a review is about to
 * make.
 *
 * The problem this solves is not dishonesty. It is that anyone writing a review
 * - person or model - reliably *uses* evidence that is already in front of them
 * and unreliably *chooses* to go and gather it halfway through composing a
 * sentence. Gathering is off the path they are on. So the fix is not a better
 * instruction; it is to run the expensive commands first, with something that
 * is not the reviewer, hand over the results, and - since v2 - hand over a
 * ready-made place to cite them from. See `skeleton.ts` for why the skeleton is
 * mandatory rather than a nicety: without it, addressed evidence would make the
 * honest path *more* expensive than a bare tag, which this layer refuses to ship.
 *
 * Two details carry more weight than they look like they do:
 *   - the working-tree guard, because evidence gathered at the wrong commit
 *     describes a different codebase than the review does;
 *   - a timeout recorded as `exit: 124` rather than a crash, because a command
 *     that failed is evidence and a command that never ran is not.
 *
 * Zero-config default: with no options beyond `repo`/`base`/`head`, this plans
 * `pnpm lint`, `pnpm typecheck` and `pnpm test` - the three scripts an ordinary
 * Node project already has a name for. A project with a reason to scope those
 * further (as this repository does, for its own test step) passes `testGate`
 * or `lintCommand`; nothing here requires it to.
 */
import { writeFileSync } from 'node:fs'
import { artifactId, classifyCommand, formatArtifact } from './artifact'
import { generateClaimSkeleton, generateSampleSkeleton } from './skeleton'
import type { SkeletonArtifact } from './skeleton'
import { capture, run } from './proc'

export interface Step {
  name: string
  command: string
  /** Skipped steps are recorded as skipped. Silence is not evidence. */
  skipReason?: string
}

export interface PlanOptions {
  /** Decide whether the test step is worth running for this diff. Default: always run it. */
  testGate?: (changedFiles: string[]) => boolean
  /** Build a scoped lint command from the changed files. Default: `pnpm lint` over everything. */
  lintCommand?: (changedFiles: string[]) => string
}

/** The zero-config default plan: lint, typecheck, test - the three scripts a typical Node project already names. */
export function planStepsDefault(changedFiles: string[], skip: string[], opts: PlanOptions = {}): Step[] {
  const steps: Step[] = []
  steps.push({
    name: 'lint',
    command: opts.lintCommand ? opts.lintCommand(changedFiles) : 'pnpm lint',
    skipReason: skip.includes('lint') ? 'skipped by --skip' : undefined,
  })
  steps.push({
    name: 'typecheck',
    command: 'pnpm typecheck',
    skipReason: skip.includes('typecheck') ? 'skipped by --skip' : undefined,
  })
  const gate = opts.testGate ? opts.testGate(changedFiles) : true
  steps.push({
    name: 'test',
    command: 'pnpm test',
    skipReason: skip.includes('test')
      ? 'skipped by --skip'
      : gate
        ? undefined
        : "no files changed that this project's test gate considers relevant",
  })
  return steps
}

/**
 * The guard. Lint, typecheck and tests read the working tree, not git objects,
 * so a bundle generated while checked out somewhere else is evidence about a
 * different codebase - stated confidently, and wrong.
 */
export function assertWorkingTreeAt(head: string, repo: string): string {
  const actual = capture('git rev-parse HEAD', repo)
  const wanted = capture('git rev-parse ' + head, repo)
  if (!actual || !wanted) throw new Error('could not resolve HEAD or ' + head)
  if (actual !== wanted) {
    throw new Error(
      'the working tree is at ' +
        actual.slice(0, 10) +
        ' but evidence was requested for ' +
        wanted.slice(0, 10) +
        '.\nCheck out the right commit first:  git checkout ' +
        wanted,
    )
  }
  return wanted
}

export interface GatherOptions {
  repo: string
  base: string
  head?: string
  out?: string
  skip?: string[]
  plan?: PlanOptions
  /** How many changed files to pre-fill sample-integrity quotes for. */
  sampleCap?: number
}

export interface GatherResult {
  headSha: string
  baseSha: string
  changedFiles: string[]
  outPath: string
}

export function gatherEvidence(opts: GatherOptions): GatherResult {
  const head = opts.head ?? 'HEAD'
  const out = opts.out ?? 'evidence.local.md'
  const skip = opts.skip ?? []

  const headSha = assertWorkingTreeAt(head, opts.repo)
  const baseSha = capture('git rev-parse ' + opts.base, opts.repo)
  if (!baseSha) throw new Error('could not resolve --base ' + opts.base)

  // Three dots: the diff since the branches diverged, which is the change under
  // review. Two dots would also fold in whatever the baseline did since.
  const range = baseSha + '...' + headSha
  const names = capture('git diff --name-only ' + range, opts.repo) ?? ''
  const changedFiles = names.split('\n').filter(Boolean)

  const parts: string[] = [
    '# Evidence bundle',
    '',
    '- Base: `' + baseSha + '` (' + opts.base + ')',
    '- Head: `' + headSha + '`',
    '- Files in diff: ' + changedFiles.length,
    '',
    'Generated by `pnpm evidence`. Every block below is a command anyone can re-run.',
    '',
  ]

  const claimArtifacts: SkeletonArtifact[] = []

  if (!skip.includes('diff')) {
    const stat = run('git diff --stat ' + range, { cwd: opts.repo, timeoutMs: 60_000 })
    const id = artifactId(stat.command, headSha, stat.output)
    parts.push('## diff', '', formatArtifact(stat.command, stat.output, stat.exitCode, { id, commit: headSha }), '')
  }

  for (const step of planStepsDefault(changedFiles, skip, opts.plan)) {
    parts.push('## ' + step.name, '')
    if (step.skipReason) {
      parts.push('_Not run: ' + step.skipReason + '._', '')
      continue
    }
    const res = run(step.command, { cwd: opts.repo, timeoutMs: 300_000 })
    const id = artifactId(res.command, headSha, res.output)
    parts.push(formatArtifact(res.command, res.output, res.exitCode, { id, commit: headSha }), '')
    if (classifyCommand(res.command) !== 'diff') {
      claimArtifacts.push({ command: res.command, output: res.output, exitCode: res.exitCode, id, commit: headSha })
    }
    console.log('  ' + step.name + ': exit ' + res.exitCode + (res.timedOut ? ' (timed out)' : ''))
  }

  const claimSkeleton = generateClaimSkeleton(claimArtifacts)
  if (claimSkeleton.trim() !== '') {
    parts.push('## Suggested claims', '', claimSkeleton, '')
  }

  const cap = opts.sampleCap ?? 20
  const samples = changedFiles.slice(0, cap).map((path) => {
    const content = capture('git show ' + headSha + ':' + path, opts.repo)
    const line = content?.split('\n').find((l) => l.trim() !== '')?.trim() ?? '(could not read this file)'
    return { path, line }
  })
  if (samples.length > 0) {
    parts.push(
      '## Suggested sample integrity',
      '',
      generateSampleSkeleton(samples, Math.max(0, changedFiles.length - cap)),
      '',
    )
  }

  writeFileSync(out, parts.join('\n'), 'utf8')
  console.log('\nwrote ' + out + ' - cite these blocks and claims instead of asserting what they would have said\n')
  return { headSha, baseSha, changedFiles, outPath: out }
}
