/**
 * `claims --bundle`: a review held to a bundle file, where no seal is - the
 * CI job that did not gather, the reviewer reading the uploaded bundle.
 * Blocks must be the bundle's own, unedited, and a bundle that is not there
 * is bad usage.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { artifactId, formatArtifact } from '../src/core/artifact'
import { checkBundle, readBundle } from '../src/core/bundle'
import type { Bundle } from '../src/core/bundle'
import type { StepOutcome } from '../src/core/gather'
import { gatherOneStep, gatherableRepo } from './helpers/gather'
import { sh } from './helpers/git'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BIN = join(root, 'dist', 'bin', 'evidence-layer.mjs')

/** The block the bundle carries under `id`, as the gatherer wrote it. */
function blockOf(text: string, id: string): { id: string; block: string } {
  return { id, block: new RegExp('```artifact:' + id + '@[0-9a-f]+\\n[\\s\\S]*?```').exec(text)![0] }
}

/** The lint step's block - under Suggested claims, since it backs one. */
const lintBlock = (gathered: { result: { steps: StepOutcome[] }; text: string }) =>
  blockOf(gathered.text, (gathered.result.steps[0] as { id: string }).id)

// The skeleton's own wording for a `node -e` step, which is no kind of run `classifyCommand` names.
const review = (id: string, block: string, claim = 'This command exits 0.') =>
  '**Claim**: ' + claim + '\n**Grounding**: VERIFIED[' + id + ': exit=0]\n\n' + block + '\n'

const bundleOf = (path: string): Bundle => {
  const read = readBundle(path)
  if (!('bundle' in read)) throw new Error(read.broken)
  return read.bundle
}

const claims = (cwd: string, ...args: string[]) => {
  const res = spawnSync(process.execPath, [BIN, 'claims', ...args, '--format', 'json'], { cwd, encoding: 'utf8' })
  return {
    status: res.status,
    stderr: res.stderr,
    findings: res.stdout ? (JSON.parse(res.stdout) as { findings: { level: string; code: string; detail: string; fix?: string }[] }).findings : [],
  }
}

describe('checkBundle', () => {
  it('passes a block copied from the bundle, and reads the head the bundle was gathered at', async () => {
    const dir = gatherableRepo('el-bundle-')
    const gathered = await gatherOneStep(dir)
    const bundle = bundleOf(gathered.out)
    expect(bundle.headSha).toBe(gathered.result.headSha)
    const { id, block } = lintBlock(gathered)
    expect(checkBundle(review(id, block), 'review.md', bundle)).toEqual([expect.objectContaining({ level: 'pass', code: 'bundle/provenance' })])
  })

  it('fails an edited block, and a block under an id the bundle does not carry - naming the id it does', async () => {
    const dir = gatherableRepo('el-bundle-')
    const gathered = await gatherOneStep(dir)
    const bundle = bundleOf(gathered.out)
    const { id, block } = lintBlock(gathered)
    const edited = checkBundle(review(id, block.replace('lint ok', 'lint ok, 40 files')), 'review.md', bundle)
    expect(edited[0]).toMatchObject({ level: 'error', code: 'bundle/edited' })

    // Typed by hand: a well-formed block under an id of its own making.
    const command = block.split('\n')[1]!.slice(2)
    const forged = artifactId(command, 'f8ae76a', 'lint ok, 40 files')
    const found = checkBundle(review(forged, formatArtifact(command, 'lint ok, 40 files', 0, { id: forged, commit: 'f8ae76a' })), 'review.md', bundle)
    expect(found[0]).toMatchObject({ level: 'error', code: 'bundle/not-gathered' })
    expect(found[0]!.fix).toContain('cite ' + id + ' instead')
  })

  it('reads a file with no addressed blocks, or two blocks under one id, as no bundle at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'el-bundle-file-'))
    writeFileSync(join(dir, 'notes.md'), '# notes\n')
    expect(readBundle(join(dir, 'notes.md'))).toEqual({ broken: expect.stringContaining('not an evidence bundle') })
    const id = 'lint-abcdef'
    const two = formatArtifact('pnpm lint', 'one', 0, { id, commit: 'f8ae76a' }) + '\n\n' + formatArtifact('pnpm lint', 'two', 0, { id, commit: 'f8ae76a' })
    writeFileSync(join(dir, 'two.md'), two)
    expect(readBundle(join(dir, 'two.md'))).toEqual({ broken: expect.stringContaining('share the id ' + id) })
  })
})

describe('evidence-layer claims --bundle', () => {
  it('holds a review written outside the gathering checkout to the bundle, and is bad usage when the bundle is absent', async () => {
    const dir = gatherableRepo('el-bundle-')
    const gathered = await gatherOneStep(dir)
    const { out } = gathered
    const { id, block } = lintBlock(gathered)
    // Another job: no repository, no seal - only the review and the bundle it downloaded.
    const elsewhere = mkdtempSync(join(tmpdir(), 'el-bundle-review-'))
    writeFileSync(join(elsewhere, 'evidence.local.md'), readFileSync(out))
    writeFileSync(join(elsewhere, 'review.md'), review(id, block))
    const clean = claims(elsewhere, 'review.md', '--bundle', 'evidence.local.md')
    expect(clean.status).toBe(0)
    expect(clean.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['claims/verified', 'bundle/provenance']))

    writeFileSync(join(elsewhere, 'review.md'), review(id, block.replace('lint ok', 'lint ok, 40 files')))
    expect(claims(elsewhere, 'review.md', '--bundle', 'evidence.local.md').findings.map((f) => f.code)).toContain('bundle/edited')

    const missing = claims(elsewhere, 'review.md', '--bundle', 'gone.md')
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain('no such bundle file')
  })

  it('takes the commit under review from the bundle when neither --sha nor a receipt names one', async () => {
    const dir = gatherableRepo('el-bundle-')
    const { id, block } = lintBlock(await gatherOneStep(dir))
    writeFileSync(join(dir, 'review.md'), review(id, block))
    // A bundle from a later commit: the block is not in it, and is about another commit.
    writeFileSync(join(dir, 'src', 'a.js'), 'b\n')
    sh(dir, 'commit', '-qam', 'next')
    const later = await gatherOneStep(dir)
    const found = claims(dir, 'review.md', '--bundle', later.out).findings.map((f) => f.code)
    expect(found).toEqual(expect.arrayContaining(['claims/wrong-commit', 'bundle/not-gathered']))
  })
})
