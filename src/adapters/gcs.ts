import type { StorageAdapter, StorageObject } from '@/shared/types/storage.js'

import { lookup } from './lookup.js'

type File = {
  delete: () => Promise<unknown>
  metadata: { size?: number | string; updated?: string }
  name: string
}

type Query = { autoPaginate?: boolean; maxResults?: number; pageToken?: string; prefix?: string }

type Bucket = {
  file: (name: string) => File
  getFiles: (options?: Query) => Promise<readonly [File[], unknown?, ...unknown[]]>
}

const PAGE_SIZE = 1000

export const gcsAdapter = (bucket: Bucket): StorageAdapter => {
  const walk = async function* (prefix: string | undefined): AsyncGenerator<StorageObject[]> {
    let query: null | Query = { autoPaginate: false, maxResults: PAGE_SIZE, prefix }

    while (query) {
      const [files, next] = await bucket.getFiles(query)

      yield files.map((file): StorageObject => ({
        key: file.name,
        lastModified: file.metadata.updated ? new Date(file.metadata.updated) : undefined,
        size: file.metadata.size === undefined ? undefined : Number(file.metadata.size),
      }))

      query = (next as null | Query | undefined) ?? null
    }
  }

  return {
    delete: async ({ key }) => {
      try {
        await bucket.file(key).delete()
      } catch (err) {
        if ((err as { code?: number }).code !== 404) throw err
      }
    },
    list: ({ keys, prefix }) => (keys ? lookup(keys, walk) : walk(prefix ? `${prefix}/` : undefined)),
  }
}
