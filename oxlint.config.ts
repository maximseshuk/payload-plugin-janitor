import { oxlintBase } from '@seshuk/payload-plugin-tooling/oxlint'
import { defineConfig } from 'oxlint'

export default defineConfig({
  ...oxlintBase,
  ignorePatterns: [...oxlintBase.ignorePatterns, '**/.next/**', '**/next-env.d.ts'],
  rules: {
    ...oxlintBase.rules,
    'import/no-default-export': 'off',
    'react/set-state-in-effect': 'off',
    'unicorn/consistent-function-scoping': 'off',
  },
  overrides: [
    ...oxlintBase.overrides,
    {
      files: ['src/shared/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '@/server',
                  '@/server/**',
                  '@/client',
                  '@/client/**',
                  '@/rsc',
                  '@/rsc/**',
                  '@/adapters',
                  '@/adapters/**',
                  'node:*',
                  'fs',
                  'fs/promises',
                  'path',
                  'crypto',
                  'os',
                  'child_process',
                ],
                message: 'shared is an isomorphic leaf: import only @/shared and npm, no node builtins.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/client/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '@/server',
                  '@/server/**',
                  '@/rsc',
                  '@/rsc/**',
                  '@/adapters',
                  '@/adapters/**',
                  'node:*',
                  'fs',
                  'fs/promises',
                  'path',
                  'crypto',
                  'os',
                  'child_process',
                ],
                message: 'client bundle: import only @/client, @/shared and npm, no server code or node builtins.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/adapters/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@/server', '@/server/**', '@/client', '@/client/**', '@/rsc', '@/rsc/**'],
                message: 'adapters import only @/shared and npm.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/server/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@/client', '@/client/**', '@/rsc', '@/rsc/**'],
                message: 'server code must not import client or rsc components.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['tests/**'],
      plugins: ['vitest'],
      rules: {
        'no-await-in-loop': 'off',
        'vitest/no-conditional-tests': 'off',
        'vitest/require-to-throw-message': 'off',
      },
    },
  ],
})
