import type { StorageAdapter, StorageObject } from '@/shared/types/storage.js'

type BunnyEntry = {
  IsDirectory: boolean
  LastChanged?: string
  Length: number
  ObjectName: string
  Path: string
}

const encode = (path: string): string => path.split('/').map(encodeURIComponent).join('/')

const dirOf = (key: string): string => key.slice(0, key.lastIndexOf('/') + 1)

export const bunnyAdapter = ({
  apiKey,
  region,
  zoneName,
}: {
  apiKey: string
  region?: string
  zoneName: string
}): StorageAdapter => {
  const host = region && region !== 'de' ? `https://${region}.storage.bunnycdn.com` : 'https://storage.bunnycdn.com'
  const headers = { AccessKey: apiKey }
  const url = (path: string): string => `${host}/${encodeURIComponent(zoneName)}/${encode(path)}`

  const read = async (path: string): Promise<BunnyEntry[]> => {
    const response = await fetch(url(path), { headers: { ...headers, Accept: 'application/json' } })

    if (!response.ok) throw new Error(`Bunny storage listing of "${path}" failed: ${response.status}`)

    return (await response.json()) as BunnyEntry[]
  }

  const objectOf = (key: string, entry: BunnyEntry): StorageObject => ({
    key,
    lastModified: entry.LastChanged ? new Date(entry.LastChanged) : undefined,
    size: entry.Length,
  })

  return {
    external: 'bunnyData.stream.videoId',
    delete: async ({ key }) => {
      const response = await fetch(url(key), { headers, method: 'DELETE' })

      if (!response.ok && response.status !== 404) {
        throw new Error(`Bunny storage delete of "${key}" failed: ${response.status}`)
      }
    },
    list: async function* ({ keys, prefix }) {
      if (keys) {
        const wanted = new Set(keys)

        for (const dir of new Set(keys.map(dirOf))) {
          yield (await read(dir)).flatMap((entry) => {
            const key = `${dir}${entry.ObjectName}`

            return !entry.IsDirectory && wanted.has(key) ? [objectOf(key, entry)] : []
          })
        }

        return
      }

      const pending = [prefix ? `${prefix}/` : '']

      while (pending.length > 0) {
        const path = pending.pop()!
        const page: StorageObject[] = []

        for (const entry of await read(path)) {
          const key = `${path}${entry.ObjectName}`

          if (entry.IsDirectory) pending.push(`${key}/`)
          else page.push(objectOf(key, entry))
        }

        yield page
      }
    },
  }
}
