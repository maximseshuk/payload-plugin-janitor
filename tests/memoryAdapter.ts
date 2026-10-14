import type { StorageAdapter, StorageDeleteArgs, StorageListArgs, StorageObject } from '@/shared/types/storage.js'

export type MemoryAdapter = StorageAdapter & {
  deletes: StorageDeleteArgs[]
  lists: StorageListArgs[]
  objects: Map<string, StorageObject>
  put: (key: string, object?: Partial<StorageObject>) => void
}

export const memoryAdapter = (
  objects = new Map<string, StorageObject>(),
  extra: Partial<StorageAdapter> = {},
): MemoryAdapter => {
  const deletes: StorageDeleteArgs[] = []
  const lists: StorageListArgs[] = []

  return {
    delete: async (args) => {
      deletes.push(args)
      objects.delete(args.key)
    },
    deletes,
    list: async function* (args) {
      lists.push(args)
      const under = args.prefix ? `${args.prefix}/` : ''
      const wanted = args.keys && new Set(args.keys)

      yield [...objects.values()].filter(
        (object) => object.key.startsWith(under) && (!wanted || wanted.has(object.key)),
      )
    },
    lists,
    objects,
    put: (key, object) => {
      objects.set(key, { key, lastModified: new Date(0), size: 1024, ...object })
    },
    ...extra,
  }
}
