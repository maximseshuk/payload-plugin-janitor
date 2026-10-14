import type { StorageAdapter } from '@/shared/types/storage.js'

type UTApi = {
  deleteFiles: (keys: string[]) => Promise<unknown>
  listFiles: (options?: { limit?: number; offset?: number }) => Promise<{
    readonly files: readonly { key: string; name: string; size: number; uploadedAt?: number }[]
    readonly hasMore: boolean
  }>
}

const PAGE_SIZE = 500

export const uploadthingAdapter = (api: UTApi): StorageAdapter => ({
  delete: async ({ key, ref }) => {
    await api.deleteFiles([ref ?? key])
  },
  list: async function* ({ collection, keys, prefix }) {
    if (prefix) {
      throw new Error(
        `uploadthing stores files flat, without a prefix, but collection "${collection}" resolved to prefix "${prefix}". Set prefix: '' for it in the janitor options.`,
      )
    }

    const wanted = keys && new Set(keys)
    let offset = 0

    for (;;) {
      const page = await api.listFiles({ limit: PAGE_SIZE, offset })

      yield page.files
        .filter((file) => !wanted || wanted.has(file.name))
        .map((file) => ({
          key: file.name,
          lastModified: file.uploadedAt ? new Date(file.uploadedAt) : undefined,
          ref: file.key,
          size: file.size,
        }))

      if (!page.hasMore) return

      if (page.files.length === 0) throw new Error('uploadthing listing reports more files but returned an empty page')

      offset += page.files.length
    }
  },
})
