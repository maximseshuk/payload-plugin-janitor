import type { StorageAdapter, StorageObject } from '@/shared/types/storage.js'

import { lookup } from './lookup.js'

type VercelBlobApi = {
  del: (url: string | string[], options?: { token?: string }) => Promise<void>
  list: (options: { cursor?: string; limit?: number; prefix?: string; token?: string }) => Promise<{
    blobs: { pathname: string; size: number; uploadedAt: Date; url: string }[]
    cursor?: string
    hasMore: boolean
  }>
}

export const vercelBlobAdapter = (api: VercelBlobApi, options?: { token?: string }): StorageAdapter => {
  const walk = async function* (prefix: string | undefined): AsyncGenerator<StorageObject[]> {
    let cursor: string | undefined

    do {
      const page = await api.list({ cursor, limit: 1000, prefix, token: options?.token })

      yield page.blobs.map((blob) => ({
        key: blob.pathname,
        lastModified: blob.uploadedAt,
        ref: blob.url,
        size: blob.size,
      }))

      if (page.hasMore && !page.cursor) {
        throw new Error(`Vercel Blob listing of "${prefix ?? ''}" has more results but returned no cursor`)
      }

      cursor = page.hasMore ? page.cursor : undefined
    } while (cursor)
  }

  return {
    delete: async ({ key, ref }) => {
      await api.del(ref ?? key, { token: options?.token })
    },
    list: ({ keys, prefix }) => (keys ? lookup(keys, walk) : walk(prefix ? `${prefix}/` : undefined)),
  }
}
