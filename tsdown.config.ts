import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

/**
 * The version the CLI prints is substituted from `package.json` at build time
 * rather than written down a second time. A `--version` that could disagree
 * with the package it came from is exactly the kind of unbacked claim this
 * package exists to catch; `test/bin.test.ts` checks the built bundle agrees.
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

export default defineConfig({
  // Named entries, so the published paths are the ones `package.json` promises
  // in `exports` - not whatever a common-root calculation happens to produce.
  entry: {
    index: 'src/index.ts',
    'adapters/node-default': 'src/adapters/node-default.ts',
    'bin/evidence-layer': 'bin/evidence-layer.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  dts: true,
  clean: true,
  hash: false,
  // `.mjs` even though `type: module` already makes `.js` ESM: a consumer
  // reading a stack trace should not have to check this package's `type` field
  // to know what they are looking at.
  outExtensions: () => ({ js: '.mjs', dts: '.d.mts' }),
  define: { __EVIDENCE_LAYER_VERSION__: JSON.stringify(pkg.version) },
  // The package's own shape is a claim too: publint checks the manifest against
  // what is actually in the tarball, attw checks the types resolve for the
  // consumers `exports` says are supported.
  publint: true,
  attw: true,
})
