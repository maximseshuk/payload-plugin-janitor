import type { PayloadRequest } from 'payload'

import { janitorOptions } from '@/server/run.js'

export type LastScan = {
  finishedAt?: string
  id: number | string
  missing: number
  orphans: number
  reclaimable: number
  unused: number
}

const countOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export const lastScan = async (req: PayloadRequest): Promise<LastScan | null> => {
  const options = janitorOptions(req.payload)

  if (!options) return null

  const { docs } = await req.payload.find({
    collection: options.runsSlug as never,
    depth: 0,
    limit: 1,
    overrideAccess: false,
    pagination: false,
    req,
    sort: '-startedAt',
    where: { and: [{ mode: { equals: 'scan' } }, { status: { equals: 'done' } }] },
  })
  const run = docs[0] as Record<string, unknown> | undefined

  if (!run) return null

  return {
    finishedAt: typeof run.finishedAt === 'string' ? run.finishedAt : undefined,
    id: run.id as number | string,
    missing: countOf(run.missing),
    orphans: countOf(run.orphans),
    reclaimable: countOf(run.reclaimableBytes),
    unused: countOf(run.unused),
  }
}
