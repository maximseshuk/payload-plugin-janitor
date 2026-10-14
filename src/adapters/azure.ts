import type { StorageAdapter, StorageObject } from '@/shared/types/storage.js'

import { lookup } from './lookup.js'

type BlobItem = { name: string; properties: { contentLength?: number; lastModified?: Date } }

type ContainerClient = {
  deleteBlob: (name: string) => Promise<unknown>
  listBlobsFlat: (options?: { prefix?: string }) => AsyncIterable<BlobItem>
}

const PAGE_SIZE = 1000

export const azureAdapter = (container: ContainerClient): StorageAdapter => {
  const walk = async function* (prefix: string | undefined): AsyncGenerator<StorageObject[]> {
    let page: StorageObject[] = []

    for await (const blob of container.listBlobsFlat({ prefix })) {
      page.push({ key: blob.name, lastModified: blob.properties.lastModified, size: blob.properties.contentLength })

      if (page.length < PAGE_SIZE) continue

      yield page
      page = []
    }

    if (page.length > 0) yield page
  }

  return {
    delete: async ({ key }) => {
      try {
        await container.deleteBlob(key)
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode !== 404) throw err
      }
    },
    list: ({ keys, prefix }) => (keys ? lookup(keys, walk) : walk(prefix ? `${prefix}/` : undefined)),
  }
}
