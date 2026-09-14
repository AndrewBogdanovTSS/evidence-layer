/**
 * `check:all` core - does anything actually run the checks?
 *
 * The claim it makes falsifiable: **"this is enforced."**
 *
 * Every other module here checks something about the code or a review. This
 * one checks the checks. It exists because of the least interesting and most
 * common failure in this whole area: the rule was written, the tool was built,
 * the documentation said it was enforced, and nothing ever ran it. A rule with
 * no trigger is decoration, and nothing in an ordinary repository can tell a
 * decorative rule from a live one.
 *
 * So: a decision record may declare an invariant and name the command that
 * enforces it. This resolves that command against the package scripts and
 * follows the trigger graph - git hooks and CI workflows, expanded through the
 * scripts they call - to find out whether anything reaches it. An invariant no
 * trigger reaches is a finding.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Finding } from './cli'

export interface Invariant {
  text: string
  /** The command named after "enforced by", if any. */
  command?: string
  file: string
  /**
   * True when the invariant explicitly discloses that its trigger is composed
   * at runtime rather than written as a literal string - see the reachability
   * caveat below. Self-disclosed, not detected: detecting dynamic composition
   * in general is a static-analysis problem this checker does not attempt.
   */
  runtimeComposed: boolean
}

const RUNTIME_COMPOSED_RE = /\(runtime-composed trigger\)/i

/** Reads `enforced by \`<command>\`` clauses out of every decision record. */
export function readInvariants(decisionsDir: string): Invariant[] {
  if (!existsSync(decisionsDir)) return []
  const invariants: Invariant[] = []
  for (const file of readdirSync(decisionsDir).filter((f) => f.endsWith('.md'))) {
    const text = readFileSync(join(decisionsDir, file), 'utf8')
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!front) continue
    for (const line of front[1]!.split(/\r?\n/)) {
      const item = /^\s*-\s+(.*\S)\s*$/.exec(line)
      if (!item || !/enforced by/i.test(item[1]!)) continue
      const command = /enforced by\s+`([^`]+)`/i.exec(item[1]!)?.[1]
      invariants.push({
        text: item[1]!,
        command,
        file: join(decisionsDir, file),
        runtimeComposed: RUNTIME_COMPOSED_RE.test(item[1]!),
      })
    }
  }
  return invariants
}

/**
 * Every command a wired trigger can reach.
 *
 * Triggers are the git hooks in `.githooks/` and the `run:` steps of the GitHub
 * workflows - the two places in a repository where something executes without
 * a human choosing to. Those are then expanded through `package.json` scripts,
 * because a hook that runs `pnpm check:all` also reaches everything that script
 * runs, and through the source of any script file a script invokes in turn.
 */
export function reachableCommands(repo: string): Set<string> {
  const scripts = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }).scripts ?? {}

  const seeds: string[] = []
  const hooksDir = join(repo, '.githooks')
  if (existsSync(hooksDir)) {
    for (const f of readdirSync(hooksDir)) seeds.push(readFileSync(join(hooksDir, f), 'utf8'))
  }
  const wfDir = join(repo, '.github', 'workflows')
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
      seeds.push(readFileSync(join(wfDir, f), 'utf8'))
    }
  }

  // npm special-cases four script names (`test`, `start`, `stop`, `restart`)
  // to run without the word `run` - `npm test`, not `npm run test`. A scanner
  // that only recognised `npm run <name>` would report `test` as unreached in
  // any project using the shorthand, which is most of them. Found by building
  // the portability fixture against a plain npm project rather than assumed.
  const NPM_SHORTHAND = new Set(['test', 'start', 'stop', 'restart'])

  const reached = new Set<string>()
  const queue = [...seeds]
  while (queue.length > 0) {
    const text = queue.pop()!
    for (const [name, body] of Object.entries(scripts)) {
      const escaped = name.replace(/[:*]/g, '\\$&')
      const patterns = ['(?:pnpm|npm run|yarn)\\s+(?:run\\s+)?' + escaped + '\\b']
      if (NPM_SHORTHAND.has(name)) patterns.push('npm\\s+' + escaped + '\\b')
      const invoked = new RegExp(patterns.join('|'))
      if (!invoked.test(text) || reached.has(name)) continue
      reached.add(name)
      queue.push(body)
      // A script body is often just `tsx scripts/x.ts`, and that file may run
      // further commands of its own - one script reaching another this way.
      const script = /tsx\s+([\w./-]+\.ts)/.exec(body)?.[1]
      const scriptPath = script ? join(repo, script) : undefined
      if (scriptPath && existsSync(scriptPath)) queue.push(readFileSync(scriptPath, 'utf8'))
    }
  }
  return reached
}

/**
 * Commands built at runtime are invisible to the scan above, so reachability is
 * an under-approximation: it can say "nothing reaches this" when something does.
 * That limit is stated rather than hidden, because a checker whose blind spots
 * are undocumented is a checker nobody can calibrate against.
 *
 * An invariant can self-disclose this exact situation by appending
 * `(runtime-composed trigger)` to its "enforced by" clause - see
 * `demo/decisions/runtime-composed/decision.md`. That downgrades an unreached
 * command from a false `error` to an honest `unverifiable`, which is not the
 * same relief as a `pass`: it still says, every run, that nobody can currently
 * tell whether this is wired up.
 */
export const REACHABILITY_CAVEAT =
  'reachability is computed from literal command strings; a command assembled at runtime will not be seen'

export function checkReachability(repo: string, decisionsDir?: string): Finding[] {
  const invariants = readInvariants(decisionsDir ?? join(repo, 'docs', 'decisions'))
  if (invariants.length === 0) {
    return [
      {
        level: 'warning',
        claim: 'decision records declare enforceable invariants',
        detail: 'no decision records with invariants found - nothing to resolve',
      },
    ]
  }

  const reached = reachableCommands(repo)
  const scripts = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }).scripts ?? {}

  return invariants.map((inv): Finding => {
    const claim = inv.text.length > 90 ? inv.text.slice(0, 90) + '...' : inv.text
    // Repo-relative, so the output is the same on every machine and can be
    // pasted into a review without leaking someone's home directory.
    const file = relative(repo, inv.file).replace(/\\/g, '/')
    if (!inv.command) {
      return { level: 'warning', claim, detail: 'names no runnable command, so its enforcement cannot be checked', file }
    }
    // `pnpm check:claims demo/x.md` -> `check:claims`. `npm run check:claims`
    // -> `check:claims`. `npm test` -> `test` (npm's shorthand form, stripped
    // of the leading package-manager name but not of a `run` that never
    // appeared) - found while building the portability fixture, where an
    // invariant written the natural way for an npm project ("enforced by
    // `npm test`") was misread as naming a script called "npm".
    const scriptName = inv.command.replace(/^(?:pnpm|npm run|npm|yarn run|yarn)\s+/, '').split(/\s+/)[0]!
    if (!(scriptName in scripts)) {
      return { level: 'error', claim, detail: '"' + inv.command + '" is not a script in package.json', file }
    }
    if (!reached.has(scriptName)) {
      if (inv.runtimeComposed) {
        return {
          level: 'unverifiable',
          claim,
          detail: '`' + scriptName + '` self-disclosed as a runtime-composed trigger - ' + REACHABILITY_CAVEAT,
          file,
        }
      }
      return { level: 'error', claim, detail: '`' + scriptName + '` exists but no trigger reaches it. It is documented, not enforced.', file }
    }
    return { level: 'pass', claim, detail: '`' + scriptName + '` is reachable from a wired trigger', file }
  })
}
