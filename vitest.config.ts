import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The suite spawns git, node and npm hundreds of times, and starting a
    // process on Windows costs several times what it does on Linux: tests
    // that finish in two seconds in CI time out at the default five there,
    // which reads as a failure of the code. CI runs Linux, where the default
    // still holds every test to it.
    ...(process.platform === 'win32' && { testTimeout: 60_000 }),
  },
})
