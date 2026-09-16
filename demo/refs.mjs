/**
 * The two git references the receipt demos read, created and removed.
 *
 * This repository has a short, linear, fully merged history, which is exactly
 * the wrong shape for showing a baseline going stale: every commit reachable
 * from `master` is its own merge-base with `origin/master`, so a receipt
 * written against the real refs is either degenerate or trivially correct. So
 * the situation is manufactured, in the open, by two refs that exist only for
 * the demo:
 *
 *   demo-target         -> the first commit. A LOCAL branch, left behind.
 *   origin/demo-target  -> the same branch on the "remote", ten commits ahead.
 *
 * That pair is the whole point. A local branch that has fallen behind its
 * remote still looks like a mainline, and a review that takes its baseline
 * from the local name silently attributes every commit it is missing to the
 * branch under review. The diff comes out *larger*, so nothing looks missing.
 *
 * Node rather than a shell script because the demo is presented from
 * PowerShell as often as from a POSIX shell, and `sh` is not on the path of a
 * default Windows install. One implementation, no drift.
 *
 * `node demo/refs.mjs setup` - idempotent. `reset` removes both refs and
 * nothing else. Neither touches `master`.
 *
 * Exit codes: 0 done - 1 the pinned commits are not in this clone - 2 bad usage.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The SHAs are pinned rather than derived from HEAD, so the fixtures keep
 * reporting the same file counts as the repository grows. Both are ordinary
 * commits on this project's own history.
 */
/** The first commit: where the stale local branch is parked. */
const STALE = '89853d19b85eb26c6941bf3117f9ab70007a1754'
/** Where the remote has moved on to - the honest merge-base, and the value `demo/reviews/good-receipt.md` records. */
const REMOTE = '572a258a2871f88d84eb6836d4e4cf96618f3de9'

const LOCAL_REF = 'refs/heads/demo-target'
const REMOTE_REF = 'refs/remotes/origin/demo-target'

const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
const out = (...args) => git(...args).stdout.trim()

function setup() {
  for (const sha of [STALE, REMOTE]) {
    if (out('cat-file', '-t', sha) !== 'commit') {
      console.error('demo/refs.mjs: ' + sha + ' is not a commit in this clone.')
      console.error('The history moved under the fixtures. See demo/README.md.')
      process.exit(1)
    }
  }

  git('update-ref', LOCAL_REF, STALE)
  git('update-ref', REMOTE_REF, REMOTE)

  const behind = out('rev-list', '--count', 'demo-target..origin/demo-target')
  console.log('created:')
  console.log('  demo-target        -> ' + STALE + '  (LOCAL, ' + behind + ' commits behind its remote)')
  console.log('  origin/demo-target -> ' + REMOTE)
  console.log('')
  console.log('now run:')
  console.log('  pnpm check:receipt demo/reviews/bad-receipt.md --repo .    # fails on the stale baseline')
  console.log('  pnpm check:receipt demo/reviews/good-receipt.md --repo .   # the receipt holds')
}

function reset() {
  git('update-ref', '-d', LOCAL_REF)
  git('update-ref', '-d', REMOTE_REF)
  console.log('demo refs removed')
}

const command = process.argv[2]
if (command === 'setup') setup()
else if (command === 'reset') reset()
else {
  console.error('usage: node demo/refs.mjs setup|reset')
  process.exit(2)
}
