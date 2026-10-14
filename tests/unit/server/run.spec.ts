import type { Payload } from 'payload'
import { describe, expect, it } from 'vitest'

import { ensureRunLock } from '@/server/run.js'
import type { ResolvedOptions } from '@/shared/types/resolved.js'

describe('ensureRunLock', () => {
  it('names the index and keeps the cause when MongoDB cannot build it', async () => {
    const cause = new Error('duplicate key error')
    const payload = {
      db: {
        collections: { 'janitor-runs': { ensureIndexes: () => Promise.reject(cause) } },
        connection: { db: {} },
      },
    } as unknown as Payload

    const error = await ensureRunLock(payload, { runsSlug: 'janitor-runs' } as ResolvedOptions).catch(
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      cause,
      message:
        'janitor: cannot create the unique index on "janitor-runs.lock" that the run lock needs: duplicate key error',
    })
  })
})
