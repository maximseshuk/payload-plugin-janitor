import { describe, expect, it } from 'vitest'

import { r2Adapter } from '@/adapters/r2.js'

import { collect, contract, r2 } from '../../helpers/storage.js'

describe('r2 adapter', () => {
  contract(r2)

  it('throws on a truncated page without a cursor', async () => {
    const storage = r2Adapter({
      delete: async () => {},
      list: async () => ({ objects: [], truncated: true }),
    })

    await expect(collect(storage)).rejects.toThrow(/truncated/)
  })
})
