import { describe, expect, it } from 'vitest'

import { uploadthingAdapter } from '@/adapters/uploadthing.js'

import { collect, failing, keysOf } from '../../helpers/storage.js'

describe('uploadthing adapter', () => {
  const files = Array.from({ length: 1203 }, (_, index) => ({
    key: `k${index}`,
    name: `${index} #?.png`,
    size: index,
    uploadedAt: 1000 + index,
  }))

  const api = (fail = () => {}) => {
    const deleted: string[][] = []

    return {
      deleted,
      deleteFiles: async (keys: string[]) => {
        deleted.push(keys)

        return { deletedCount: 0, success: true }
      },
      listFiles: async ({ limit = 500, offset = 0 } = {}) => {
        fail()

        return { files: files.slice(offset, offset + limit), hasMore: offset + limit < files.length }
      },
    }
  }

  it('throws on a non-empty prefix instead of listing nothing', async () => {
    await expect(collect(uploadthingAdapter(api()), { prefix: 'uploads/media' })).rejects.toThrow(/stores files flat/)
  })

  it('walks every page and keys each file by the name Payload stores, with the file key as ref', async () => {
    const seen = await collect(uploadthingAdapter(api()), { prefix: '' })

    expect(seen).toHaveLength(files.length)
    expect(seen[7]).toEqual({ key: '7 #?.png', lastModified: new Date(1007), ref: 'k7', size: 7 })
  })

  it('throws when the listing fails midway', async () => {
    await expect(collect(uploadthingAdapter(api(failing(new Error('down')))), { prefix: '' })).rejects.toThrow('down')
  })

  it('throws when more files are promised on an empty page', async () => {
    const storage = uploadthingAdapter({
      deleteFiles: async () => ({}),
      listFiles: async () => ({ files: [], hasMore: true }),
    })

    await expect(collect(storage, { prefix: '' })).rejects.toThrow(/empty page/)
  })

  it('returns only the requested names', async () => {
    const seen = await collect(uploadthingAdapter(api()), { keys: ['3 #?.png', '1100 #?.png', 'gone.png'], prefix: '' })

    expect(keysOf(seen)).toEqual(['1100 #?.png', '3 #?.png'])
  })

  it('deletes by ref, falling back to the key', async () => {
    const client = api()
    const storage = uploadthingAdapter(client)

    await storage.delete({ collection: 'media', key: 'a.png', prefix: '', ref: 'k1' })
    await storage.delete({ collection: 'media', key: 'k2', prefix: '' })
    expect(client.deleted).toEqual([['k1'], ['k2']])
  })
})
