#!/usr/bin/env node
/**
 * The plugin's launcher: finds the evidence-layer installed in the project and
 * hands it the hook, in the same process.
 *
 * The plugin ships no copy of the package. The project installs it, at the
 * version the project chose, and this file only has to find it - walking up
 * from the project directory, which covers pnpm workspaces and worktrees
 * inside a repository. Dependency-free, because it has to work in exactly the
 * case where nothing is installed.
 *
 * When the package is missing, or too old to know the hook protocol (it must
 * declare `"evidenceLayer": { "hookProtocol": 1 }` - a capability, not a
 * version comparison), the gate cannot run. That is said through the hook
 * protocol, never through an exit code: SessionStart tells the agent the gate
 * is inactive, and every other event stays out of the way - unless the hook
 * was configured `--fail-closed` or `--strict`, in which case a Stop is
 * blocked, because a strict gate that silently disappears when its package
 * does is not strict.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOOK_PROTOCOL = 1
const [event, ...flags] = process.argv.slice(2)
const strict = flags.includes('--fail-closed') || flags.includes('--strict')

function findPackage(start) {
  let dir = resolve(start)
  for (;;) {
    const manifest = join(dir, 'node_modules', 'evidence-layer', 'package.json')
    if (existsSync(manifest)) return manifest
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
  inactive('the installed evidence-layer ' + (manifest.version ?? '') + ' is too old for this plugin - upgrade it')
} else {
  const bin = join(dirname(manifestPath), manifest.bin?.['evidence-layer'] ?? 'dist/bin/evidence-layer.mjs')
  process.argv = [process.argv[0], bin, 'hook', 'claude', event, ...flags]
  try {
    await import(pathToFileURL(bin).href)
  } catch (error) {
    inactive('evidence-layer could not be loaded (' + (error instanceof Error ? error.message : String(error)) + ')')
  }
}
