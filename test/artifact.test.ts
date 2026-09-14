import { describe, expect, it } from 'vitest'
import {
  artifactId,
  classifyCommand,
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
