import type { UsageHit } from '@/shared/types/index.js'

export const hit = (overrides: Partial<UsageHit>): UsageHit => ({
  collection: 'posts',
  count: 1,
  fields: ['Cover'],
  global: false,
  id: 1,
  status: 'published',
  ...overrides,
})
