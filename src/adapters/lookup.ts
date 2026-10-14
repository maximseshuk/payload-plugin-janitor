import type { StorageObject } from '@/shared/types/storage.js'

export const lookup = async function* (
  keys: string[],
  walk: (prefix: string) => AsyncIterable<StorageObject[]>,
): AsyncGenerator<StorageObject[]> {
  for (const key of new Set(keys)) {
    for await (const page of walk(key)) {
      const hit = page.find((object) => object.key === key)

      if (!hit) continue

      yield [hit]
      break
    }
  }
}
