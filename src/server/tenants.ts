import type { AccessResult, Payload, PayloadRequest } from 'payload'

import type { ResolvedOptions } from '@/shared/types/resolved.js'

export const hasTenantField = (payload: Payload, options: ResolvedOptions, slug: string): boolean => {
  const { tenants } = options

  if (!tenants) return false

  return (payload.collections[slug as never]?.config.flattenedFields ?? []).some(
    (field) => field.name === tenants.field && field.type === 'relationship' && field.relationTo === tenants.collection,
  )
}

const isObjectId = (value: unknown): boolean => Boolean(value && typeof value === 'object' && 'toHexString' in value)

export const tenantIdsOf = (value: unknown): (number | string)[] =>
  [value].flat().flatMap((item) => {
    const raw = item && typeof item === 'object' && !isObjectId(item) ? (item as { id?: unknown }).id : item
    const id = isObjectId(raw) ? String(raw) : raw

    return typeof id === 'number' || typeof id === 'string' ? [id] : []
  })

export const sameTenants = (a: unknown, b: unknown): boolean => {
  const key = (value: unknown) => tenantIdsOf(value).map(String).toSorted().join('\u0000')

  return key(a) === key(b)
}

type Remembered<T> = WeakMap<PayloadRequest, { loaded: Promise<T>; user: unknown }>

const everyTenant: Remembered<boolean> = new WeakMap()

const scopes: Remembered<AccessResult> = new WeakMap()

const remember = <T>(cache: Remembered<T>, req: PayloadRequest, load: () => Promise<T>) => {
  const cached = cache.get(req)

  if (cached && cached.user === req.user) return cached.loaded

  const loaded = load()

  cache.set(req, { loaded, user: req.user })

  return loaded
}

export const seesAllTenants = async (req: PayloadRequest, options: ResolvedOptions): Promise<boolean> => {
  const { tenants } = options

  if (!tenants) return true

  return remember(everyTenant, req, async () => {
    const read = req.payload.collections[tenants.collection as never]?.config.access.read

    return Boolean(read) && (await read!({ req } as never)) === true
  })
}

export const tenantScope = async (req: PayloadRequest, options: ResolvedOptions): Promise<AccessResult> => {
  const { tenants } = options

  if (!tenants) return true

  return remember(scopes, req, async () => {
    if (await seesAllTenants(req, options)) return true

    const { docs } = await req.payload.find({
      collection: tenants.collection as never,
      depth: 0,
      pagination: false,
      req,
      select: {} as never,
      overrideAccess: false,
      user: req.user,
    })

    return docs.length ? { tenant: { in: tenantIdsOf(docs) } } : false
  })
}
