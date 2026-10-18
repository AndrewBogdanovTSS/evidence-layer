/**
 * `evidence-layer hook <host> <event>` - the entry point an agent host runs.
 *
 * Reads the host's hook input on stdin, lets `core/gate` decide, and writes
 * the decision in the host's own protocol. Unlike every other command here it
 * **always exits 0**: the host reads exit codes as decisions (Claude Code
 * reads `2` as "block", and `2` is this package's bad-usage code), so every
 * outcome - a block, a crash, unreadable input - travels as protocol output
 * instead. An internal failure becomes a decision under `--fail-closed` or the
 * default fail-open policy, never an accidental one.
 *
 * Loads only what the event needs: the pre-write check - which runs before
 * every file the agent writes - is `core/protect` and nothing else; the
 * rest of the gate is loaded for session start and stop alone. None of it
 * goes through the package index, so no hook loads governance, the journal
 * reader or the CI renderer.
 */
import { readFileSync } from 'node:fs'
import { help, parseArgs } from '../core/cli'
import { gateFailure } from '../core/gate-decision'
import type { GateDecision, GateEvent, GateOptions } from '../core/gate-decision'
import type { HostAdapter } from '../hosts/contract'

const HELP = `
evidence-layer hook <host> <event> [--review <paths>] [--fail-closed] [--keep-blocking] [--strict]

Runs the runtime gate for one agent-host hook event: input on stdin, the
decision on stdout in the host's own protocol. Always exits 0.

  hosts       claude (events: session-start, pre-tool-use, stop)
  --review    comma-separated review files to check at stop (default: review.md)
  --fail-closed    block instead of allowing when the gate itself cannot run
  --keep-blocking  never let a retry episode run out of blocks
  --strict    both of the above, and block on unverifiable findings too

Set up by \`evidence-layer init claude\`, or by the Claude Code plugin in this
package's repository.
`

const HOSTS: Record<string, () => Promise<HostAdapter>> = {
  claude: async () => (await import('../hosts/claude-code')).claudeCode,
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

async function decideLazily(event: GateEvent, opts: GateOptions): Promise<GateDecision> {
  if (event.kind === 'pre-write') return (await import('../core/protect')).decidePreWrite(event, opts)
  return (await import('../core/gate')).decide(event, opts)
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  if (args.help) help(HELP)
  const [hostName, event] = args._ as string[]

  const load = hostName ? HOSTS[hostName] : undefined
  const host = load ? await load() : undefined
  const kind = host && event ? host.kindOf(event) : null
  if (!host || !kind) {
    // Nothing to render a decision in, so say so where a person will see it
    // and stay out of the way: an exit code here would be read as a verdict.
    console.error('evidence-layer hook: unknown host or event: ' + [hostName, event].filter(Boolean).join(' '))
    process.exitCode = 0
    return
  }

  const strict = args.strict === true
  const opts: GateOptions = {
    failClosed: strict || args['fail-closed'] === true,
    keepBlocking: strict || args['keep-blocking'] === true,
    strict,
    ...(typeof args.review === 'string' && {
      reviewPaths: args.review.split(',').map((p) => p.trim()).filter(Boolean),
    }),
  }

  let decision: GateDecision | null
  try {
    const parsed = host.parse(event!, readStdin())
    decision = parsed ? await decideLazily(parsed, opts) : null
  } catch (error) {
    decision = gateFailure(kind, error, opts)
  }
  if (decision) {
    const out = host.render(decision, kind)
    if (out) process.stdout.write(out + '\n')
  }
  process.exitCode = 0
}
