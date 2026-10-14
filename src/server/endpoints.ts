import type { Endpoint, PayloadRequest } from 'payload'

import { seesAllTenants } from '@/server/tenants.js'
import { supportsUsage, usageDetail } from '@/server/usage/index.js'
import type { JanitorMode, StartResult } from '@/shared/types/index.js'
import type { ResolvedOptions } from '@/shared/types/resolved.js'

import { operations } from './openapi.js'
import { startRun } from './run.js'

const forbidden = (): Response => Response.json({ error: 'Forbidden' }, { status: 403 })

type Action = keyof ResolvedOptions['access']

const allowed = async (options: ResolvedOptions, req: PayloadRequest, action: Action): Promise<boolean> =>
  Boolean(await options.access[action]({ req }))

const mayDeleteTargets = async (options: ResolvedOptions, req: PayloadRequest): Promise<boolean> => {
  for (const target of options.collections) {
    const { totalDocs } = await req.payload.count({
      collection: options.findingsSlug as never,
      overrideAccess: true,
      where: { and: [{ collectionSlug: { equals: target.slug } }, { status: { equals: 'delete' } }] },
    })

    if (!totalDocs) continue

    const access = req.payload.collections[target.slug as never]?.config.access.delete

    if (!access || (await access({ req } as never)) !== true) return false
  }

  return true
}

const runHandler =
  (options: ResolvedOptions, mode: JanitorMode): Endpoint['handler'] =>
  async (req) => {
    if (!(await allowed(options, req, mode)) || !(await seesAllTenants(req, options))) return forbidden()
    if (mode === 'purge' && !(await mayDeleteTargets(options, req))) return forbidden()

    let result: StartResult

    try {
      result = await startRun(req.payload, options, mode)
    } catch (err) {
      req.payload.logger.error({ err, msg: `janitor: the ${mode} failed` })

      const error: StartResult = { error: (err as Error).message, queued: false, started: false }

      return Response.json(error, { status: 500 })
    }

    return Response.json(result, { status: result.started ? 200 : 409 })
  }

const usageHandler =
  (options: ResolvedOptions): Endpoint['handler'] =>
  async (req) => {
    if (!(await allowed(options, req, 'read'))) return forbidden()

    const { collection, id } = req.routeParams as { collection?: string; id?: string }

    if (!collection || !id) return Response.json({ error: 'Missing parameters' }, { status: 400 })
    if (!options.collections.some((item) => item.slug === collection)) {
      return Response.json({ error: 'Collection is not watched' }, { status: 400 })
    }

    const readable = await req.payload
      .findByID({
        collection: collection as never,
        depth: 0,
        disableErrors: true,
        id,
        overrideAccess: false,
        select: {} as never,
        trash: true,
        user: req.user,
      })
      .catch(() => null)

    if (!readable) return Response.json({ error: 'Not found' }, { status: 404 })

    if (!supportsUsage(req.payload)) return Response.json({ supported: false, usage: [] })

    const limit = Number(req.searchParams?.get('limit') ?? 0)

    const detail = await usageDetail(req.payload, {
      ...options.references,
      collection,
      i18n: req.i18n,
      id,
      limit: Number.isFinite(limit) ? limit : 0,
      user: req.user,
    })

    if (!detail) return Response.json({ supported: false, usage: [] })

    return Response.json({ supported: true, usage: detail.hits, used: detail.used })
  }

export const buildEndpoints = (options: ResolvedOptions): Endpoint[] => {
  if (!options.endpoints) return []

  const { path } = options.endpoints

  return [
    {
      custom: { openapi: operations.scan },
      handler: runHandler(options, 'scan'),
      method: 'post',
      path: `${path}/scan`,
    },
    {
      custom: { openapi: operations.purge },
      handler: runHandler(options, 'purge'),
      method: 'post',
      path: `${path}/purge`,
    },
    {
      custom: { openapi: operations.usage },
      handler: usageHandler(options),
      method: 'get',
      path: `${path}/usage/:collection/:id`,
    },
  ]
}
