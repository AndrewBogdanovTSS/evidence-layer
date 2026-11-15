import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gatherEvidence, planStepsDefault, stepFailed } from '../src/core/gather'
import { redactSecrets, secretValues } from '../src/core/redact'
import { readCurrentRun } from '../src/core/seal'
import { sh } from './helpers/git'
import { gatherOneStep, gatherableRepo, printAndExit } from './helpers/gather'

describe('planStepsDefault - the zero-config default', () => {
  it('plans lint, typecheck, a lockfile check and test with no options at all', () => {
    const steps = planStepsDefault(['a.ts'], [])
    expect(steps.map((s) => s.name)).toEqual(['lint', 'typecheck', 'lockfile', 'test'])
    expect(steps[0]!.command).toBe('pnpm lint')
    expect(steps[3]!.command).toBe('pnpm test')
  })

  it('plans the lockfile check assuming a lockfile exists, unless told otherwise', () => {
    const steps = planStepsDefault(['a.ts'], [])
    const lockfile = steps.find((s) => s.name === 'lockfile')
    expect(lockfile?.command).toBe('pnpm install --frozen-lockfile --lockfile-only')
    expect(lockfile?.skipReason).toBeUndefined()
  })

  it('skips the lockfile check honestly, with a reason, when the caller says there is none', () => {
    const steps = planStepsDefault(['a.ts'], [], { hasLockfile: false })
    expect(steps.find((s) => s.name === 'lockfile')?.skipReason).toBe('no pnpm-lock.yaml in this repository')
  })

  it('always includes the test step by default - a project must opt into scoping it', () => {
    const steps = planStepsDefault(['README.md'], [])
    expect(steps.find((s) => s.name === 'test')?.skipReason).toBeUndefined()
  })

  it('honours a project-supplied test gate', () => {
    const gate = (files: string[]) => files.some((f) => f.startsWith('src/'))
    const skipped = planStepsDefault(['README.md'], [], { testGate: gate })
    expect(skipped.find((s) => s.name === 'test')?.skipReason).toBeDefined()

    const kept = planStepsDefault(['src/x.ts'], [], { testGate: gate })
    expect(kept.find((s) => s.name === 'test')?.skipReason).toBeUndefined()
  })

  it('honours a project-supplied scoped lint command', () => {
    const steps = planStepsDefault(['a.ts', 'b.ts'], [], { lintCommand: (files) => 'eslint ' + files.join(' ') })
    expect(steps[0]!.command).toBe('eslint a.ts b.ts')
  })

  it('records a --skip as a skip, with a reason - silence is not evidence', () => {
    const steps = planStepsDefault(['a.ts'], ['lint', 'typecheck', 'lockfile', 'test'])
    for (const step of steps) expect(step.skipReason).toBe('skipped by --skip')
  })

  it('runs the default steps through the package manager the project uses', () => {
    expect(planStepsDefault([], [], { packageManager: 'npm' }).map((s) => s.command)).toEqual([
      'npm run lint', 'npm run typecheck', 'pnpm install --frozen-lockfile --lockfile-only', 'npm test',
    ])
    expect(planStepsDefault([], [], { packageManager: 'bun' })[3]!.command).toBe('bun run test')
  })

  it('skips a default step whose script the project does not have, and says so, rather than running it to fail', () => {
    const steps = planStepsDefault([], [], { scripts: ['test'], lintCommand: () => 'eslint .' })
    expect(steps.map((s) => [s.name, s.skipReason])).toEqual([
      ['lint', undefined],
      ['typecheck', 'no `typecheck` script in package.json'],
      ['lockfile', undefined],
      ['test', undefined],
    ])
    expect(planStepsDefault([], [], { scripts: null })[3]!.skipReason).toBe('no package.json in this repository, so no `test` script to run')
  })

  it('a --skip of lockfile wins even when a lockfile genuinely exists', () => {
    const steps = planStepsDefault(['a.ts'], ['lockfile'], { hasLockfile: true })
    expect(steps.find((s) => s.name === 'lockfile')?.skipReason).toBe('skipped by --skip')
  })
})

describe('gatherEvidence - the zero-config plan in a project', () => {
  it('suggests no claim about a step whose script does not exist, and names the package manager its lockfile shows', async () => {
    const dir = gatherableRepo('el-gather-')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e ""' } }))
    writeFileSync(join(dir, 'package-lock.json'), '{}')
    sh(dir, 'add', '-A')
    sh(dir, 'commit', '-qm', 'manifest')
    const out = join(dir, 'evidence.local.md')
    const result = await gatherEvidence({ repo: dir, base: 'HEAD', out, seal: false })
    expect(result.steps.map((s) => [s.name, 'skipReason' in s ? s.skipReason : s.command])).toEqual([
      ['lint', 'no `lint` script in package.json'],
      ['typecheck', 'no `typecheck` script in package.json'],
      ['lockfile', 'no pnpm-lock.yaml in this repository'],
      ['test', 'npm test'],
    ])
    const bundle = readFileSync(out, 'utf8')
    expect(bundle).not.toMatch(/Lint reports|Typecheck reports/)
    expect(bundle).toContain('_Not run: no `lint` script in package.json._')
  }, 30_000)
})

describe('gatherEvidence - what kind of run a step is', () => {
  it('names a test step under a command it does not recognise a test run, and suggests the test claim for it', async () => {
    const dir = gatherableRepo('el-gather-')
    const out = join(dir, 'evidence.local.md')
    const result = await gatherEvidence({
      repo: dir,
      base: 'HEAD',
      out,
      seal: false,
      skip: ['lint', 'typecheck', 'lockfile'],
      // Stands in for `make check` or `npm run check`: nothing in its text says "test".
      plan: { testCommand: () => 'node -e "console.log(1)"' },
      summaries: { test: () => ({ kind: 'tests', counts: { passed: 4, failed: 0, skipped: 0, todo: 0 } }) },
    })
    expect(result.steps[3]).toMatchObject({ name: 'test', id: expect.stringMatching(/^tests-[0-9a-f]{6}$/) })
    expect(readFileSync(out, 'utf8')).toContain('**Claim**: The test suite ran 4 passing tests and reports no failures.')
  }, 30_000)
})

describe('gatherEvidence - how every step ended', () => {
  it('records each planned step in order, a skip with its reason, and a failure that stepFailed reads', async () => {
    const { result } = await gatherOneStep(gatherableRepo('el-gather-'), printAndExit('two problems', 1))
    expect(result.steps.map((s) => s.name)).toEqual(['lint', 'typecheck', 'lockfile', 'test'])
    expect(result.steps[1]).toEqual({ name: 'typecheck', command: 'pnpm typecheck', skipReason: 'skipped by --skip' })
    // `node -e ...` is no command the patterns know, so the step says what it is.
    expect(result.steps[0]).toMatchObject({ name: 'lint', exitCode: 1, id: expect.stringMatching(/^lint-[0-9a-f]{6}$/) })
    expect(result.steps.filter(stepFailed).map((s) => s.name)).toEqual(['lint'])
  })

  it('counts a step stopped at its time limit as failed, and a passing one as not', async () => {
    const dir = gatherableRepo('el-gather-')
    const stopped = (await gatherOneStep(dir, 'node -e "setTimeout(() => {}, 20000)"', 500)).result
    expect(stopped.steps[0]).toMatchObject({ stopped: 'timeout' })
    expect(stepFailed(stopped.steps[0]!)).toBe(true)
    expect((await gatherOneStep(dir)).result.steps.some(stepFailed)).toBe(false)
  }, 30_000)
})

describe('captured output is redacted before anything hashes or publishes it', () => {
  it('masks a value by the name its variable has, whole parts only, and leaves short settings alone', () => {
    const env = {
      GITHUB_TOKEN: 'ghp_0123456789abcdef',
      DB_PASSWORD: 'correct horse battery',
      OPENAI_API_KEY: 'sk-live-0123456789',
      GIT_AUTHOR_NAME: 'Someone Long Enough',
      TOKENIZER_PATH: '/usr/share/tokenizers',
      AWS_ACCESS_KEY_ID: 'AKIA0123456789',
      DEBUG_TOKEN: 'true',
    }
    expect(secretValues(env).map((s) => s.name).sort()).toEqual(['DB_PASSWORD', 'GITHUB_TOKEN', 'OPENAI_API_KEY'])
    expect(redactSecrets('curl -H "Bearer ghp_0123456789abcdef" by Someone Long Enough, DEBUG_TOKEN=true', env)).toBe(
      'curl -H "Bearer [REDACTED:GITHUB_TOKEN]" by Someone Long Enough, DEBUG_TOKEN=true',
    )
  })

  it('leaves no trace of a secret a step printed - not in the bundle, not in the sealed run - and applies the caller\'s redact after', async () => {
    const dir = gatherableRepo('el-gather-')
    const secret = 'el-test-secret-0123456789'
    process.env.EL_GATHER_TEST_TOKEN = secret
    try {
      const out = join(dir, 'evidence.local.md')
      const result = await gatherEvidence({
        repo: dir,
        base: 'HEAD',
        out,
        skip: ['typecheck', 'lockfile', 'test'],
        plan: { lintCommand: () => 'node -e "console.log(process.env.EL_GATHER_TEST_TOKEN, \'customer-acme\')"' },
        redact: (output) => output.replaceAll('customer-acme', '[customer]'),
      })
      const bundle = readFileSync(out, 'utf8')
      expect(bundle).toContain('[REDACTED:EL_GATHER_TEST_TOKEN] [customer]')
      const run = readCurrentRun(dir)
      const kept = 'run' in run ? run.run.bundle + JSON.stringify(run.run.seal) : ''
      expect(result.sealed).toBe(true)
      for (const text of [bundle, kept]) {
        expect(text).not.toContain(secret)
        expect(text).not.toContain('customer-acme')
      }
    } finally {
      delete process.env.EL_GATHER_TEST_TOKEN
    }
  }, 30_000)
})
