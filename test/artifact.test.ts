import { describe, expect, it } from 'vitest'
import {
  artifactId,
  artifactKind,
  classifyCommand,
  commandKind,
  fencedLineNumbers,
  findArtifactBlocks,
  findFencedBlocks,
  formatArtifact,
} from '../src/core/artifact'

const F = '`'.repeat(3)

describe('findFencedBlocks', () => {
  it('captures the info string and the body', () => {
    const blocks = findFencedBlocks([F + 'ts', 'const a = 1', F])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.info).toBe('ts')
    expect(blocks[0]!.body).toEqual(['const a = 1'])
    expect(blocks[0]!.closed).toBe(true)
  })

  it('reports an unclosed block rather than swallowing it', () => {
    expect(findFencedBlocks([F + 'artifact', '$ ls'])[0]!.closed).toBe(false)
  })

  it('closes a block only on a bare fence at least as long as the one that opened it', () => {
    const blocks = findFencedBlocks([F + '`artifact', '$ pnpm test', F + 'js', 'x', F, F + '`', 'after'])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.body).toEqual(['$ pnpm test', F + 'js', 'x', F])
    expect(blocks[0]!.end).toBe(5)
  })
})

describe('fencedLineNumbers', () => {
  it('covers the fences themselves as well as the body', () => {
    expect([...fencedLineNumbers(['before', F, 'inside', F, 'after'])]).toEqual([1, 2, 3])
  })
})

describe('classifyCommand', () => {
  it.each([
    ['pnpm test', 'tests'],
    ['vitest run', 'tests'],
    ['pnpm eslint .', 'lint'],
    ['pnpm typecheck', 'types'],
    ['tsc --noEmit', 'types'],
    ['pnpm fingerprint', 'engine'],
    ['git diff --stat a...b', 'diff'],
    ['echo hello', 'cmd'],
  ])('classifies %s as %s', (command, kind) => {
    expect(classifyCommand(command)).toBe(kind)
  })

  // What runs decides the kind, not the arguments it was handed: a lint run over
  // a file named typecheck.ts read as `types`, which also changes which claim
  // rules apply to it.
  it.each([
    ['pnpm eslint scripts/review-evidence/typecheck.ts', 'lint'],
    ['pnpm test scripts/review-evidence/tests/typecheck.test.ts --no-watch', 'tests'],
    ['vitest run src/lint/rules.test.ts', 'tests'],
    ["pnpm test -t 'typecheck flow'", 'tests'],
    ['pnpm eslint src/a.ts "src/git diff.ts"', 'lint'],
    ['git diff --stat 60fa7c7...bb0db95', 'diff'],
    ['pnpm install --frozen-lockfile', 'lockfile'],
    ['tsc -p tsconfig.json', 'types'],
    [
      'BRAND=vans STORYBOOK=true NODE_OPTIONS=--max-old-space-size=8192 node node_modules/tsx/dist/cli.mjs scripts/generate-design-system/index.ts && node node_modules/nuxt/bin/nuxt.mjs typecheck',
      'types',
    ],
    ['TEST_DIR=lint node scripts/run.mjs', 'cmd'],
    // A program named by its path, or run by an interpreter, is what runs.
    ['vendor/bin/phpunit tests/LintTest.php', 'tests'],
    ['node node_modules/eslint/bin/eslint.js src/typecheck.ts', 'lint'],
    ['python -m pytest tests/test_lint.py', 'tests'],
  ])('ignores paths, quoted strings and env assignments: %s -> %s', (command, kind) => {
    expect(classifyCommand(command)).toBe(kind)
  })

  // A test runner's arguments are what it runs, not what kind of run it is: a
  // vitest filter naming the `eslint/` directory without a slash made a test run
  // `lint`, and claims then rejected every success claim on its test summary.
  it.each([
    [
      'pnpm test .agents/skills/skills.test.ts domains/commerce/composables/useProductCardMedia/tests/index.test.ts eslint/rules/no-brand-abbreviation.test.ts eslint/rules/no-composables-in-utils.test.ts eslint/rules/no-relative-cross-boundary-import.test.ts scripts/agent-guard/tests/index.test.ts scripts/governance-check/tests/lib.test.ts --no-watch',
      'tests',
    ],
    ['pnpm test eslint', 'tests'],
    ['pnpm run test eslint rules', 'tests'],
    ['pnpm test -t lint', 'tests'],
    ['pnpm test -t typecheck', 'tests'],
    ['vitest run eslint', 'tests'],
    ['npx vitest lint', 'tests'],
    ['pnpm vitest run --project eslint', 'tests'],
    ['npm test -- eslint', 'tests'],
    ['node node_modules/vitest/vitest.mjs run lint', 'tests'],
    ['python -m pytest -k lint', 'tests'],
    // Only the runner's own arguments: another program on the line still counts.
    ['pnpm lint && pnpm test eslint', 'lint'],
    ['pnpm eslint test', 'lint'],
    ['pnpm lint', 'lint'],
    ['pnpm run lint', 'lint'],
  ])("reads a test runner's arguments as arguments: %s -> %s", (command, kind) => {
    expect(classifyCommand(command)).toBe(kind)
  })
})

describe('artifactId', () => {
  it('is deterministic: same command, commit and output -> same id', () => {
    const a = artifactId('pnpm test', 'abc123', 'Tests 71 passed (71)')
    const b = artifactId('pnpm test', 'abc123', 'Tests 71 passed (71)')
    expect(a).toBe(b)
  })

  it('changes when the commit changes, even with identical output - the whole point of addressing', () => {
    const a = artifactId('pnpm test', 'abc123', 'Tests 71 passed (71)')
    const b = artifactId('pnpm test', 'def456', 'Tests 71 passed (71)')
    expect(a).not.toBe(b)
  })

  it('is prefixed with the classified kind', () => {
    expect(artifactId('pnpm test', 'abc123', 'ok')).toMatch(/^tests-[0-9a-f]{6}$/)
  })
})

describe('the kind of a run', () => {
  it('is the step\'s only when the command says nothing - a recognised command keeps its own', () => {
    expect(commandKind('npm run check', 'tests')).toBe('tests')
    expect(commandKind('make check')).toBe('cmd')
    // A lint step that runs the typechecker is one typecheck run, not a lint run of `tsc`.
    expect(commandKind('pnpm typecheck', 'lint')).toBe('types')
    expect(artifactId('npm run check', 'abc123', 'ok', 'tests')).toMatch(/^tests-[0-9a-f]{6}$/)
    // The hash half does not move: only the kind was ever wrong.
    expect(artifactId('npm run check', 'abc123', 'ok', 'tests').slice(-6)).toBe(artifactId('npm run check', 'abc123', 'ok').slice(-6))
  })

  it('is read from the id, and from the command for a block with none or one gathered as cmd', () => {
    expect(artifactKind({ command: 'npm run check', id: 'tests-a3f91c' })).toBe('tests')
    expect(artifactKind({ command: 'npm run check' })).toBe('cmd')
    expect(artifactKind({ command: 'pnpm test', id: 'cmd-a3f91c' })).toBe('tests')
  })
})

describe('findArtifactBlocks', () => {
  const valid = [F + 'artifact', '$ pnpm test', 'Tests 71 passed', 'exit: 0', F]

  it('accepts a legacy block with no id', () => {
    const [block] = findArtifactBlocks(valid)
    expect(block?.command).toBe('pnpm test')
    expect(block?.exitCode).toBe(0)
    expect(block?.id).toBeUndefined()
  })

  it('parses an addressed block with an id and a commit', () => {
    const lines = [F + 'artifact:tests-a3f91c@f8ae76a', '$ pnpm test', 'ok', 'exit: 0', F]
    const [block] = findArtifactBlocks(lines)
    expect(block?.id).toBe('tests-a3f91c')
    expect(block?.commit).toBe('f8ae76a')
  })

  it('parses an addressed block with an id but no commit', () => {
    const lines = [F + 'artifact:tests-a3f91c', '$ pnpm test', 'ok', 'exit: 0', F]
    expect(findArtifactBlocks(lines)[0]?.id).toBe('tests-a3f91c')
  })

  it('records a non-zero exit rather than rejecting it - a failure is evidence', () => {
    expect(findArtifactBlocks([F + 'artifact', '$ pnpm test', 'boom', 'exit: 124', F])[0]!.exitCode).toBe(124)
  })

  it.each([
    ['the wrong info string', [F + 'sh', '$ pnpm test', 'exit: 0', F]],
    ['a malformed id', [F + 'artifact:not-an-id', '$ pnpm test', 'exit: 0', F]],
    ['no command line', [F + 'artifact', 'pnpm test', 'exit: 0', F]],
    ['no exit line', [F + 'artifact', '$ pnpm test', 'Tests 71 passed', F]],
    ['an unclosed fence', [F + 'artifact', '$ pnpm test', 'exit: 0']],
  ])('rejects a block with %s', (_label, lines) => {
    expect(findArtifactBlocks(lines)).toHaveLength(0)
  })
})

describe('formatArtifact', () => {
  it('keeps output that prints a fence inside its own block', () => {
    const output = 'running docs test\n' + F + 'js\nconsole.log(1)\n' + F + '\n1 passed'
    const id = artifactId('pnpm test', 'a'.repeat(40), output)
    const blocks = findArtifactBlocks(formatArtifact('pnpm test', output, 0, { id, commit: 'a'.repeat(40) }).split('\n'))
    expect(blocks.map((b) => [b.id, b.output])).toEqual([[id, output]])
  })

  it('does not let output plant an artifact block of its own', () => {
    const printed = 'ok\n' + F + 'artifact:tests-ffffff@aaaaaaa\n$ pnpm test\n[SUMMARY tests: passed=999 failed=0 skipped=0 todo=0]\nexit: 0\n' + F + '\ntail'
    const blocks = findArtifactBlocks(formatArtifact('node script.js', printed, 0, { id: 'cmd-000000', commit: 'a'.repeat(40) }).split('\n'))
    expect(blocks.map((b) => b.id)).toEqual(['cmd-000000'])
  })

  it('round-trips through the parser with no id, so the legacy grammar still works', () => {
    const rendered = formatArtifact('pnpm fingerprint', 'all three match', 0).split('\n')
    const [parsed] = findArtifactBlocks(rendered)
    expect(parsed?.command).toBe('pnpm fingerprint')
    expect(parsed?.id).toBeUndefined()
  })

  it('round-trips an id and commit through the parser', () => {
    const rendered = formatArtifact('pnpm test', 'ok', 0, { id: 'tests-a3f91c', commit: 'f8ae76a1234' }).split('\n')
    const [parsed] = findArtifactBlocks(rendered)
    expect(parsed?.id).toBe('tests-a3f91c')
    expect(parsed?.commit).toBe('f8ae76a')
  })

  it('truncates from the middle, keeping the lines that say whether it passed', () => {
    const output = Array.from({ length: 100 }, (_, i) => 'line ' + i).join('\n')
    const rendered = formatArtifact('cmd', output, 0, { maxLines: 10 })
    expect(rendered).toContain('line 0')
    expect(rendered).toContain('line 99')
    expect(rendered).toContain('lines omitted')
  })
})
