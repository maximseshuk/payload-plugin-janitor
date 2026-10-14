import type { Payload } from 'payload'

import type { UsageRef } from '@/shared/types/index.js'

import type { SchemaCandidates } from './candidates.js'
import type { RawHit } from './hits.js'
import { type EntityPaths, type Place, placeOf } from './paths.js'
import { asId, walkIds } from './walk.js'

type Document = Record<string, unknown>

type MongoCollection = {
  collectionName: string
  find: (filter: Record<string, unknown>, options?: { projection?: Record<string, 1> }) => AsyncIterable<Document>
}

type MongoDb = {
  collections: () => Promise<MongoCollection[]>
}

const getDb = (payload: Payload): MongoDb | undefined =>
  (payload.db as unknown as { connection?: { db?: MongoDb } }).connection?.db

export const isMongo = (payload: Payload): boolean => Boolean(getDb(payload))

type NamedCandidate = SchemaCandidates & { versions: boolean }

type Match = {
  candidate: NamedCandidate
  document: Document
  hits: Map<string, Map<string, number>>
  name: string
}

const BATCH = 500

type Progress = () => Promise<void> | void

const META = ['parent', 'latest', 'autosave', '_status', 'deletedAt', 'updatedAt', 'globalType']

const projectionFor = (candidate: SchemaCandidates): Record<string, 1> | undefined => {
  if (!candidate.fields.size) return undefined

  const projection: Record<string, 1> = {}

  for (const field of [...candidate.fields, ...META]) {
    projection[field] = 1
    projection[`version.${field}`] = 1
  }

  return projection
}

const inFields = (path: string, candidate: SchemaCandidates): boolean =>
  !candidate.fields.size || candidate.fields.has(path.replace(/^version\./, '').split('.')[0] ?? '')

const selfOf = (document: Document, candidate: NamedCandidate, own: string): string | undefined => {
  if (candidate.kind !== 'collection' || candidate.slug !== own) return undefined

  return asId(candidate.versions ? document.parent : document._id)
}

const scan = async (
  payload: Payload,
  args: {
    candidates: Map<string, SchemaCandidates>
    ids: Set<string>
    ignored: string[]
    onProgress?: Progress
    own: string
    text: boolean
  },
  onMatch: (match: Match) => void,
): Promise<void> => {
  const db = getDb(payload)

  if (!db) return

  const named = candidatesByCollectionName(payload, args.candidates)
  const ignored = ignoredNames(payload, args.ignored)
  const owned = ownedNames(payload)

  for (const collection of await db.collections()) {
    const name = collection.collectionName

    if (ignored.has(name)) continue

    const candidate = named.get(name) ?? candidateFor(name, args.candidates, args.text || !owned.has(name))

    if (!candidate) continue

    const projection = args.text ? undefined : projectionFor(candidate)
    let read = 0

    for await (const document of collection.find({}, { projection })) {
      read += 1
      if (read % BATCH === 0) await args.onProgress?.()

      const hits = new Map<string, Map<string, number>>()
      const self = selfOf(document, candidate, args.own)

      const whole = walkIds(document, (id, path) => {
        if (path === '_id' || id === self || !args.ids.has(id)) return
        if (projection && !inFields(path, candidate)) return

        const paths = hits.get(id) ?? new Map<string, number>()

        paths.set(path, (paths.get(path) ?? 0) + 1)
        hits.set(id, paths)
      })

      if (!whole) throw new Error(`janitor: a document in "${name}" nests too deep to be checked for references`)

      if (hits.size) onMatch({ candidate, document, hits, name })
    }

    await args.onProgress?.()
  }
}

type Models = {
  collections?: Record<string, { collection?: { collectionName?: string } }>
  globals?: { collection?: { collectionName?: string } }
  versions?: Record<string, { collection?: { collectionName?: string } }>
}

const candidatesByCollectionName = (
  payload: Payload,
  candidates: Map<string, SchemaCandidates>,
): Map<string, NamedCandidate> => {
  const models = payload.db as unknown as Models
  const result = new Map<string, NamedCandidate>()

  for (const [slug, candidate] of candidates) {
    if (candidate.kind === 'global') continue

    const live = models.collections?.[slug]?.collection?.collectionName
    const history = models.versions?.[slug]?.collection?.collectionName

    if (live) result.set(live, { ...candidate, versions: false })
    if (history) result.set(history, { ...candidate, versions: true })
  }

  const merged = mergedGlobals(candidates)

  if (merged) {
    const globals = models.globals?.collection?.collectionName

    if (globals) result.set(globals, { ...merged, versions: false })

    for (const [slug, model] of Object.entries(models.versions ?? {})) {
      const name = model?.collection?.collectionName

      if (name && !result.has(name) && candidates.get(slug)?.kind === 'global') {
        result.set(name, { ...merged, versions: true })
      }
    }
  }

  return result
}

const mergedGlobals = (candidates: Map<string, SchemaCandidates>): SchemaCandidates | undefined => {
  const fields = new Set<string>()

  for (const candidate of candidates.values()) {
    if (candidate.kind !== 'global') continue

    for (const field of candidate.fields) fields.add(field)
  }

  return fields.size ? { fields, kind: 'global', slug: 'globals' } : undefined
}

const candidateFor = (
  name: string,
  candidates: Map<string, SchemaCandidates>,
  any: boolean,
): NamedCandidate | undefined => {
  const bare = name.replace(/_versions$/, '')
  const versions = bare !== name
  const slug = versions ? bare.replace(/^_/, '') : bare
  const found =
    candidates.get(bare) ??
    candidates.get(slug) ??
    (bare === 'globals' ? mergedGlobals(candidates) : undefined) ??
    (any
      ? {
          fields: new Set<string>(),
          kind: bare === 'globals' ? 'global' : 'collection',
          slug: bare === 'globals' ? 'globals' : slug,
        }
      : undefined)

  return found && { ...found, versions }
}

export const entityOfCollection = (payload: Payload, name: string): string | undefined => {
  const models = payload.db as unknown as Models

  for (const group of [models.collections, models.versions]) {
    for (const [slug, model] of Object.entries(group ?? {})) {
      if (model?.collection?.collectionName === name) return slug
    }
  }

  return undefined
}

const ownedNames = (payload: Payload): Set<string> => {
  const models = payload.db as unknown as Models
  const names = new Set<string>()

  for (const model of [
    ...Object.values(models.collections ?? {}),
    ...Object.values(models.versions ?? {}),
    models.globals,
  ]) {
    const name = model?.collection?.collectionName

    if (name) names.add(name)
  }

  return names
}

const ignoredNames = (payload: Payload, ignored: string[]): Set<string> => {
  const models = payload.db as unknown as Models
  const names = new Set(ignored)

  for (const slug of ignored) {
    for (const model of [models.collections?.[slug], models.versions?.[slug]]) {
      const name = model?.collection?.collectionName

      if (name) names.add(name)
    }
  }

  return names
}

const isOldVersion = (match: Match): boolean => match.candidate.versions && match.document.latest !== true

const refOf = (match: Match, column: string, count: number, versions: 'unused' | 'used'): UsageRef =>
  versions === 'unused' && isOldVersion(match)
    ? { column, count, table: match.name, versions: true }
    : { column, count, table: match.name }

export const findUsageMongo = async (
  payload: Payload,
  args: {
    candidates: Map<string, SchemaCandidates>
    collection: string
    id: string
    ignored: string[]
    text: boolean
    versions: 'unused' | 'used'
  },
): Promise<UsageRef[]> => {
  const usage: UsageRef[] = []

  await scan(
    payload,
    {
      candidates: args.candidates,
      ids: new Set([args.id]),
      ignored: args.ignored,
      own: args.collection,
      text: args.text,
    },
    (match) => {
      for (const paths of match.hits.values()) {
        for (const [path, count] of paths) usage.push(refOf(match, path, count, args.versions))
      }
    },
  )

  return usage
}

export const buildUsageIndexMongo = async (
  payload: Payload,
  args: {
    candidates: Map<string, SchemaCandidates>
    collection: string
    ids: Set<string>
    ignored: string[]
    onProgress?: Progress
    text: boolean
    versions: 'unused' | 'used'
  },
): Promise<Map<string, UsageRef[]>> => {
  const index = new Map<string, UsageRef[]>()

  await scan(
    payload,
    {
      candidates: args.candidates,
      ids: args.ids,
      ignored: args.ignored,
      onProgress: args.onProgress,
      own: args.collection,
      text: args.text,
    },
    (match) => {
      for (const [id, paths] of match.hits) {
        for (const [path, count] of paths) {
          const ref = refOf(match, path, count, args.versions)
          const refs = index.get(id)

          if (refs) refs.push(ref)
          else index.set(id, [ref])
        }
      }
    },
  )

  return index
}

const fieldOfPath = (path: string, paths: EntityPaths | undefined, localized: boolean): Place & { locale?: string } => {
  const parts: string[] = []
  let locale: string | undefined

  for (const part of path.replace(/^version\./, '').split('.')) {
    if (/^\d+$/.test(part)) continue
    if (localized && locale === undefined && parts.length && paths?.localized.has(parts.join('.'))) {
      locale = part
      continue
    }

    parts.push(part)
  }

  return { ...placeOf(paths, parts), locale }
}

const statusOf = (value: unknown): string | undefined => {
  if (value && typeof value === 'object') return Object.values(value).toSorted()[0] as string | undefined

  return String(value ?? '') || undefined
}

export const collectMongo = async (
  payload: Payload,
  args: {
    candidates: Map<string, SchemaCandidates>
    collection: string
    id: string
    ignored: string[]
    paths: Map<string, EntityPaths>
    text: boolean
  },
): Promise<RawHit[]> => {
  const hits: RawHit[] = []

  await scan(
    payload,
    {
      candidates: args.candidates,
      ids: new Set([args.id]),
      ignored: args.ignored,
      own: args.collection,
      text: args.text,
    },
    ({ candidate, document, hits: found, name }) => {
      const version = document.version as Document | undefined
      const versioned = candidate.versions
      const entity =
        candidate.slug === 'globals' ? String(document.globalType ?? version?.globalType ?? '') || name : candidate.slug

      for (const path of found.get(args.id)?.keys() ?? []) {
        hits.push({
          autosave: document.autosave === true,
          documentId: versioned ? asId(document.parent) : asId(document._id),
          entity,
          ...fieldOfPath(path, args.paths.get(entity), Boolean(payload.config.localization)),
          latest: document.latest === true,
          status: statusOf(version?._status ?? document._status),
          trashed: Boolean(document.deletedAt ?? version?.deletedAt),
          updatedAt: typeof document.updatedAt === 'string' ? document.updatedAt : undefined,
          versionId: versioned ? asId(document._id) : undefined,
        })
      }
    },
  )

  return hits
}
