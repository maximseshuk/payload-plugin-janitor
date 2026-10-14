import type { Payload, PayloadRequest } from 'payload'

import type { UsageHit } from '@/shared/types/index.js'

export type RawHit = {
  anchor?: string
  autosave?: boolean
  documentId?: number | string
  entity: string
  field: string
  latest?: boolean
  locale?: string
  status?: string
  trashed?: boolean
  updatedAt?: string
  versionId?: number | string
}

const statusOf = (hit: RawHit): UsageHit['status'] => {
  if (hit.trashed) return 'trashed'
  if (hit.versionId !== undefined) return hit.latest && hit.status === 'draft' ? 'draft' : 'version'

  return hit.status === 'draft' ? 'draft' : 'published'
}

const keyOf = (hit: RawHit): string => `${hit.entity}|${hit.documentId ?? ''}|${hit.versionId ?? ''}|${hit.field}`

const isLatestPublished = (hit: RawHit): boolean =>
  hit.versionId !== undefined && Boolean(hit.latest) && hit.status !== 'draft' && !hit.trashed

export const group = (hits: RawHit[], globals: Set<string>): UsageHit[] => {
  const grouped = new Map<string, UsageHit>()
  const documentOf = (hit: RawHit): string => (globals.has(hit.entity) ? hit.entity : `${hit.entity}|${hit.documentId}`)
  const live = new Set(hits.filter((hit) => hit.versionId === undefined).map(documentOf))

  for (const raw of hits) {
    if (isLatestPublished(raw) && live.has(documentOf(raw))) continue

    const hit = isLatestPublished(raw) ? { ...raw, versionId: undefined } : raw
    const key = keyOf(hit)
    const current = grouped.get(key) ?? {
      anchor: hit.anchor,
      autosave: hit.autosave,
      collection: hit.entity,
      count: 0,
      fields: [],
      global: globals.has(hit.entity),
      id: hit.documentId,
      locales: [],
      status: statusOf(hit),
      updatedAt: hit.updatedAt,
      versionId: hit.versionId,
    }

    current.count += 1
    if (!current.fields.includes(hit.field)) current.fields.push(hit.field)
    if (hit.locale && !current.locales!.includes(hit.locale)) current.locales!.push(hit.locale)

    grouped.set(key, current)
  }

  return [...grouped.values()]
}

const adminRoute = (payload: Payload): string => payload.config.routes?.admin ?? '/admin'

const anchorOf = (hit: UsageHit): string =>
  hit.versionId === undefined && hit.anchor ? `#field-${hit.anchor.replaceAll('.', '__')}` : ''

export const urlOf = (payload: Payload, hit: UsageHit): string | undefined => {
  const admin = adminRoute(payload)
  const anchor = anchorOf(hit)

  if (hit.global) {
    return hit.versionId === undefined
      ? `${admin}/globals/${hit.collection}${anchor}`
      : `${admin}/globals/${hit.collection}/versions/${hit.versionId}`
  }

  if (hit.id === undefined || !payload.collections[hit.collection]) return undefined

  return hit.versionId === undefined
    ? `${admin}/collections/${hit.collection}/${hit.id}${anchor}`
    : `${admin}/collections/${hit.collection}/${hit.id}/versions/${hit.versionId}`
}

export const readableHits = async (
  payload: Payload,
  hits: UsageHit[],
  user: PayloadRequest['user'],
  transactionID?: number | string,
): Promise<UsageHit[]> => {
  const visible = new Set<string>()
  const byCollection = new Map<string, Set<number | string>>()
  const globals = new Set<string>()

  for (const hit of hits) {
    if (hit.global) globals.add(hit.collection)
    else if (hit.id !== undefined && payload.collections[hit.collection]) {
      byCollection.set(hit.collection, (byCollection.get(hit.collection) ?? new Set()).add(hit.id))
    }
  }

  for (const [slug, ids] of byCollection) {
    const found = await payload.find({
      collection: slug as never,
      depth: 0,
      disableErrors: true,
      limit: ids.size,
      overrideAccess: false,
      pagination: false,
      req: { transactionID } as never,
      select: {} as never,
      trash: true,
      user: user ?? undefined,
      where: { id: { in: [...ids] } },
    })

    for (const doc of found.docs as { id: number | string }[]) visible.add(`${slug}\u0000${doc.id}`)
  }

  for (const slug of globals) {
    const doc = await payload.findGlobal({
      slug: slug as never,
      depth: 0,
      disableErrors: true,
      overrideAccess: false,
      req: { transactionID } as never,
      user: user ?? undefined,
    })

    if (Object.keys(doc ?? {}).length > 0) visible.add(`${slug}\u0000`)
  }

  return hits.filter((hit) => {
    if (hit.global) return visible.has(`${hit.collection}\u0000`)
    if (hit.id === undefined || !payload.collections[hit.collection]) return true

    return visible.has(`${hit.collection}\u0000${hit.id}`)
  })
}

export const addTitles = async (
  payload: Payload,
  hits: UsageHit[],
  transactionID?: number | string,
  user?: PayloadRequest['user'],
): Promise<void> => {
  const byCollection = new Map<string, Set<number | string>>()

  for (const hit of hits) {
    if (hit.global || hit.id === undefined || !payload.collections[hit.collection]) continue

    const ids = byCollection.get(hit.collection) ?? new Set<number | string>()

    ids.add(hit.id)
    byCollection.set(hit.collection, ids)
  }

  for (const [slug, ids] of byCollection) {
    const collection = payload.config.collections.find((item) => item.slug === slug)
    const useAsTitle = collection?.admin?.useAsTitle ?? 'id'

    const found = await payload.find({
      collection: slug as never,
      depth: 0,
      limit: ids.size,
      pagination: false,
      req: { transactionID } as never,
      select: { [useAsTitle]: true } as never,
      trash: true,
      where: { id: { in: [...ids] } },
      ...(user === undefined
        ? { overrideAccess: true }
        : { disableErrors: true, overrideAccess: false, user: user ?? undefined }),
    })

    const titles = new Map<string, string>()

    for (const doc of found.docs as unknown as Record<string, unknown>[]) {
      const title = doc[useAsTitle]

      titles.set(String(doc.id), title === undefined || title === null ? String(doc.id) : String(title))
    }

    for (const hit of hits) {
      if (hit.collection === slug && hit.id !== undefined) hit.title ??= titles.get(String(hit.id))
    }
  }

  for (const hit of hits) {
    if (!hit.global) continue

    const global = payload.config.globals.find((item) => item.slug === hit.collection)

    hit.title ??= typeof global?.label === 'string' ? global.label : hit.collection
  }
}
