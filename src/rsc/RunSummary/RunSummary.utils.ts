import type { PayloadRequest, Where } from 'payload'

import { janitorOptions } from '@/server/run.js'

export type Tally = 'deleted' | 'missing' | 'notDeleted' | 'orphans' | 'unused'

export type Breakdown = { counts: Partial<Record<Tally, number>>; slug: string }[]

const KINDS = { missing: 'missing', orphans: 'orphan', unused: 'unused' } as const

export const breakdownOf = async (
  req: PayloadRequest,
  id: number | string,
  mode: 'purge' | 'scan',
): Promise<Breakdown> => {
  const options = janitorOptions(req.payload)

  if (!options) return []

  const count = async (where: Where[]): Promise<number> =>
    (
      await req.payload.count({
        collection: options.findingsSlug as never,
        disableErrors: true,
        overrideAccess: false,
        req,
        where: { and: where },
      })
    ).totalDocs

  const rows = await Promise.all(
    options.collections.map(async ({ checks, slug }) => {
      const own: Where = { collectionSlug: { equals: slug } }
      const tallies: [Tally, Where[]][] =
        mode === 'purge'
          ? [
              ['deleted', [own, { purgedBy: { equals: id } }, { status: { equals: 'deleted' } }]],
              ['notDeleted', [own, { purgedBy: { equals: id } }, { status: { not_equals: 'deleted' } }]],
            ]
          : checks.map((check): [Tally, Where[]] => [
              check,
              [own, { run: { equals: id } }, { kind: { equals: KINDS[check] } }],
            ])
      const counts = Object.fromEntries(
        (await Promise.all(tallies.map(async ([tally, where]) => [tally, await count(where)] as const))).filter(
          ([, total]) => total > 0,
        ),
      )

      return { counts, slug }
    }),
  )

  return rows.filter((row) => Object.keys(row.counts).length > 0)
}
