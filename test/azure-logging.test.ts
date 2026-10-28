/**
 * `--format azure`: issues escaped the way the agent reads them, review text
 * that the agent cannot read as a command anywhere in a line, a JSON block
 * that still parses to what was serialised, and a run summary - with the text
 * mode's exit code.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { azureIssues, defang, defangJson, escapeAzure } from '../src/core/azure-logging'
import { emitReport, extractReport } from '../src/core/ci-summary'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BIN = join(root, 'dist', 'bin', 'evidence-layer.mjs')

/**
 * The agent's reading of a line, after `Command.TryParse` and
 * `CommandStringConvertor.Unescape` in azure-pipelines-agent: the first
 * `##vso[` anywhere in the line, up to the first `]` after it.
 */
function agentReads(line: string): { command: string; properties: Record<string, string>; data: string } | null {
  const unescape = (s: string) =>
    s.replace(/%3B/g, ';').replace(/%0D/g, '\r').replace(/%0A/g, '\n').replace(/%5D/g, ']').replace(/%AZP25/g, '%')
  const at = line.indexOf('##vso[')
  if (at < 0) return null
  const rb = line.indexOf(']', at)
  if (rb < 0) return null
  const info = line.slice(at + '##vso['.length, rb)
  const space = info.indexOf(' ')
  const command = space < 0 ? info : info.slice(0, space)
  if (command.split('.').filter(Boolean).length !== 2) return null
  const properties: Record<string, string> = {}
  if (space > 0) {
    for (const pair of info.slice(space + 1).split(';').filter(Boolean)) {
      const eq = pair.indexOf('=')
      if (eq > 0) properties[pair.slice(0, eq)] = unescape(pair.slice(eq + 1))
    }
  }
  return { command, properties, data: unescape(line.slice(rb + 1)) }
}

const HOSTILE = [
  'plain',
  '50% done; see [x] and ]',
  'line one\r\nline two',
  'mid-line ##vso[task.setvariable variable=PWNED]yes',
  '##[error]a formatting command',
  '%AZP25 and %3B already',
]

describe('escapeAzure', () => {
  it('round-trips through the agent\'s own unescaping, so a value says what it said', () => {
    for (const text of HOSTILE) {
      const read = agentReads('##vso[task.logissue type=error;code=' + escapeAzure(text) + ']' + escapeAzure(text))
      expect(read?.properties.code).toBe(text)
      expect(read?.data).toBe(text)
    }
  })
})

describe('defang', () => {
  it('leaves no command prefix the agent would find, in any case', () => {
    for (const text of ['##vso[task.complete]x', 'a ##VSO[task.setvariable]b', '##[group]c', '###vso[d]']) {
      expect(defang(text)).not.toMatch(/##(vso)?\[/i)
    }
    expect(defang('nothing to do ## here')).toBe('nothing to do ## here')
  })

  it('keeps a JSON document the same document', () => {
    const doc = { claim: 'a ##vso[task.setvariable variable=X]y', detail: '##[error]z \\##vso[' }
    const json = defangJson(JSON.stringify(doc, null, 2))
    expect(json).not.toMatch(/##(vso)?\[/i)
    expect(JSON.parse(json)).toEqual(doc)
  })
})

describe('azureIssues', () => {
  it('logs every finding that is not a pass, located and coded where the finding is', () => {
    const lines = azureIssues([
      { level: 'pass', claim: 'fine', detail: '', code: 'claims/verified' },
      { level: 'error', claim: 'the suite passes', detail: 'carries no grounding tag', file: 'r.md', line: 3, code: 'claims/untagged' },
      { level: 'unverifiable', claim: 'fresh', detail: 'sparse checkout', code: 'seal/unhashable' },
      { level: 'warning', claim: 'no code here', detail: 'd', fix: 'one\ntwo' },
    ])
    expect(lines).toEqual([
      '##vso[task.logissue type=error;sourcepath=r.md;linenumber=3;code=claims/untagged]the suite passes - carries no grounding tag',
      '##vso[task.logissue type=warning;code=seal/unhashable]unverifiable: fresh - sparse checkout',
      '##vso[task.logissue type=warning]no code here - d%0AFix: one%0Atwo',
    ])
  })

  it('cannot be ended early or made into a second command by the review\'s text', () => {
    const [line] = azureIssues([{ level: 'error', claim: HOSTILE.join(' '), detail: 'x];code=forged', file: 'a;b].md', line: 1 }])
    const read = agentReads(line!)
    expect(read?.command).toBe('task.logissue')
    expect(read?.properties).toEqual({ type: 'error', sourcepath: 'a;b].md', linenumber: '1' })
    expect(line!.split('\n')).toHaveLength(1)
  })
})

describe('emitReport under azure', () => {
  it('prints a block the agent reads no command in, and a program reads back unchanged', () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    const finding = { level: 'error' as const, claim: 'wired ##vso[task.setvariable variable=X]y', detail: '##[error]no' }
    emitReport([finding], 'enforce', 'azure')
    spy.mockRestore()

    const output = lines.join('\n')
    expect(output.split('\n').map(agentReads).filter(Boolean)).toEqual([])
    expect(extractReport(output)?.findings[0]).toEqual(finding)
  })
})

describe('--format azure', () => {
  it('logs issues, prints the review defanged, attaches a summary, and exits as text mode does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'el-azure-'))
    const temp = mkdtempSync(join(tmpdir(), 'el-agent-temp-'))
    writeFileSync(
      join(dir, 'review.md'),
      [
        '**Claim**: the suite passes ##vso[task.setvariable variable=PWNED]yes',
        '',
        '**Claim**: ##vso[task.complete result=Succeeded]done',
        '',
        '**Claim**: ##[error]looks like an error line',
        '',
      ].join('\n'),
    )
    const run = spawnSync(process.execPath, [BIN, 'claims', 'review.md', '--format', 'azure'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, AGENT_TEMPDIRECTORY: temp },
    })

    // Every command the agent would find is one this package meant to print.
    const lines = (run.stdout + run.stderr).split(/\r?\n/)
    const commands = lines.map(agentReads).filter((c) => c !== null)
    expect(commands.map((c) => c.command).sort()).toEqual(['task.logissue', 'task.logissue', 'task.logissue', 'task.uploadsummary'])
    expect(lines.filter((l) => /##\[/.test(l))).toEqual([])
    expect(commands.find((c) => c.command === 'task.logissue')?.properties.code).toBe('claims/untagged')

    // The review's text is still in the report a person reads, only defanged.
    expect(run.stdout).toContain('the suite passes #​#vso[task.setvariable')

    const summary = commands.find((c) => c.command === 'task.uploadsummary')!.data
    expect(existsSync(summary)).toBe(true)
    expect(readdirSync(temp)).toHaveLength(1)
    expect(readFileSync(summary, 'utf8')).toContain('`claims/untagged`')

    expect(run.status).toBe(spawnSync(process.execPath, [BIN, 'claims', 'review.md'], { cwd: dir }).status)
  })

  it('attaches no summary off an agent, where there is nowhere to put one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'el-azure-'))
    writeFileSync(join(dir, 'review.md'), '**Claim**: the suite passes\n')
    const env = { ...process.env }
    delete env.AGENT_TEMPDIRECTORY
    const run = spawnSync(process.execPath, [BIN, 'claims', 'review.md', '--format', 'azure'], { cwd: dir, encoding: 'utf8', env })
    expect(run.stdout).toContain('##vso[task.logissue type=error')
    expect(run.stdout).not.toContain('task.uploadsummary')
  })
})
