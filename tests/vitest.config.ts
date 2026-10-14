import { fileURLToPath } from 'node:url'

import { vitestBase } from '@seshuk/payload-plugin-tooling/vitest'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  ...vitestBase,
  test: {
    environment: 'node',
    globals: true,
    hookTimeout: 120_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.spec.ts'] } },
      {
        extends: true,
        test: { globalSetup: ['tests/globalSetup.ts'], include: ['tests/integration/**/*.int.spec.ts'], name: 'int' },
      },
    ],
    root: fileURLToPath(new URL('..', import.meta.url)),
    testTimeout: 120_000,
  },
})
