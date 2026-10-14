import { describe, expect, it } from 'vitest'

import { vercelBlobAdapter } from '@/adapters/vercelBlob.js'

import { collect, contract, KEYS, vercel, when } from '../../helpers/storage.js'

describe('vercelBlob adapter', () => {
  contract(vercel)

  it('keeps the pathname as key and the url as ref, and deletes by ref', async () => {
    const store = new Set(KEYS)
    const deleted: string[] = []
    const storage = vercelBlobAdapter(
      {
        del: async (url, options) => {
          deleted.push(`${url as string} ${options?.token}`)
        },
        list: async () => ({
          blobs: [{ pathname: 'media/a b-x1y2.png', size: 1, uploadedAt: when, url: 'https://s/media/a%20b-x1y2.png' }],
          hasMore: false,
        }),
      },
      { token: 'secret' },
    )

    expect(await collect(storage)).toEqual([
      { key: 'media/a b-x1y2.png', lastModified: when, ref: 'https://s/media/a%20b-x1y2.png', size: 1 },
    ])
    await storage.delete({ collection: 'media', key: 'media/a b-x1y2.png', prefix: 'media', ref: 'https://s/x' })
    expect(deleted).toEqual(['https://s/x secret'])
    expect(store.size).toBe(KEYS.length)
  })

  it('throws when more results are promised without a cursor', async () => {
    const storage = vercelBlobAdapter({ del: async () => {}, list: async () => ({ blobs: [], hasMore: true }) })

    await expect(collect(storage)).rejects.toThrow(/no cursor/)
  })
})
