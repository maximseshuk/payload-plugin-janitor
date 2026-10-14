import { readdir, rm, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import type { StorageAdapter, StorageObject } from '@/shared/types/storage.js'

type LocalAdapterArgs = {
  /**
   * The upload collection's `staticDir`, or a function returning it for a collection slug. Pass the same
   * value the collection uses: a relative path resolves against `process.cwd()`, exactly as Payload
   * resolves it, so an absolute path (`path.resolve(dirname, 'media')`) is the safe choice. Payload writes
   * files flat into this directory; subdirectories are never listed.
   */
  staticDir: ((collection: string) => string) | string
}

const inside = (root: string, key: string): string => {
  const path = resolve(root, key)

  if (path !== root && !path.startsWith(root + sep)) {
    throw new Error(`Key "${key}" escapes the storage root "${root}"`)
  }

  return path
}

const objectOf = async (key: string, path: string): Promise<StorageObject | undefined> => {
  try {
    const info = await stat(path)

    return info.isFile() ? { key, lastModified: info.mtime, size: info.size } : undefined
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined

    throw err
  }
}

export const localAdapter = ({ staticDir }: LocalAdapterArgs): StorageAdapter => {
  const rootOf = (collection: string): string =>
    resolve(typeof staticDir === 'function' ? staticDir(collection) : staticDir)

  return {
    delete: async ({ collection, key }) => {
      await rm(inside(rootOf(collection), key), { force: true })
    },
    list: async function* ({ collection, keys, prefix }) {
      const root = rootOf(collection)
      const objects: StorageObject[] = []

      if (keys) {
        for (const key of new Set(keys)) {
          const object = await objectOf(key, inside(root, key))

          if (object) objects.push(object)
        }
      } else {
        const under = prefix ? `${prefix}/` : ''
        const dir = inside(root, prefix)

        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue

          const object = await objectOf(`${under}${entry.name}`, resolve(dir, entry.name))

          if (object) objects.push(object)
        }
      }

      yield objects
    },
    perCollection: typeof staticDir === 'function',
  }
}
