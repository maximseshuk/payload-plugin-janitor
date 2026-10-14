import type { Payload, PayloadRequest, Where } from 'payload'

import type { UsageHit, UsageRef } from '@/shared/types/index.js'

import { expectsKeys, libraryOf, schemaCandidates } from './candidates.js'
import { entityOf, tableFor, tablesOf } from './catalog.js'
import type { RawHit } from './hits.js'
import { addTitles, group, readableHits, urlOf } from './hits.js'
import { buildUsageIndexMongo, collectMongo, entityOfCollection, findUsageMongo, isMongo } from './mongo.js'
import type { EntityPaths } from './paths.js'
import { entityPaths, type I18n } from './paths.js'
import type { Lookup } from './relational.js'
import { buildUsageIndexRelational, collectRelational, findUsageRelational } from './relational.js'
import { type Dialect, dialectOf } from './sql.js'

const PAGE_SIZE = 1000

const ALWAYS_IGNORED = ['payload-jobs', 'payload_jobs']

export const supportsUsage = (payload: Payload): boolean => Boolean(dialectOf(payload)) || isMongo(payload)

type Id = number | string

const byId = async <T>(
  read: (where: undefined | Where) => Promise<{ docs: unknown[] }>,
  where: undefined | Where,
  handle: (docs: T[]) => Promise<void> | void,
): Promise<void> => {
  let last: Id | undefined

  for (;;) {
    const after: undefined | Where = last === undefined ? undefined : { id: { greater_than: last } }
    const { docs } = await read(where && after ? { and: [where, after] } : (where ?? after))

    await handle(docs as T[])

    if (docs.length < PAGE_SIZE) return
    last = (docs.at(-1) as { id: Id }).id
  }
}

export const eachPage = <T>(
  payload: Payload,
  collection: string,
  select: Record<string, unknown>,
  handle: (docs: T[]) => Promise<void> | void,
): Promise<void> =>
  byId(
    (where) =>
      payload.find({
        collection: collection as never,
        depth: 0,
        limit: PAGE_SIZE,
        pagination: false,
        select: select as never,
        sort: 'id',
        trash: true,
        where,
        overrideAccess: true,
        showHiddenFields: true,
      }),
    undefined,
    handle,
  )

export const eachVersion = <T>(
  payload: Payload,
  collection: string,
  select: Record<string, unknown>,
  where: undefined | Where,
  handle: (rows: T[]) => Promise<void> | void,
): Promise<void> =>
  byId(
    (filter) =>
      payload.findVersions({
        collection: collection as never,
        depth: 0,
        limit: PAGE_SIZE,
        pagination: false,
        select: select as never,
        sort: 'id',
        trash: true,
        where: filter,
        overrideAccess: true,
        showHiddenFields: true,
      }),
    where,
    handle,
  )

const loadIds = async (payload: Payload, collection: string): Promise<Set<string>> => {
  const ids = new Set<string>()

  await eachPage<{ id: number | string }>(payload, collection, {}, (docs) => {
    for (const doc of docs) ids.add(String(doc.id))
  })

  return ids
}

const allPaths = new WeakMap<object, Map<string, Map<string, EntityPaths>>>()

const pathsOf = (payload: Payload, i18n?: I18n): Map<string, EntityPaths> => {
  const byLanguage = allPaths.get(payload.config) ?? new Map<string, Map<string, EntityPaths>>()
  const language = i18n?.language ?? ''
  const cached = byLanguage.get(language)

  if (cached) return cached

  const library = libraryOf(payload.config)
  const paths = new Map(
    [...payload.config.collections, ...payload.config.globals].map((entity) => [
      entity.slug,
      entityPaths(entity.fields, library, i18n),
    ]),
  )

  byLanguage.set(language, paths)
  allPaths.set(payload.config, byLanguage)

  return paths
}

export const entityOfTable = (payload: Payload, table: string): string | undefined =>
  dialectOf(payload) ? entityOf(table, tablesOf(payload))?.slug : entityOfCollection(payload, table)

export type UsageOptions = {
  ignoreTables: string[]
  text: boolean
  versions: 'unused' | 'used'
}

type Target = UsageOptions & { collection: string; transactionID?: number | string }

const lookupOf = (payload: Payload, dialect: Dialect, args: Target): Lookup => ({
  candidates: schemaCandidates(payload.config, args.collection),
  context: { transactionID: args.transactionID },
  dialect,
  expectsKeys: expectsKeys(
    payload.config,
    args.collection,
    Boolean((payload.db as unknown as { blocksAsJSON?: boolean }).blocksAsJSON),
  ),
  ignored: [...args.ignoreTables, ...ALWAYS_IGNORED],
  table: tableFor(payload, args.collection),
  tables: tablesOf(payload),
  text: args.text,
})

const mongoOf = (payload: Payload, args: Target) => ({
  candidates: schemaCandidates(payload.config, args.collection),
  collection: args.collection,
  ignored: [...args.ignoreTables, ...ALWAYS_IGNORED],
  text: args.text,
  versions: args.versions,
})

export const findUsage = async (
  payload: Payload,
  args: UsageOptions & { collection: string; id: string; transactionID?: number | string },
): Promise<null | UsageRef[]> => {
  const dialect = dialectOf(payload)

  if (dialect)
    return findUsageRelational(payload, { ...lookupOf(payload, dialect, args), id: args.id, versions: args.versions })
  if (isMongo(payload)) return findUsageMongo(payload, { ...mongoOf(payload, args), id: args.id })

  return null
}

export const buildUsageIndex = async (
  payload: Payload,
  args: UsageOptions & { collection: string; ids?: Set<string>; onProgress?: () => Promise<void> | void },
): Promise<Map<string, UsageRef[]> | null> => {
  const dialect = dialectOf(payload)

  if (!dialect && !isMongo(payload)) return null

  const ids = args.ids ?? (await loadIds(payload, args.collection))

  if (dialect) {
    return buildUsageIndexRelational(payload, {
      ...lookupOf(payload, dialect, args),
      ids,
      onProgress: args.onProgress,
      versions: args.versions,
    })
  }

  return buildUsageIndexMongo(payload, { ...mongoOf(payload, args), ids, onProgress: args.onProgress })
}

type DetailArgs = UsageOptions & {
  collection: string
  i18n?: I18n
  id: string
  limit?: number
  transactionID?: number | string
  user?: PayloadRequest['user']
}

const isLive = (hit: RawHit): boolean => hit.versionId === undefined || Boolean(hit.latest)

export const usageDetail = async (
  payload: Payload,
  args: DetailArgs,
): Promise<null | { hits: UsageHit[]; total: number; used: boolean }> => {
  const paths = pathsOf(payload, args.i18n)
  const dialect = dialectOf(payload)

  let raw: RawHit[]

  if (dialect) raw = await collectRelational(payload, { ...lookupOf(payload, dialect, args), id: args.id, paths })
  else if (isMongo(payload)) raw = await collectMongo(payload, { ...mongoOf(payload, args), id: args.id, paths })
  else return null

  const used = args.versions === 'used' ? raw.length > 0 : raw.some(isLive)
  const globals = new Set(payload.config.globals.map((global) => global.slug))
  const grouped = group(raw, globals)
  const hits = args.user === undefined ? grouped : await readableHits(payload, grouped, args.user, args.transactionID)

  hits.sort((a, b) => {
    if (a.versionId === undefined && b.versionId !== undefined) return -1
    if (a.versionId !== undefined && b.versionId === undefined) return 1

    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
  })

  const limited = args.limit && args.limit > 0 ? hits.slice(0, args.limit) : hits

  await addTitles(payload, limited, args.transactionID, args.user)

  for (const hit of limited) hit.url = urlOf(payload, hit)

  const total = args.versions === 'used' ? grouped.length : group(raw.filter(isLive), globals).length

  return { hits: limited, total, used }
}

export const findUsageDetail = async (payload: Payload, args: DetailArgs): Promise<null | UsageHit[]> =>
  (await usageDetail(payload, args))?.hits ?? null
