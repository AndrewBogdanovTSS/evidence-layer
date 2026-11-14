/**
 * `evidence-layer init claude|codex` - wires the runtime gate into a
 * project's agent configuration, explicitly, on request.
 *
 * Never run at install time. A package that writes into a project's agent
 * configuration from a postinstall script is deciding for the project what
 * its agent may do, and this one does not get to.
 *
 * Claude Code reads `.claude/settings.json`; Codex reads `.codex/hooks.json`.
 * The two files have the same shape - event, matcher groups, command hooks -
 * so one merge serves both. It owns exactly the entries whose command is this
 * package's hook command (`evidence-layer... hook claude|codex <event>`) and
 * touches nothing else: every other hook, matcher group and setting is kept as
 * it was. Its own entries are replaced in place, so running it again - after
 * an upgrade, or with different flags - leaves one entry per event, and the
 * same input gives the same file byte for byte.
 *
 * The hooks do not run the package straight out of `node_modules`. They run
 * a launcher this command writes beside the configuration
 * (`evidence-layer-hook.mjs` - the file the Claude Code plugin runs, carried
 * in the build as text), which finds the installed package and, when there
 * is none, says so through the hook protocol. Before 0.20.0 the command was
 * `node .../node_modules/evidence-layer/dist/bin/evidence-layer.mjs hook ...`,
 * and on a fresh clone - every cloud or CI agent session before its install
 * step - that was "Cannot find module" and exit 1: a broken hook to the
 * host, an ungated session to everyone else, and nothing said to either.
 *
 * Claude Code gives a hook `$CLAUDE_PROJECT_DIR`; Codex gives none, runs the
 * command through `$SHELL -lc` (`cmd.exe /C` on Windows) in the session's
 * working directory, and its documentation resolves the repository with
 * `git rev-parse --show-toplevel` - so that is how the Codex command finds
 * the launcher. `cmd.exe` has no `$(...)`, so the Windows form
 * (`commandWindows`) still uses `npx --no-install`, which finds the installed
 * package from any directory inside the project at the cost of a slower
 * start - and, with nothing installed, still fails rather than explains.
 *
 * Run in this package's own repository, it wires this checkout's build
 * instead of `node_modules/evidence-layer`, which a package never has of
 * itself - for Claude Code through the plugin's launcher, which says the gate
 * is inactive when the checkout is not built rather than failing the hook.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, help, parseArgs, usage } from '../core/cli'

const HELP = `
evidence-layer init claude|codex [--local] [--dry-run] [--repo <path>] [--review <paths>]
                                 [--fail-closed] [--keep-blocking] [--strict]

Adds the runtime gate's hooks to .claude/settings.json (or, with --local, to
.claude/settings.local.json, which is not meant to be committed), or for codex
to .codex/hooks.json. Keeps every hook that is not evidence-layer's; replaces
evidence-layer's own in place.

  --local     claude only: write settings.local.json
  --dry-run   print the file it would write, and write nothing
  --repo      the project root (default: the current directory)
  --review, --fail-closed, --keep-blocking, --strict
              passed through to \`evidence-layer hook\` - see its --help

exit 0 = written (or printed), 2 = bad usage
`

type HookEntry = { type: string; command: string; timeout?: number; [key: string]: unknown }
type MatcherGroup = { matcher?: string; hooks: HookEntry[]; [key: string]: unknown }
type Settings = { hooks?: Record<string, MatcherGroup[]>; [key: string]: unknown }

/**
 * An entry is this package's when its command runs this package's hook for a
 * host - nothing looser: the launcher `init` writes, the plugin's, or the
 * package's own `hook` command, which is what `init` wrote before 0.20.0 and
 * still writes for Codex on Windows.
 */
export const OWNED_COMMAND_RE =
  /(?:evidence-layer(?:\.mjs)?["']?\s+hook\s+(?:claude|codex)|evidence-layer\/scripts\/run-hook\.mjs["']?|evidence-layer-hook\.mjs["']?)\s+(?:session-start|pre-tool-use|stop)\b/

/** The launcher's file name, beside the configuration `init` writes: `.claude/` or `.codex/`. */
export const HOOK_FILE = 'evidence-layer-hook.mjs'

declare const __EVIDENCE_LAYER_LAUNCHER__: string | undefined

/**
 * The launcher's text: substituted at build time from the file the plugin
 * runs (see `tsdown.config.ts`), and read from that file when this runs from
 * source, where nothing was substituted.
 */
export function launcherSource(): string {
  if (typeof __EVIDENCE_LAYER_LAUNCHER__ === 'string') return __EVIDENCE_LAYER_LAUNCHER__
  return readFileSync(fileURLToPath(new URL('../../plugins/evidence-layer/scripts/run-hook.mjs', import.meta.url)), 'utf8')
}

/** What `--review` may hold: paths a shell has no reason to touch - no spaces, quotes, `$`, backticks or separators. */
export const REVIEW_PATHS_RE = /^[\w./,@+-]+$/

/** Everything in the hook command before the event name. */
export const LAUNCHER = 'node "$CLAUDE_PROJECT_DIR/.claude/' + HOOK_FILE + '"'
export const SELF_LAUNCHER = 'node "$CLAUDE_PROJECT_DIR/plugins/evidence-layer/scripts/run-hook.mjs"'

/** The Codex hook command, POSIX shell and `cmd.exe` forms, before the event name. */
export const CODEX_LAUNCHER = {
  command: 'node "$(git rev-parse --show-toplevel)/.codex/' + HOOK_FILE + '"',
  commandWindows: 'npx --no-install evidence-layer hook codex',
}
export const CODEX_SELF_LAUNCHER = {
  command: 'node "$(git rev-parse --show-toplevel)/dist/bin/evidence-layer.mjs" hook codex',
  commandWindows: 'node dist\\bin\\evidence-layer.mjs hook codex',
}

/** True when `repo` is this package's own repository, which runs its gate from its own build. */
export function isOwnRepository(repo: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { name?: unknown }
    return manifest.name === 'evidence-layer' && existsSync(join(repo, 'plugins', 'evidence-layer', 'scripts', 'run-hook.mjs'))
  } catch {
    return false
  }
}

interface EventSpec {
  name: string
  arg: string
  matcher?: string
  timeout: number
}

const CLAUDE_EVENTS: EventSpec[] = [
  { name: 'SessionStart', arg: 'session-start', timeout: 10 },
  { name: 'PreToolUse', arg: 'pre-tool-use', matcher: 'Write|Edit|MultiEdit|NotebookEdit', timeout: 10 },
  { name: 'Stop', arg: 'stop', timeout: 120 },
]

// Codex sends a file edit as `apply_patch`, and also matches it as `Edit` and
// `Write`; its matchers are regular expressions. Stop takes no matcher.
const CODEX_EVENTS: EventSpec[] = [
  { name: 'SessionStart', arg: 'session-start', timeout: 10 },
  { name: 'PreToolUse', arg: 'pre-tool-use', matcher: 'apply_patch|Edit|Write', timeout: 10 },
  { name: 'Stop', arg: 'stop', timeout: 120 },
]

/** One merge for both hosts' files: drop this package's old entries, keep everything else, add one entry per event. */
function mergeHooks(settings: Settings, events: EventSpec[], entry: (event: EventSpec) => HookEntry): Settings {
  const hooks: Record<string, MatcherGroup[]> = { ...(settings.hooks ?? {}) }
  for (const event of events) {
    const kept = (hooks[event.name] ?? [])
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !OWNED_COMMAND_RE.test(h.command ?? '')) }))
      .filter((group) => group.hooks.length > 0)
    kept.push({ ...(event.matcher !== undefined && { matcher: event.matcher }), hooks: [entry(event)] })
    hooks[event.name] = kept
  }
  return { ...settings, hooks }
}

/** Merges the gate's hooks into Claude Code settings, returning a new object. Pure, so it can be tested without a disk. */
export function mergeClaudeSettings(settings: Settings, flags: string[], launcher = LAUNCHER): Settings {
  return mergeHooks(settings, CLAUDE_EVENTS, (e) => ({ type: 'command', command: [launcher, e.arg, ...flags].join(' '), timeout: e.timeout }))
}

/** Merges the gate's hooks into a Codex `hooks.json`, returning a new object. */
export function mergeCodexHooks(settings: Settings, flags: string[], launcher = CODEX_LAUNCHER): Settings {
  // The launcher is told which host it speaks for; a command that already
  // names one - this repository's own, the Windows form - is not.
  const host = launcher.command.endsWith(HOOK_FILE + '"') ? ['--host=codex'] : []
  return mergeHooks(settings, CODEX_EVENTS, (e) => ({
    type: 'command',
    command: [launcher.command, e.arg, ...host, ...flags].join(' '),
    commandWindows: [launcher.commandWindows, e.arg, ...flags].join(' '),
    timeout: e.timeout,
  }))
}

export function run(argv: string[]): void {
  const args = parseArgs(argv)
  if (args.help) help(HELP)
  const [host] = args._ as string[]
  if (host !== 'claude' && host !== 'codex') usage(HELP)
  if (host === 'codex' && args.local === true) usage(HELP)

  const repo = typeof args.repo === 'string' ? args.repo : process.cwd()
  const dir = join(repo, host === 'claude' ? '.claude' : '.codex')
  const file = join(dir, host === 'codex' ? 'hooks.json' : args.local === true ? 'settings.local.json' : 'settings.json')

  let settings: Settings = {}
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8')) as Settings
    } catch {
      console.error(file + ' is not valid JSON - fix it first; nothing was written')
      process.exit(EXIT.usage)
    }
  }

  const flags: string[] = []
  if (typeof args.review === 'string') {
    // The value goes onto a command line the host hands to its shell - on
    // every session, for everyone who checks the file out. Quoting it would
    // mean getting POSIX sh and cmd.exe quoting both right; a review path
    // needs neither, so anything a shell would interpret is refused instead.
    if (!REVIEW_PATHS_RE.test(args.review)) {
      console.error('--review takes comma-separated paths of letters, digits and . _ / , @ + - only; nothing was written')
      process.exit(EXIT.usage)
    }
    flags.push('--review ' + args.review)
  }
  for (const flag of ['fail-closed', 'keep-blocking', 'strict']) if (args[flag] === true) flags.push('--' + flag)

  const own = isOwnRepository(repo)
  const merged =
    host === 'claude'
      ? mergeClaudeSettings(settings, flags, own ? SELF_LAUNCHER : LAUNCHER)
      : mergeCodexHooks(settings, flags, own ? CODEX_SELF_LAUNCHER : CODEX_LAUNCHER)
  const text = JSON.stringify(merged, null, 2) + '\n'
  // This package's own repository runs the plugin's copy, where it already is.
  const hookFile = own ? null : join(dir, HOOK_FILE)
  if (args['dry-run'] === true) {
    console.log('would write ' + file + (hookFile ? ', and the launcher it runs to ' + hookFile : '') + ':\n')
    console.log(text)
    process.exit(EXIT.ok)
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, text, 'utf8')
  if (hookFile) writeFileSync(hookFile, launcherSource(), 'utf8')
  console.log('wrote ' + file + ': SessionStart, PreToolUse and Stop now run evidence-layer\'s gate')
  if (hookFile) console.log('wrote ' + hookFile + ': the launcher those hooks run - commit it with the configuration')
  console.log(
    own
      ? 'this is evidence-layer\'s own repository: the gate runs the dist/ of the last pnpm build'
      : 'it needs evidence-layer installed in this project (npm install --save-dev evidence-layer); until it is, a session is told the gate is inactive',
  )
  if (host === 'codex') {
    // Codex skips a project hook nobody has reviewed, and re-asks whenever its
    // command changes - including after this command runs again with new flags.
    console.log('Codex runs project hooks only once they are trusted: open /hooks in Codex and approve these three')
  }
}
