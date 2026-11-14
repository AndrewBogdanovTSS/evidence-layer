#!/usr/bin/env node
/**
 * The gate's launcher: finds the evidence-layer installed in the project and
 * hands it the hook, in the same process.
 *
 * One file, two places. The Claude Code plugin runs it from the plugin's own
 * directory; `evidence-layer init` writes a copy into the project
 * (`.claude/evidence-layer-hook.mjs`, `.codex/evidence-layer-hook.mjs`) and
 * points the hooks at that. Either way it carries no copy of the package: the
 * project installs it, at the version the project chose, and this only has to
 * find it - walking up from the project directory, which covers pnpm
 * workspaces, worktrees and a session started in a subdirectory. A directory
 * whose own package.json is evidence-layer is the package too: that is how
 * its repository runs its own gate, from the `dist/` its last build left.
 * Dependency-free, because it has to work in exactly the case where nothing
 * is installed.
 *
 * That case is the reason it exists. A hook that runs the package straight
 * out of `node_modules` fails with "Cannot find module" on a fresh clone -
 * which the host reads as a broken hook, not as a decision, so the session
 * goes on ungated and nobody is told. Here, when the package is missing, or
 * too old to know the hook protocol (it must declare
 * `"evidenceLayer": { "hookProtocol": 1 }` - a capability, not a version
 * comparison), that is said through the hook protocol, never through an exit
 * code: SessionStart tells the agent the gate is inactive and how to change
 * that, and every other event stays out of the way - unless the hook was
 * configured `--fail-closed` or `--strict`, in which case a Stop is blocked,
 * because a strict gate that silently disappears when its package does is
 * not strict.
 *
 * `--host=codex` after the event name says which host's protocol the package
 * is asked to speak; without it, Claude Code's.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOOK_PROTOCOL = 1
const [event, ...rest] = process.argv.slice(2)
const host = rest.includes('--host=codex') ? 'codex' : 'claude'
const flags = rest.filter((flag) => !flag.startsWith('--host='))
const strict = flags.includes('--fail-closed') || flags.includes('--strict')

function isThisPackage(manifest) {
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).name === 'evidence-layer'
  } catch {
    return false
  }
}

function findPackage(start) {
  let dir = resolve(start)
  for (;;) {
    const manifest = join(dir, 'node_modules', 'evidence-layer', 'package.json')
    if (existsSync(manifest)) return manifest
    if (isThisPackage(join(dir, 'package.json'))) return join(dir, 'package.json')
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function inactive(reason) {
  if (event === 'session-start') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'The evidence-layer gate is inactive in this project: ' + reason + '.',
        },
      }) + '\n',
    )
  } else if (event === 'stop' && strict) {
    process.stdout.write(
      JSON.stringify({ decision: 'block', reason: 'The evidence-layer gate is configured to fail closed, and ' + reason + '.' }) + '\n',
    )
  }
  process.exitCode = 0
}

const manifestPath = findPackage(process.env.CLAUDE_PROJECT_DIR || process.cwd())
let manifest
try {
  manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
} catch {
  manifest = null
}

if (!manifestPath || !manifest) {
  inactive('evidence-layer is not installed (npm install --save-dev evidence-layer)')
} else if (manifest.evidenceLayer?.hookProtocol !== HOOK_PROTOCOL) {
  inactive('the installed evidence-layer ' + (manifest.version ?? '') + ' is too old for this hook - upgrade it')
} else {
  const bin = join(dirname(manifestPath), manifest.bin?.['evidence-layer'] ?? 'dist/bin/evidence-layer.mjs')
  process.argv = [process.argv[0], bin, 'hook', host, event, ...flags]
  try {
    await import(pathToFileURL(bin).href)
  } catch (error) {
    // In this repository the usual cause is a checkout nobody has built yet.
    const hint = existsSync(bin) ? '' : ' - is it built? (pnpm build)'
    inactive('evidence-layer could not be loaded (' + (error instanceof Error ? error.message : String(error)) + ')' + hint)
  }
}
