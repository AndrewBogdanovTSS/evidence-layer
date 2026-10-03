/**
 * The two commits the ladder demo checks, built on top of HEAD and never
 * checked out.
 *
 * A demo about a check that reads commits needs commits that are wrong on
 * purpose, and this repository's real history has none worth keeping. So they
 * are manufactured, in the open, from the files under `demo/ladder/commits/`:
 *
 *   refs/demo/ladder-bad       HEAD + receipt.js with a renamed copy of
 *                              formatPrice, and a trailer claiming
 *                              `Ladder-Rung: 2 reuse formatPrice`
 *   refs/demo/ladder-refactor  ladder-bad + the copy removed, formatPrice
 *                              called instead - same trailer, now true
 *
 * Built with plumbing against a temporary index, so neither the working tree
 * nor the real index is touched. Outside `refs/heads/` on purpose: they are not
 * branches, `git branch` does not list them, and a default push does not send
 * them - which is what lets `pnpm check:all` rebuild them on every run without
 * leaving anything behind that looks like work. Git resolves the short form,
 * so `pnpm check:ladder demo/ladder-bad` works as typed.
 *
 * Author, committer and dates are pinned, so the same HEAD always produces the
 * same two SHAs.
 *
 * The fixture sources end in `.txt` so that nothing scanning this repository's
 * own JavaScript - the clone check included - mistakes the demo's deliberate
 * copy for real code.
 *
 * `node demo/ladder.mjs setup|reset`. Exit codes: 0 done - 1 git refused -
 * 2 bad usage. `demo/refs.mjs` calls the same two functions for
 * `pnpm demo:setup` / `demo:reset`.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const COMMITS = join(root, 'demo', 'ladder', 'commits')

/** Each fixture commit: its ref, the files it overlays (repo path -> fixture file), and its message. */
const FIXTURES = [
  {
    ref: 'refs/demo/ladder-bad',
    dir: 'bad',
    files: { 'demo/ladder/shop/receipt.js': 'receipt.js.txt' },
  },
  {
    ref: 'refs/demo/ladder-refactor',
    dir: 'refactor',
    files: { 'demo/ladder/shop/receipt.js': 'receipt.js.txt' },
  },
]

const IDENTITY = {
  GIT_AUTHOR_NAME: 'evidence-layer demo',
  GIT_AUTHOR_EMAIL: 'demo@evidence-layer.invalid',
  GIT_AUTHOR_DATE: '2026-10-03T00:00:00Z',
  GIT_COMMITTER_NAME: 'evidence-layer demo',
  GIT_COMMITTER_EMAIL: 'demo@evidence-layer.invalid',
  GIT_COMMITTER_DATE: '2026-10-03T00:00:00Z',
}

function git(args, { env = {}, input } = {}) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', input, env: { ...process.env, ...env } })
  if (res.status !== 0) {
    throw new Error('git ' + args.join(' ') + ' failed: ' + (res.stderr || res.stdout).trim())
  }
  return res.stdout.trim()
}

/** `.gitattributes` pins LF; a Windows checkout of the fixture must not smuggle CRLF into a blob. */
const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

/** Builds both commits and points the refs at them. Idempotent. Returns `{ ref, sha }[]`. */
export function setupLadder() {
  const scratch = mkdtempSync(join(tmpdir(), 'ladder-'))
  const env = { GIT_INDEX_FILE: join(scratch, 'index') }
  const built = []
  try {
    let parent = git(['rev-parse', 'HEAD'])
    for (const fixture of FIXTURES) {
      git(['read-tree', parent], { env })
      for (const [path, source] of Object.entries(fixture.files)) {
        const blob = git(['hash-object', '-w', '--stdin'], { input: read(join(COMMITS, fixture.dir, source)) })
        git(['update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + path], { env })
      }
      const tree = git(['write-tree'], { env })
      const message = read(join(COMMITS, fixture.dir, 'message.txt'))
      const sha = git(['commit-tree', tree, '-p', parent], { env: { ...env, ...IDENTITY }, input: message })
      git(['update-ref', fixture.ref, sha])
      built.push({ ref: fixture.ref, sha })
      parent = sha
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return built
}

/** Removes both refs and nothing else. The commits become unreachable and git collects them in time. */
export function resetLadder() {
  for (const { ref } of FIXTURES) spawnSync('git', ['update-ref', '-d', ref], { cwd: root })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2]
  try {
    if (command === 'setup') {
      for (const { ref, sha } of setupLadder()) console.log('  ' + ref.replace('refs/', '') + ' -> ' + sha)
    } else if (command === 'reset') {
      resetLadder()
      console.log('ladder refs removed')
    } else {
      console.error('usage: node demo/ladder.mjs setup|reset')
      process.exit(2)
    }
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    process.exit(1)
  }
}
