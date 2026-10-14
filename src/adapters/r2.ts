import type { StorageAdapter, StorageObject } from '@/shared/types/storage.js'

import { lookup } from './lookup.js'

type R2Bucket = {
  delete: (keys: string | string[]) => Promise<void>
  list: (options?: {
    cursor?: string
    limit?: number
    prefix?: string
  }) => Promise<{ cursor?: string; objects: { key: string; size: number; uploaded: Date }[]; truncated: boolean }>
}

const PAGE_SIZE = 1000

export const r2Adapter = (bucket: R2Bucket): StorageAdapter => {
  const walk = async function* (prefix: string | undefined): AsyncGenerator<StorageObject[]> {
    let cursor: string | undefined

    do {
      const page = await bucket.list({ cursor, limit: PAGE_SIZE, prefix })

      yield page.objects.map((object) => ({ key: object.key, lastModified: object.uploaded, size: object.size }))

      if (page.truncated && !page.cursor) {
        throw new Error(`R2 listing of "${prefix ?? ''}" is truncated but returned no cursor`)
      }

      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
  }

  return {
    delete: async ({ key }) => {
      await bucket.delete(key)
    },
    list: ({ keys, prefix }) => (keys ? lookup(keys, walk) : walk(prefix ? `${prefix}/` : undefined)),
  }
}
