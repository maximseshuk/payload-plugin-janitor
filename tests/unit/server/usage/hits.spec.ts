import { describe, expect, it } from 'vitest'

import { group } from '@/server/usage/hits.js'

describe('group', () => {
  it('keeps the autosave flag of a version', () => {
    const [hit] = group(
      [{ autosave: true, documentId: 1, entity: 'deep', field: 'banner', latest: true, status: 'draft', versionId: 9 }],
      new Set(),
    )

    expect(hit).toMatchObject({ autosave: true, status: 'draft', versionId: 9 })
  })
})
