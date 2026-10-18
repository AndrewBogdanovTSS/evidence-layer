// Makes this project what the runtime gate and the seal expect it to be: a
// repository of its own.
//
//   npm run standalone                 # into a new temporary directory
//   npm run standalone -- ../widgets   # or into one you name, which must be empty or absent
//
// Inside evidence-layer's checkout this directory is a folder of someone
// else's repository. git answers every question from the top level, so here
// the hooks in .claude and .codex would check evidence-layer's review.md and
// keep their state in its .git, and a sealed run would fingerprint the whole
// checkout. Nothing about the layout is wrong for a template, but a template
// cannot show the reference behaviour - so this copies it out, links this
// checkout's evidence-layer the way `file:` would, commits it, and prints the
// path. The copy is exactly a project using evidence-layer: this script and
// its npm entry stay behind.
//
// Every command gets its arguments as a list, never through a shell: the
// directory is yours to name, and a name is not a command.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(project, '..', '..')

if (!existsSync(join(checkout, 'dist', 'bin', 'evidence-layer.mjs'))) {
  console.error('evidence-layer is not built - run `pnpm build` in ' + checkout + ' first; nothing was copied')
  process.exit(2)
}

const named = process.argv[2]
if (named !== undefined && existsSync(named) && readdirSync(named).length > 0) {
  console.error(named + ' is not empty; nothing was copied')
  process.exit(2)
}
const dir = named === undefined ? mkdtempSync(join(tmpdir(), 'widget-counter-')) : resolve(named)

// What one working copy wrote, not the project: its installed packages and its last bundle.
const LEFT_BEHIND = new Set(['node_modules', 'evidence.local.md', join('scripts', 'standalone.mjs')])
cpSync(project, dir, { recursive: true, filter: (src) => !LEFT_BEHIND.has(relative(project, src)) })

// `file:../..` meant "the checkout above me"; from the copy, that is this path.
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
pkg.devDependencies['evidence-layer'] = 'file:' + checkout
delete pkg.scripts.standalone
writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

const run = (command, args, shell = false) => execFileSync(command, args, { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'], shell })
// npm is `npm.cmd` on Windows, which only a shell can start; its arguments here are all fixed.
run('npm', ['install', '--no-audit', '--no-fund'], process.platform === 'win32')
run('git', ['init', '-q'])
run('git', ['add', '-A'])
// An identity for this one commit, so a machine with none configured can still make it.
run('git', ['-c', 'user.name=widget-counter', '-c', 'user.email=widget-counter@example.invalid', 'commit', '-qm', 'widget-counter, standalone'])

console.log(`widget-counter is a repository of its own at ${dir}
with this checkout's evidence-layer linked into node_modules.

  cd ${JSON.stringify(dir)}
  npm run evidence -- --base HEAD    # then the tour's step 0 from "Copy the suggested claims"

Start Claude Code or Codex there and the gate checks this project's review.md.
Codex asks you to trust the project's hooks first (/hooks).`)
