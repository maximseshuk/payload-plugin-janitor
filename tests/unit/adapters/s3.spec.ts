import { describe, expect, it } from 'vitest'

import { s3Adapter } from '@/adapters/s3.js'

import { collect, contract, DeleteObjectCommand, ListObjectsV2Command, s3 } from '../../helpers/storage.js'

describe('s3 adapter', () => {
  contract(s3)

  it('throws on a truncated page without a continuation token', async () => {
    const storage = s3Adapter({
      bucket: 'b',
      client: { send: async () => ({ Contents: [{ Key: 'media/a' }], IsTruncated: true }) },
      commands: { DeleteObjectCommand, ListObjectsV2Command },
    })

    await expect(collect(storage)).rejects.toThrow(/truncated/)
  })

  it('sends the prefix with a trailing slash so a sibling prefix never leaks in', async () => {
    const prefixes: (string | undefined)[] = []
    const storage = s3Adapter({
      bucket: 'b',
      client: {
        send: async (command) => {
          prefixes.push((command as ListObjectsV2Command).input.Prefix)

          return {}
        },
      },
      commands: { DeleteObjectCommand, ListObjectsV2Command },
    })

    await collect(storage)
    await collect(storage, { prefix: '' })
    expect(prefixes).toEqual(['media/', undefined])
  })
})
