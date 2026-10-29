/**
 * The example project's reference loop, run end to end on a standalone copy:
 * its evidence script gathers and seals, a review made of the suggested
 * claims passes `claims --seal`, and editing the code afterwards makes the
 * same review fail - by name, with the file that changed.
 *
 * The copy is made by the project's own `npm run standalone`, because inside
 * this checkout the project is not a repository: git, and so every hook and
 * seal, would answer for evidence-layer instead.
 *
 * This is what `examples/plain-node-project/README.md` tells a reader to do,
 * so a step the README describes that stopped working fails here first.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sh } from './helpers/git'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BIN = join(root, 'dist', 'bin', 'evidence-layer.mjs')

const EXAMPLE = join(root, 'examples', 'plain-node-project')
const standalone = (...args: string[]) =>
  spawnSync(process.execPath, [join(EXAMPLE, 'scripts', 'standalone.mjs'), ...args], { cwd: EXAMPLE, encoding: 'utf8' })

/**
 * The example as someone would have it - its own repository, evidence-layer
 * installed - made by the project's own `npm run standalone`, so the script
 * the README sends a reader to is the one these tests run on.
 */
function standaloneCopy(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'el-example-')), 'widget-counter')
  const res = standalone(dir)
  expect(res.status, res.stderr).toBe(0)
  sh(dir, 'config', 'user.email', 't@t')
  sh(dir, 'config', 'user.name', 't')
  return dir
}

const claims = (dir: string) => {
  const res = spawnSync(process.execPath, [BIN, 'claims', 'review.md', '--seal', '--format', 'json'], { cwd: dir, encoding: 'utf8' })
  return { status: res.status, findings: (JSON.parse(res.stdout) as { findings: { level: string; code: string; detail: string }[] }).findings }
}

describe('npm run standalone', () => {
  it('makes a repository of its own, with the checkout linked in and nothing of the template left over', () => {
    const dir = standaloneCopy()
    // Inside the checkout the answer is evidence-layer's top level, which is
    // why the copy exists: every hook and seal asks git this.
    expect(realpathSync(sh(EXAMPLE, 'rev-parse', '--show-toplevel'))).toBe(realpathSync(root))
    expect(realpathSync(sh(dir, 'rev-parse', '--show-toplevel'))).toBe(realpathSync(dir))
    expect(sh(dir, 'status', '--porcelain')).toBe('')
    expect(realpathSync(join(dir, 'node_modules', 'evidence-layer'))).toBe(realpathSync(root))
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string>; devDependencies: Record<string, string> }
    expect(pkg.devDependencies['evidence-layer']).toBe('file:' + root)
    expect(pkg.scripts.standalone).toBeUndefined()
    expect(existsSync(join(dir, 'scripts', 'standalone.mjs'))).toBe(false)
    expect(existsSync(join(dir, 'evidence.local.md'))).toBe(false)
  })

  it('refuses a directory that already has something in it, and copies nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'el-example-taken-'))
    writeFileSync(join(dir, 'keep.txt'), 'mine\n')
    const res = standalone(dir)
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('not empty')
    expect(readdirSync(dir)).toEqual(['keep.txt'])
  })
})

describe('examples/plain-node-project, end to end', () => {
  it('gathers with counts, passes a review of the suggested claims, and fails it once the code changes', () => {
    const dir = standaloneCopy()
    const gathered = spawnSync(process.execPath, ['scripts/evidence.mjs', '--base', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    expect(gathered.status, gathered.stderr).toBe(0)
    expect(gathered.stdout).toContain('sealed as run')

    const bundle = readFileSync(join(dir, 'evidence.local.md'), 'utf8')
    expect(bundle).toContain('[SUMMARY tests: passed=3 failed=0 skipped=0 todo=0]')
    expect(bundle).toMatch(/## lint\n\n_Not run: /)

    // The review is the skeleton the bundle suggests, left as it is.
    const suggested = /## Suggested claims\n([\s\S]*?)(?:\n## |$)/.exec(bundle)![1]!
    expect(suggested).toMatch(/VERIFIED\[tests-[0-9a-f]{6}: exit=0, passed>=3, failed=0\]/)
    writeFileSync(join(dir, 'review.md'), suggested)

    const clean = claims(dir)
    expect(clean.status).toBe(0)
    expect(clean.findings.every((f) => f.level === 'pass')).toBe(true)
    expect(clean.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['claims/verified', 'seal/provenance', 'seal/fresh']))

    writeFileSync(join(dir, 'index.js'), readFileSync(join(dir, 'index.js'), 'utf8').replace('n + 1', 'n + 2'))
    const stale = claims(dir)
    expect(stale.status).toBe(1)
    expect(stale.findings.find((f) => f.code === 'seal/stale')?.detail).toContain('index.js')
  })

  it('fails the gather when the suite fails, with the bundle still written - so CI can gather instead of running npm test', () => {
    const dir = standaloneCopy()
    writeFileSync(join(dir, 'index.js'), readFileSync(join(dir, 'index.js'), 'utf8').replace('n + 1', 'n + 2'))
    const failing = spawnSync(process.execPath, ['scripts/evidence.mjs', '--base', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    expect(failing.status).toBe(1)
    expect(failing.stderr).toContain('failed: test')
    expect(readFileSync(join(dir, 'evidence.local.md'), 'utf8')).toContain('[SUMMARY tests: passed=0 failed=3')
  })

  it('checks a review written where there is no seal against the bundle the gather wrote', () => {
    const dir = standaloneCopy()
    const gathered = spawnSync(process.execPath, ['scripts/evidence.mjs', '--base', 'HEAD'], { cwd: dir, encoding: 'utf8' })
    expect(gathered.status, gathered.stderr).toBe(0)
    const suggested = /## Suggested claims\n([\s\S]*?)(?:\n## |$)/.exec(readFileSync(join(dir, 'evidence.local.md'), 'utf8'))![1]!

    // The review job: no checkout, no seal - the review and the bundle the gather job uploaded.
    const job = mkdtempSync(join(tmpdir(), 'el-example-review-'))
    writeFileSync(join(job, 'evidence.local.md'), readFileSync(join(dir, 'evidence.local.md')))
    writeFileSync(join(job, 'review.md'), suggested)
    const check = () => {
      const res = spawnSync(process.execPath, [BIN, 'claims', 'review.md', '--bundle', 'evidence.local.md', '--format', 'json'], { cwd: job, encoding: 'utf8' })
      return { status: res.status, codes: (JSON.parse(res.stdout) as { findings: { code: string }[] }).findings.map((f) => f.code) }
    }
    expect(check()).toEqual({ status: 0, codes: expect.arrayContaining(['claims/verified', 'bundle/provenance']) })
    // A line added to the block's output: still a well-formed block, no longer the gatherer's.
    // Not an edit to the counts - Node 22 prints them as TAP and Node 24 does not, and an edit
    // that matches nothing leaves the review as it was.
    const edited = suggested.replace('$ npm test\n', '$ npm test\nall 3 tests pass\n')
    expect(edited).not.toBe(suggested)
    writeFileSync(join(job, 'review.md'), edited)
    expect(check()).toEqual({ status: 1, codes: expect.arrayContaining(['bundle/edited']) })
  })

  it('has a workflow that runs the suite once, inside the gather, and holds the review to the bundle it uploaded', () => {
    // Comments say why; only what the runner reads is held here.
    const workflow = readFileSync(join(EXAMPLE, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/^\s*#.*\n/gm, '')
    const job = (name: string) => new RegExp('^  ' + name + ':\\n([\\s\\S]*?)(?=^  [a-z-]+:\\n|(?![\\s\\S]))', 'm').exec(workflow)?.[1] ?? ''
    expect(workflow).not.toMatch(/npm (?:run )?test\b/)
    expect(job('evidence')).toMatch(/npm run evidence -- --base/)
    expect(job('evidence')).toMatch(/upload-artifact[\s\S]*evidence\.local\.md/)
    expect(job('governance')).not.toContain('needs:')
    expect(job('review')).toMatch(/needs: evidence/)
    expect(job('review')).toMatch(/--disallowedTools Bash/)
    expect(job('review')).toMatch(/bundle: evidence\.local\.md/)
  })

  it('runs the hook commands its .claude and .codex files hold, the way each host runs them', () => {
    const dir = standaloneCopy()
    const command = (file: string) =>
      (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks
        .SessionStart!.at(-1)!.hooks[0]!.command
    const input = JSON.stringify({ session_id: 's', cwd: join(dir, 'test'), hook_event_name: 'SessionStart', source: 'startup' })

    // Claude Code: its own shell, with $CLAUDE_PROJECT_DIR.
    const claude = spawnSync('sh', ['-c', command('.claude/settings.json')], {
      cwd: join(dir, 'test'),
      input,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    })
    // Codex: `$SHELL -lc` in the session's directory, with no project variable.
    const codex = spawnSync('sh', ['-lc', command('.codex/hooks.json')], { cwd: join(dir, 'test'), input, encoding: 'utf8' })
    for (const res of [claude, codex]) {
      expect(res.status, res.stderr).toBe(0)
      expect(JSON.parse(res.stdout).hookSpecificOutput.additionalContext).toContain('**Claim**')
    }
  })
})

// Each test here keeps the real model out of reach: --review-skeleton, a run
// that stops before the review job, or a stand-in `claude` first on PATH.
describe('npm run ci:local', () => {
  /** A standalone copy with one commit on a branch off main - a pull request's shape. */
  function pullRequest(): string {
    const dir = standaloneCopy()
    sh(dir, 'branch', '-m', 'main')
    sh(dir, 'switch', '-qc', 'change')
    writeFileSync(join(dir, 'index.js'), readFileSync(join(dir, 'index.js'), 'utf8') + '\n')
    sh(dir, 'commit', '-qam', 'a change')
    return dir
  }
  const ciLocal = (dir: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['scripts/ci-local.mjs', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } })
  const summary = (out: string) => out.slice(out.indexOf('=== what CI would report'))

  it('refuses inside evidence-layer\'s checkout, where git would answer for the wrong repository', () => {
    const res = spawnSync(process.execPath, ['scripts/ci-local.mjs', '--review-skeleton'], { cwd: EXAMPLE, encoding: 'utf8' })
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('npm run standalone')
  })

  it('runs the jobs as CI does: a passing change passes them, a failing suite fails evidence and skips the review', () => {
    const dir = pullRequest()
    const clean = ciLocal(dir, ['--review-skeleton'])
    expect(clean.status, clean.stdout + clean.stderr).toBe(0)
    expect(summary(clean.stdout)).toMatch(/evidence {4}required {2}pass\n {2}governance {2}required {2}pass\n {2}review {6}optional {2}pass/)
    expect(clean.stdout).toContain('VERIFIED[tests-')

    writeFileSync(join(dir, 'index.js'), readFileSync(join(dir, 'index.js'), 'utf8').replace('n + 1', 'n + 2'))
    sh(dir, 'commit', '-qam', 'broken')
    const red = ciLocal(dir, ['--review-skeleton'])
    expect(red.status).toBe(1)
    expect(summary(red.stdout)).toContain('evidence    required  fail')
    expect(summary(red.stdout)).toContain('review      optional  skipped - it needs evidence')
    // Two full runs of the workflow's jobs on a fresh copy - a dozen processes. 1.6 s here
    // under the whole suite, and past vitest's 5 s once on a loaded runner: the gate tests'
    // budget, not the default.
  }, 30_000)

  // POSIX only - the stand-in is a shell script.
  it.skipIf(process.platform === 'win32')('asks the model exactly what the workflow asks it, and fails a model step that wrote no review', () => {
    const dir = pullRequest()
    const bin = mkdtempSync(join(tmpdir(), 'el-fake-claude-'))
    const log = join(bin, 'claude.log')
    // Records its arguments, one per NUL, and writes no review - so a review left by an earlier run must not count.
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$CLAUDE_LOG"\n', { mode: 0o755 })
    expect(ciLocal(dir, ['--review-skeleton']).status).toBe(0)
    expect(existsSync(join(dir, 'ai-review.md'))).toBe(true)

    const res = ciLocal(dir, [], { PATH: bin + ':' + process.env.PATH, CLAUDE_LOG: log, REVIEW_MODEL: 'claude-sonnet-5-5' })
    expect(res.status).toBe(1)
    expect(summary(res.stdout)).toContain('review      optional  fail - the model wrote no ai-review.md')
    const asked = readFileSync(log, 'utf8').split('\0').slice(0, -1)
    const workflow = readFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(asked[0]).toBe('-p')
    expect(workflow.replace(/\s+/g, ' ')).toContain(asked[1]!.replace(/\s+/g, ' '))
    expect(asked.slice(2)).toEqual([
      '--model', 'claude-sonnet-5-5', '--max-turns', '8',
      '--allowedTools', 'Read,Glob,Grep,Write', '--disallowedTools', 'Bash,WebFetch,WebSearch',
      '--settings', '{"disableAllHooks": true}',
    ])
  }, 30_000)

  it('refuses a workflow whose review step it cannot read, rather than asking the model something else', () => {
    const dir = pullRequest()
    const path = join(dir, '.github', 'workflows', 'ci.yml')
    writeFileSync(path, readFileSync(path, 'utf8').replace('anthropics/claude-code-action@v1', 'someone/other-action@v1'))
    const res = ciLocal(dir, ['--review-skeleton'])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('no `uses: anthropics/claude-code-action` step')
  })

  it('runs the Azure pipeline\'s jobs with --pipeline azure, and refuses a pipeline it does not know', () => {
    const dir = pullRequest()
    const azure = ciLocal(dir, ['--pipeline', 'azure', '--review-skeleton'])
    expect(azure.status, azure.stdout + azure.stderr).toBe(0)
    expect(azure.stdout).toContain('ci:local - the jobs of azure-pipelines.yml')
    expect(summary(azure.stdout)).toMatch(/evidence {4}required {2}pass\n {2}governance {2}required {2}pass\n {2}review {6}optional {2}pass/)
    expect(ciLocal(dir, ['--pipeline', 'jenkins']).status).toBe(2)
  }, 30_000)

  // POSIX only - the stand-in is a shell script.
  it.skipIf(process.platform === 'win32')('asks the model what the Azure step asks it, REVIEW_MODEL or the step\'s default', () => {
    const dir = pullRequest()
    const bin = mkdtempSync(join(tmpdir(), 'el-fake-claude-'))
    const log = join(bin, 'claude.log')
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$CLAUDE_LOG"\n', { mode: 0o755 })
    const asked = (env: Record<string, string>) => {
      ciLocal(dir, ['--pipeline', 'azure'], { PATH: bin + ':' + process.env.PATH, CLAUDE_LOG: log, ...env })
      return readFileSync(log, 'utf8').split('\0').slice(0, -1)
    }
    const pipeline = readFileSync(join(dir, 'azure-pipelines.yml'), 'utf8')
    const withDefault = asked({ REVIEW_MODEL: '' })
    expect(withDefault[0]).toBe('-p')
    expect(pipeline.replace(/\s+/g, ' ')).toContain(withDefault[1]!.replace(/\s+/g, ' '))
    expect(withDefault.slice(2)).toEqual([
      '--model', 'claude-haiku-5-5', '--max-turns', '8',
      '--allowedTools', 'Read,Glob,Grep,Write', '--disallowedTools', 'Bash,WebFetch,WebSearch',
      '--settings', '{"disableAllHooks": true}',
    ])
    expect(asked({ REVIEW_MODEL: 'claude-sonnet-5-5' }).slice(2, 4)).toEqual(['--model', 'claude-sonnet-5-5'])
  }, 30_000)

  it('refuses an Azure model step it cannot evaluate, rather than asking the model something else', () => {
    const dir = pullRequest()
    const path = join(dir, 'azure-pipelines.yml')
    writeFileSync(path, readFileSync(path, 'utf8').replace('"$PROMPT"', '"$(cat prompt.md)"'))
    const res = ciLocal(dir, ['--pipeline', 'azure', '--review-skeleton'])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('which this does not evaluate')
  })
})

describe('the Azure pipeline', () => {
  it('runs the suite once, inside the gather, and holds the review to the bundle it published', () => {
    // Comments say why; only what the agent reads is held here.
    const pipeline = readFileSync(join(EXAMPLE, 'azure-pipelines.yml'), 'utf8').replace(/^\s*#.*\n/gm, '')
    const job = (name: string) => new RegExp('^  - job: ' + name + '\\n([\\s\\S]*?)(?=^  - job: |(?![\\s\\S]))', 'm').exec(pipeline)?.[1] ?? ''
    expect(pipeline).not.toMatch(/npm (?:run )?test\b/)
    expect(job('evidence')).toMatch(/fetchDepth: 0/)
    expect(job('evidence')).toMatch(/SYSTEM_PULLREQUEST_SOURCECOMMITID/)
    expect(job('evidence')).toMatch(/npm run evidence -- --base/)
    expect(job('evidence')).toMatch(/publish:[\s\S]*artifact: evidence\n\s*condition: always\(\)/)
    expect(job('governance')).not.toContain('dependsOn')
    expect(job('governance')).toMatch(/governance --enforce --no-journal --format azure/)
    expect(job('review')).toMatch(/dependsOn: evidence/)
    expect(job('review')).toMatch(/--disallowedTools Bash/)
    expect(job('review')).toMatch(/claims ai-review\.md --bundle evidence\.local\.md [^\n]*--format azure/)
    // Each job posts the status a branch policy can require, whatever the job's outcome.
    for (const name of ['evidence', 'governance', 'review']) {
      expect(job(name)).toMatch(new RegExp('azure-pr\\.mjs status ' + name + ' "\\$AGENT_JOBSTATUS"\\n[^\\n]*\\n\\s*condition: always\\(\\)'))
    }
  })
})

describe('scripts/azure-pr.mjs', () => {
  const SCRIPT = join(EXAMPLE, 'scripts', 'azure-pr.mjs')

  /** A stand-in for Azure DevOps that records what it was sent and answers the iterations the test gives it. */
  async function azureDevOps(iterations: { id: number; sourceRefCommit: { commitId: string } }[]) {
    const seen: { method: string; url: string; auth: string; body: unknown }[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization ?? '', body: body ? JSON.parse(body) : undefined })
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(req.method === 'GET' ? { value: iterations } : {}))
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo
    return { seen, url: 'http://127.0.0.1:' + port + '/org', close: () => server.close() }
  }

  function run(args: string[], env: Record<string, string>) {
    return new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: EXAMPLE, env: { ...process.env, ...env } })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.on('close', (code) => done({ code, out }))
    })
  }

  const build = (url: string) => ({
    SYSTEM_PULLREQUEST_PULLREQUESTID: '42',
    SYSTEM_PULLREQUEST_SOURCECOMMITID: 'abc123',
    SYSTEM_ACCESSTOKEN: 'token-value',
    SYSTEM_COLLECTIONURI: url,
    SYSTEM_TEAMPROJECTID: 'project id',
    BUILD_REPOSITORY_ID: 'repo',
    BUILD_BUILDID: '7',
  })

  it('posts a job\'s status on the iteration whose head is the commit the run built', async () => {
    const api = await azureDevOps([{ id: 1, sourceRefCommit: { commitId: 'old' } }, { id: 2, sourceRefCommit: { commitId: 'abc123' } }])
    const res = await run(['status', 'evidence', 'SucceededWithIssues'], build(api.url))
    api.close()
    expect(res.code, res.out).toBe(0)
    const post = api.seen.find((r) => r.method === 'POST')!
    expect(post.url).toBe('/org/project%20id/_apis/git/repositories/repo/pullRequests/42/statuses?api-version=7.1')
    expect(post.auth).toBe('Bearer token-value')
    expect(post.body).toMatchObject({ state: 'succeeded', context: { genre: 'evidence-layer', name: 'evidence' }, iterationId: 2 })
    expect(res.out).not.toContain('token-value')
  })

  it('posts the review as a new thread, and refuses an empty one', async () => {
    const api = await azureDevOps([])
    const dir = mkdtempSync(join(tmpdir(), 'el-azure-pr-'))
    writeFileSync(join(dir, 'review.md'), '**Claim**: it works\n')
    writeFileSync(join(dir, 'empty.md'), '\n')
    const posted = await run(['comment', join(dir, 'review.md')], build(api.url))
    const empty = await run(['comment', join(dir, 'empty.md')], build(api.url))
    api.close()
    expect(posted.code, posted.out).toBe(0)
    expect(api.seen).toHaveLength(1)
    expect(api.seen[0]!.url).toBe('/org/project%20id/_apis/git/repositories/repo/pullRequests/42/threads?api-version=7.1')
    expect(api.seen[0]!.body).toMatchObject({ comments: [{ content: '**Claim**: it works\n' }] })
    expect(empty.code).toBe(1)
  })

  it('posts nothing outside a pull request build, and says so', async () => {
    const res = await run(['status', 'evidence', 'Failed'], { SYSTEM_PULLREQUEST_PULLREQUESTID: '' })
    expect(res.code).toBe(0)
    expect(res.out).toContain('not a pull request build')
  })

  it('refuses an unmapped token and a state the agent does not report', async () => {
    const unmapped = await run(['status', 'evidence', 'Failed'], { ...build('http://127.0.0.1:9/'), SYSTEM_ACCESSTOKEN: '$(System.AccessToken)' })
    expect(unmapped.code).toBe(2)
    expect((await run(['status', 'evidence', 'constructor'], build('http://127.0.0.1:9/'))).code).toBe(2)
  })
})
