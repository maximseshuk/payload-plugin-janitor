import type { StorageAdapter, StorageObject } from '@/shared/types/storage.js'

import { lookup } from './lookup.js'

type ListCommandOutput = {
  Contents?: { Key?: string; LastModified?: Date; Size?: number }[]
  IsTruncated?: boolean
  NextContinuationToken?: string
}

type S3ClientLike = {
  send(command: unknown): Promise<unknown>
}

type S3Commands = {
  DeleteObjectCommand: new (input: { Bucket: string; Key: string }) => unknown
  ListObjectsV2Command: new (input: { Bucket: string; ContinuationToken?: string; Prefix?: string }) => unknown
}

type S3AdapterArgs = {
  bucket: string
  config?: Record<string, unknown>
} & Partial<{ client: S3ClientLike; commands: S3Commands }>

const isNotFound = (err: unknown): boolean => {
  const error = err as { $metadata?: { httpStatusCode?: number }; name?: string }

  return error.name === 'NoSuchKey' || error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404
}

export const s3Adapter = (args: S3AdapterArgs): StorageAdapter => {
  let cached: Promise<{ client: S3ClientLike; commands: S3Commands }> | undefined

  const load = async (): Promise<{ client: S3ClientLike; commands: S3Commands }> => {
    if (args.client && args.commands) return { client: args.client, commands: args.commands }

    cached ??= (async () => {
      const sdk = (await import('@aws-sdk/client-s3' as string)) as {
        DeleteObjectCommand: S3Commands['DeleteObjectCommand']
        ListObjectsV2Command: S3Commands['ListObjectsV2Command']
        S3Client: new (config?: Record<string, unknown>) => S3ClientLike
      }

      return {
        client: args.client ?? new sdk.S3Client(args.config ?? {}),
        commands: { DeleteObjectCommand: sdk.DeleteObjectCommand, ListObjectsV2Command: sdk.ListObjectsV2Command },
      }
    })()

    return cached
  }

  const walk = async function* (prefix: string | undefined): AsyncGenerator<StorageObject[]> {
    const { client, commands } = await load()
    let token: string | undefined

    do {
      const page = (await client.send(
        new commands.ListObjectsV2Command({ Bucket: args.bucket, ContinuationToken: token, Prefix: prefix }),
      )) as ListCommandOutput

      const objects: StorageObject[] = []

      for (const object of page.Contents ?? []) {
        if (object.Key) objects.push({ key: object.Key, lastModified: object.LastModified, size: object.Size })
      }

      yield objects

      if (page.IsTruncated && !page.NextContinuationToken) {
        throw new Error(`S3 listing of "${prefix ?? ''}" is truncated but returned no continuation token`)
      }

      token = page.NextContinuationToken
    } while (token)
  }

  return {
    delete: async ({ key }) => {
      const { client, commands } = await load()

      try {
        await client.send(new commands.DeleteObjectCommand({ Bucket: args.bucket, Key: key }))
      } catch (err) {
        if (!isNotFound(err)) throw err
      }
    },
    list: ({ keys, prefix }) => (keys ? lookup(keys, walk) : walk(prefix ? `${prefix}/` : undefined)),
  }
}
