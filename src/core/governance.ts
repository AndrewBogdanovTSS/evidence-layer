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
 * follows the trigger graph - git hooks, GitHub workflows and Azure Pipelines
 * files, expanded through the scripts they call - to find out whether anything
 * reaches it. An invariant no trigger reaches is a finding.
 *
 * What it deliberately does not do: ask a CI service what it runs. Whether a
 * GitHub workflow is enabled, or an Azure file has a pipeline pointed at it,
 * is a server setting; this reads the repository, and a pass names the file
 * that reached the command so a reader can tell which kind of claim it is.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { CodedFinding } from './codes'

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

/** A file something executes without a human choosing to, by its repo-relative path. */
export interface TriggerSource {
  path: string
  text: string
  /** An Azure Pipelines file: it runs only once a pipeline in Azure DevOps points at it. */
  azure: boolean
}

/**
 * Where Azure Pipelines files live. Unlike `.github/workflows`, Azure has no
 * fixed place - a pipeline is created in Azure DevOps and pointed at a path -
 * so these are the names projects use, `azure-pipelines.yml` being the one
 * Azure DevOps suggests. A pipeline file anywhere else is seen only when one
 * of these includes it as a template.
 */
const AZURE_DIRS = ['.azure-pipelines', 'azure-pipelines', '.azuredevops', '.pipelines']
const YAML = /\.ya?ml$/

function yamlFilesUnder(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? yamlFilesUnder(join(dir, e.name)) : YAML.test(e.name) ? [join(dir, e.name)] : [],
  )
}

/**
 * Every trigger file the repository carries, and the Azure templates its
 * pipelines name that could not be read here.
 *
 * Triggers are the git hooks in `.githooks/`, the GitHub workflows, and the
 * Azure Pipelines files - the places in a repository where something executes
 * without a human choosing to. An Azure file can pull steps from another with
 * `template:`; a local one is read as part of the pipeline, while one from
 * another repository (`x.yml@tools`), one whose path is computed (`${{ }}`) or
 * one that is not there is listed as unread - its steps could reach anything.
 */
export function triggerSources(repo: string): { sources: TriggerSource[]; unread: string[] } {
  const sources: TriggerSource[] = []
  const unread: string[] = []
  const rel = (path: string) => relative(repo, path).replace(/\\/g, '/')

  const hooksDir = join(repo, '.githooks')
  if (existsSync(hooksDir)) {
    for (const f of readdirSync(hooksDir)) sources.push({ path: '.githooks/' + f, text: readFileSync(join(hooksDir, f), 'utf8'), azure: false })
  }
  const wfDir = join(repo, '.github', 'workflows')
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir).filter((n) => YAML.test(n))) {
      sources.push({ path: '.github/workflows/' + f, text: readFileSync(join(wfDir, f), 'utf8'), azure: false })
    }
  }

  const azure = [
    ...readdirSync(repo).filter((n) => /^azure-pipelines.*\.ya?ml$/.test(n)).map((n) => join(repo, n)),
    ...AZURE_DIRS.flatMap((d) => yamlFilesUnder(join(repo, d))),
  ]
  const seen = new Set<string>()
  while (azure.length > 0) {
    const file = azure.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    sources.push({ path: rel(file), text, azure: true })
    for (const line of text.split(/\r?\n/)) {
      const ref = /^\s*(?:-\s+)?template:\s*(.*?)\s*(?:#.*)?$/.exec(line)?.[1]?.replace(/^(['"])(.*)\1$/, '$2')
      if (!ref) continue
      const at = ref.lastIndexOf('@')
      const local = at === -1 || ref.slice(at + 1) === 'self'
      const path = local && at !== -1 ? ref.slice(0, at) : ref
      if (!local || /\$\{\{|\$\(|\$\[/.test(path)) {
        unread.push(ref)
        continue
      }
      // Azure resolves a template against the file that names it, or the repository root for `/x.yml`.
      const target = path.startsWith('/') ? join(repo, path.slice(1)) : join(dirname(file), path)
      if (existsSync(target)) azure.push(target)
      else unread.push(ref + ' (not found)')
    }
  }
  return { sources, unread: [...new Set(unread)] }
}

/**
 * Every command a wired trigger can reach, and the trigger that reaches it
 * first.
 *
 * The trigger files are expanded through `package.json` scripts, because a
 * hook that runs `pnpm check:all` also reaches everything that script runs,
 * and through the source of any script file a script invokes in turn.
 */
export function traceTriggers(repo: string): { reached: Map<string, TriggerSource>; unread: string[] } {
  const scripts = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }).scripts ?? {}
  const { sources, unread } = triggerSources(repo)

  // npm special-cases four script names (`test`, `start`, `stop`, `restart`)
  // to run without the word `run` - `npm test`, not `npm run test`. A scanner
  // that only recognised `npm run <name>` would report `test` as unreached in
  // any project using the shorthand, which is most of them. Found by building
  // the portability fixture against a plain npm project rather than assumed.
  const NPM_SHORTHAND = new Set(['test', 'start', 'stop', 'restart'])

  // Each text is traced on behalf of the trigger it came from. A script a git
  // hook or workflow reaches is credited to it before an Azure file, which can
  // say less: whether a pipeline runs it is set in Azure DevOps, not here.
  const reached = new Map<string, TriggerSource>()
  const queue = [...sources].sort((a, b) => Number(b.azure) - Number(a.azure)).map((s) => ({ text: s.text, via: s }))
  while (queue.length > 0) {
    const { text, via } = queue.pop()!
    for (const [name, body] of Object.entries(scripts)) {
      const escaped = name.replace(/[:*]/g, '\\$&')
      const patterns = ['(?:pnpm|npm run|yarn)\\s+(?:run\\s+)?' + escaped + '\\b']
      if (NPM_SHORTHAND.has(name)) patterns.push('npm\\s+' + escaped + '\\b')
      const invoked = new RegExp(patterns.join('|'))
      if (!invoked.test(text) || reached.has(name)) continue
      reached.set(name, via)
      queue.push({ text: body, via })
      // A script body is often just `tsx scripts/x.ts`, and that file may run
      // further commands of its own - one script reaching another this way.
      const script = /tsx\s+([\w./-]+\.ts)/.exec(body)?.[1]
      const scriptPath = script ? join(repo, script) : undefined
      if (scriptPath && existsSync(scriptPath)) queue.push({ text: readFileSync(scriptPath, 'utf8'), via })
    }
  }
  return { reached, unread }
}

/** Every command a wired trigger can reach - `traceTriggers` without saying which. */
export function reachableCommands(repo: string): Set<string> {
  return new Set(traceTriggers(repo).reached.keys())
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

export function checkReachability(repo: string, decisionsDir?: string): CodedFinding[] {
  const invariants = readInvariants(decisionsDir ?? join(repo, 'docs', 'decisions'))
  if (invariants.length === 0) {
    return [
      {
        level: 'warning',
        code: 'governance/no-invariants',
        claim: 'decision records declare enforceable invariants',
        detail: 'no decision records with invariants found - nothing to resolve',
      },
    ]
  }

  const { reached, unread } = traceTriggers(repo)
  const scripts = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }).scripts ?? {}

  return invariants.map((inv): CodedFinding => {
    const claim = inv.text.length > 90 ? inv.text.slice(0, 90) + '...' : inv.text
    // Repo-relative, so the output is the same on every machine and can be
    // pasted into a review without leaking someone's home directory.
    const file = relative(repo, inv.file).replace(/\\/g, '/')
    if (!inv.command) {
      return { level: 'warning', code: 'governance/no-command', claim, detail: 'names no runnable command, so its enforcement cannot be checked', file }
    }
    // `pnpm check:claims demo/x.md` -> `check:claims`. `npm run check:claims`
    // -> `check:claims`. `npm test` -> `test` (npm's shorthand form, stripped
    // of the leading package-manager name but not of a `run` that never
    // appeared) - found while building the portability fixture, where an
    // invariant written the natural way for an npm project ("enforced by
    // `npm test`") was misread as naming a script called "npm".
    const scriptName = inv.command.replace(/^(?:pnpm|npm run|npm|yarn run|yarn)\s+/, '').split(/\s+/)[0]!
    if (!(scriptName in scripts)) {
      return { level: 'error', code: 'governance/unknown-script', claim, detail: '"' + inv.command + '" is not a script in package.json', file }
    }
    if (!reached.has(scriptName)) {
      if (inv.runtimeComposed) {
        return {
          level: 'unverifiable',
          code: 'governance/runtime-composed',
          claim,
          detail: '`' + scriptName + '` self-disclosed as a runtime-composed trigger - ' + REACHABILITY_CAVEAT,
          file,
        }
      }
      // Not reached by anything readable, but a template that was not read
      // could run it: an error here would be a guess, and so would a pass.
      if (unread.length > 0) {
        return {
          level: 'unverifiable',
          code: 'governance/template-unread',
          claim,
          detail: '`' + scriptName + '` is reached by no trigger readable here, and these pipeline templates could not be read: ' + unread.join(', '),
          file,
        }
      }
      return {
        level: 'error',
        code: 'governance/unreached',
        claim,
        detail: '`' + scriptName + '` exists but no trigger reaches it. It is documented, not enforced.',
        file,
      }
    }
    const via = reached.get(scriptName)!
    const detail = '`' + scriptName + '` is reachable from a wired trigger, `' + via.path + '`' +
      (via.azure ? ' - an Azure Pipelines file, which runs once a pipeline in Azure DevOps points at it; no file here can show that one does' : '')
    return { level: 'pass', code: 'governance/reached', claim, detail, file }
  })
}
