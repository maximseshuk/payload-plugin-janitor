import type { CollectionConfig, Payload, Where } from 'payload'

import { cleanPrefix, isRewritten, storedPrefix } from '@/server/options/resolveOptions.js'
import { hasTenantField, sameTenants, tenantIdsOf } from '@/server/tenants.js'
import { buildUsageIndex, eachPage, eachVersion } from '@/server/usage/index.js'
import { PLUGIN_NAME } from '@/shared/constants.js'
import type { ScanReport, UsageRef } from '@/shared/types/index.js'
import type { ResolvedCollection, ResolvedOptions } from '@/shared/types/resolved.js'
import type { StorageAdapter } from '@/shared/types/storage.js'

type Stored = {
  _objectKey?: null | string
  filename?: null | string
  prefix?: null | string
  sizes?: null | Record<string, null | { filename?: null | string }>
}

type ScannedDoc = Stored & {
  _status?: string
  createdAt?: string
  deletedAt?: null | string
  filesize?: null | number
  id: number | string
  updatedAt?: string
}

type VersionRow = { parent?: unknown; version?: Stored }

export type Layout = Pick<ResolvedCollection, 'composite' | 'prefix'>

type Upload = Layout & {
  exact: boolean
  keyed: boolean
  prefixed: boolean
  sizes: string[]
  slug: string
  versions: boolean
}

type Kind = 'missing' | 'orphan' | 'unused'

type FindingInput = {
  collectionSlug: string
  documentId?: string
  kind: Kind
  lastSeenAt: string
  objectKey: string
  ref?: string
  run?: number | string
  size?: number
  tenant?: (number | string)[]
  uploadedAt?: string
  usage?: UsageRef[]
}

type Existing = {
  documentId?: null | string
  id: number | string
  kind: Kind
  objectKey: string
  status: string
  tenant?: unknown
}

type Known = { exact: Set<string>; loose: Set<string> }

const PAGE_SIZE = 1000

const CHUNK = 500

const HEARTBEAT_MS = 60_000

const joinKey = (...parts: string[]): string => parts.filter(Boolean).join('/')

const pairOf = (slug: string, key: string): string => `${slug}\u0000${key}`

export const isOldEnough = (date: Date | null | string | undefined, minAge: number): boolean => {
  if (!date) return true

  return Date.now() - new Date(date).getTime() >= minAge * 1000
}

export const sizeNamesOf = (payload: Payload, slug: string): string[] => {
  const upload = payload.collections[slug]?.config.upload as undefined | { imageSizes?: { name: string }[] }

  return upload?.imageSizes?.map((size) => size.name) ?? []
}

const folderOf = (doc: Stored, layout: Layout): string => {
  const own = joinKey(cleanPrefix(doc.prefix ?? ''), cleanPrefix(doc._objectKey ?? ''))

  return layout.composite ? joinKey(layout.prefix, own) : own || layout.prefix
}

export const keyOf = (doc: Stored, layout: Layout): string | undefined =>
  doc.filename ? joinKey(folderOf(doc, layout), doc.filename) : undefined

export const namesOf = (doc: Stored): string[] =>
  [doc.filename, ...Object.values(doc.sizes ?? {}).map((size) => size?.filename)].filter((name): name is string =>
    Boolean(name),
  )

export const keysOf = (doc: Stored, layout: Layout): string[] => {
  const folder = folderOf(doc, layout)

  return namesOf(doc).map((name) => joinKey(folder, name))
}

export const isKeyUnknown = ({ _objectKey: objectKey, prefix }: Stored): boolean =>
  isRewritten(prefix) || isRewritten(objectKey)

const tailsOf = (key: string): string[] => key.split('/').map((_, index, parts) => parts.slice(index).join('/'))

const hasField = (collection: CollectionConfig, name: string): boolean =>
  collection.fields.some((field) => 'name' in field && field.name === name)

export const uploadsOf = (payload: Payload, options: ResolvedOptions): Upload[] =>
  payload.config.collections
    .filter((collection) => collection.upload)
    .map((collection) => {
      const target = options.collections.find((item) => item.slug === collection.slug)
      const stored = storedPrefix(collection)

      return {
        composite: target?.composite ?? false,
        exact: Boolean(target) && (target?.prefixFrom === 'option' || stored !== ''),
        keyed: hasField(collection, '_objectKey'),
        prefix: target?.prefix ?? stored ?? '',
        prefixed: stored !== undefined,
        sizes: sizeNamesOf(payload, collection.slug),
        slug: collection.slug,
        versions: Boolean(collection.versions),
      }
    })

const storedSelect = (upload: Upload): Record<string, true> => ({
  filename: true,
  ...(upload.prefixed ? { prefix: true } : {}),
  ...(upload.keyed ? { _objectKey: true } : {}),
  ...(upload.sizes.length ? { sizes: true } : {}),
})

const versionSelect = (upload: Upload): Record<string, unknown> => ({ parent: true, version: storedSelect(upload) })

const idOf = (value: unknown): string =>
  String(value && typeof value === 'object' ? (value as { id?: unknown }).id : value)

export const isHeld = async (
  payload: Payload,
  options: ResolvedOptions,
  keys: string[],
  { byName = false, except }: { byName?: boolean; except?: { collection: string; id: string } } = {},
): Promise<boolean> => {
  const wanted = new Set(keys)
  const tails = new Set(keys.flatMap(tailsOf))
  const names = [...tails]
  const holds = (stored: Stored = {}, upload: Upload): boolean =>
    byName || isKeyUnknown(stored)
      ? namesOf(stored).some((name) => tails.has(name))
      : keysOf(stored, upload).some((key) => (upload.exact ? wanted : tails).has(key))

  for (const upload of uploadsOf(payload, options)) {
    const match = (path: string): Where => ({
      or: [
        { [`${path}filename`]: { in: names } },
        ...upload.sizes.map((size) => ({ [`${path}sizes.${size}.filename`]: { in: names } })),
      ],
    })
    const own = (id: unknown): boolean => except?.collection === upload.slug && idOf(id) === except.id

    const docs = await payload.find({
      collection: upload.slug as never,
      depth: 0,
      limit: 0,
      pagination: false,
      select: storedSelect(upload) as never,
      trash: true,
      where: match(''),
      overrideAccess: true,
      showHiddenFields: true,
    })

    if ((docs.docs as unknown as ScannedDoc[]).some((doc) => !own(doc.id) && holds(doc, upload))) return true

    if (!upload.versions) continue

    let held = false

    await eachVersion<VersionRow>(payload, upload.slug, versionSelect(upload), match('version.'), (rows) => {
      held ||= rows.some((row) => !own(row.parent) && holds(row.version, upload))
    })

    if (held) return true
  }

  return false
}

export const heartbeat = (
  payload: Payload,
  options: ResolvedOptions,
  runId: number | string | undefined,
): (() => Promise<void>) => {
  let last = Date.now()

  return async () => {
    if (runId === undefined || Date.now() - last < HEARTBEAT_MS) return

    last = Date.now()
    await payload.update({
      collection: options.runsSlug as never,
      data: { heartbeatAt: new Date(last).toISOString() } as never,
      id: runId,
      overrideAccess: true,
    })
  }
}

export const isUsed = (refs: undefined | UsageRef[] | null, versions: 'unused' | 'used'): boolean => {
  if (!refs?.length) return false

  return versions === 'used' || refs.some((ref) => !ref.versions)
}

const hasDrafts = (collection: CollectionConfig): boolean =>
  typeof collection.versions === 'object' && Boolean(collection.versions.drafts)

const latestKeys = async (payload: Payload, upload: Upload, ids: (number | string)[]): Promise<Map<string, string>> => {
  const { docs } = await payload.findVersions({
    collection: upload.slug as never,
    depth: 0,
    limit: 0,
    pagination: false,
    select: versionSelect(upload) as never,
    sort: '-updatedAt',
    trash: true,
    where: { and: [{ parent: { in: ids } }, { latest: { equals: true } }] },
    overrideAccess: true,
    showHiddenFields: true,
  })
  const keys = new Map<string, string>()

  const parents = new Set<string>()

  for (const row of docs as unknown as VersionRow[]) {
    const parent = idOf(row.parent)
    const key = parents.has(parent) ? undefined : row.version && keyOf(row.version, upload)

    parents.add(parent)

    if (key) keys.set(parent, key)
  }

  return keys
}

const pathSelect = (path: string): Record<string, unknown> =>
  path.split('.').reduceRight<Record<string, unknown> | true>((inner, name) => ({ [name]: inner }), true) as Record<
    string,
    unknown
  >

const valueAt = (doc: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((value, name) => (value as Record<string, unknown> | null)?.[name], doc)

const externalOf = (collection: CollectionConfig, storage: StorageAdapter | undefined): string | undefined =>
  storage?.external && hasField(collection, storage.external.split('.')[0]!) ? storage.external : undefined

const selectOf = (
  collection: CollectionConfig,
  upload: Upload | undefined,
  external: string | undefined,
  tenant: string | undefined,
): Record<string, unknown> => ({
  ...(external ? pathSelect(external) : {}),
  ...(tenant ? { [tenant]: true } : {}),
  createdAt: true,
  ...(hasDrafts(collection) ? { _status: true } : {}),
  updatedAt: true,
  ...(collection.trash ? { deletedAt: true } : {}),
  ...(upload ? { ...storedSelect(upload), filesize: true } : {}),
})

export const scanStorage = async (
  payload: Payload,
  options: ResolvedOptions,
  runId?: number | string,
): Promise<ScanReport> => {
  const now = new Date().toISOString()
  const report: ScanReport = {
    byCollection: {},
    missing: 0,
    orphanBytes: 0,
    orphans: 0,
    scanned: 0,
    unused: 0,
    unusedBytes: 0,
  }
  const seen = new Set<string>()
  const scanned = new Set<string>()
  const scopes = new Map<StorageAdapter, Map<string, { claimed: Set<string>; counted: Set<string> }>>()
  const uploads = uploadsOf(payload, options)
  const beat = heartbeat(payload, options, runId)
  let known: Known | undefined

  const knownKeys = async (): Promise<Known> => {
    const keys: Known = { exact: new Set(), loose: new Set() }

    for (const upload of uploads) {
      const into = upload.exact ? keys.exact : keys.loose
      const add = async (docs: Stored[]): Promise<void> => {
        for (const doc of docs) {
          if (isKeyUnknown(doc)) for (const name of namesOf(doc)) keys.loose.add(name)
          else for (const key of keysOf(doc, upload)) into.add(key)
        }

        await beat()
      }

      await eachPage<Stored>(payload, upload.slug, storedSelect(upload), add)

      if (upload.versions) {
        await eachVersion<VersionRow>(payload, upload.slug, versionSelect(upload), undefined, (rows) =>
          add(rows.map((row) => row.version ?? {})),
        )
      }
    }

    return keys
  }

  const knows = (keys: Known, key: string): boolean =>
    keys.exact.has(key) || tailsOf(key).some((tail) => keys.loose.has(tail))

  const scopeOf = (storage: StorageAdapter, target: ResolvedCollection) => {
    const byPrefix = scopes.get(storage) ?? new Map()
    const id = storage.perCollection ? pairOf(target.slug, target.prefix) : target.prefix
    const scope = byPrefix.get(id) ?? { claimed: new Set<string>(), counted: new Set<string>() }

    byPrefix.set(id, scope)
    scopes.set(storage, byPrefix)

    return scope
  }

  const flush = async (inputs: FindingInput[]): Promise<void> => {
    for (const input of inputs) seen.add(pairOf(input.collectionSlug, input.objectKey))

    await upsertFindings(payload, options, inputs)
  }

  for (const target of options.collections) {
    const stats = { missing: 0, objects: 0, orphans: 0, unused: 0 }
    const listed = target.storage && (target.checks.includes('orphans') || target.checks.includes('missing'))
    const present = new Set<string>()
    const under = target.prefix ? `${target.prefix}/` : ''
    const config = payload.collections[target.slug]!.config
    const upload = uploads.find((item) => item.slug === target.slug)
    const external = externalOf(config, target.storage)
    const tenant = options.tenants && hasTenantField(payload, options, target.slug) ? options.tenants.field : undefined
    const select = selectOf(config, upload, external, tenant)
    const isExternal = (doc: ScannedDoc): boolean => Boolean(external && valueAt(doc, external))
    const tenantOf = (doc: ScannedDoc) =>
      options.tenants ? { tenant: tenant ? tenantIdsOf(valueAt(doc, tenant)) : [] } : {}

    report.byCollection[target.slug] = stats
    await beat()

    if (target.storage && listed) {
      known ??= await knownKeys()

      const keys = known
      const scope = scopeOf(target.storage, target)
      const reportsOrphans = target.checks.includes('orphans')

      if (reportsOrphans) scanned.add(pairOf('orphan', target.slug))

      for await (const page of target.storage.list({ collection: target.slug, prefix: target.prefix })) {
        const batch: FindingInput[] = []

        stats.objects += page.length
        await beat()

        for (const object of page) {
          if (object.key.length <= under.length || !object.key.startsWith(under)) continue

          present.add(object.key)

          if (!scope.counted.has(object.key)) {
            scope.counted.add(object.key)
            report.scanned += 1
          }

          if (!reportsOrphans || knows(keys, object.key) || scope.claimed.has(object.key)) continue

          scope.claimed.add(object.key)

          if (!isOldEnough(object.lastModified, options.minAge)) {
            seen.add(pairOf(target.slug, object.key))
            continue
          }

          stats.orphans += 1
          report.orphans += 1
          report.orphanBytes += object.size ?? 0

          batch.push({
            collectionSlug: target.slug,
            kind: 'orphan',
            lastSeenAt: now,
            objectKey: object.key,
            ref: object.ref,
            run: runId,
            size: object.size,
            uploadedAt: object.lastModified?.toISOString(),
          })
        }

        await flush(batch)
      }
    }

    if (listed && target.checks.includes('missing')) {
      scanned.add(pairOf('missing', target.slug))

      await eachPage<ScannedDoc>(payload, target.slug, select, async (docs) => {
        const batch: FindingInput[] = []

        await beat()

        const lost = docs.flatMap((doc) => {
          const key = keyOf(doc, target)

          return !key || isKeyUnknown(doc) || isExternal(doc) || present.has(key) || !key.startsWith(under)
            ? []
            : [{ doc, key }]
        })
        const drafts = lost.filter(({ doc }) => doc._status === 'draft').map(({ doc }) => doc.id)
        const latest =
          upload && drafts.length > 0 && hasDrafts(config)
            ? await latestKeys(payload, upload, drafts)
            : new Map<string, string>()

        for (const { doc, key } of lost) {
          const newer = latest.get(String(doc.id))

          if (newer && present.has(newer)) continue

          if (!isOldEnough(doc.createdAt, options.minAge)) {
            seen.add(pairOf(target.slug, key))
            continue
          }

          stats.missing += 1
          report.missing += 1

          batch.push({
            collectionSlug: target.slug,
            documentId: String(doc.id),
            kind: 'missing',
            lastSeenAt: now,
            objectKey: key,
            run: runId,
            ...tenantOf(doc),
            uploadedAt: doc.createdAt,
          })
        }

        await flush(batch)
      })
    }

    if (target.checks.includes('unused')) {
      const ids = new Set<string>()

      await eachPage<{ id: number | string }>(payload, target.slug, {}, async (docs) => {
        for (const doc of docs) ids.add(String(doc.id))

        await beat()
      })

      await beat()

      const usage = await buildUsageIndex(payload, {
        ...options.references,
        collection: target.slug,
        ids,
        onProgress: beat,
      })

      await beat()

      if (!usage) {
        payload.logger.warn(
          `janitor: usage of "${target.slug}" could not be read reliably, so no unused findings were written for it`,
        )
      } else {
        scanned.add(pairOf('unused', target.slug))

        await eachPage<ScannedDoc>(payload, target.slug, select, async (docs) => {
          const batch: FindingInput[] = []

          await beat()

          for (const doc of docs) {
            if (doc.deletedAt || !ids.has(String(doc.id))) continue

            const refs = usage.get(String(doc.id))

            if (isUsed(refs, options.references.versions)) continue

            const file = target.upload ? keyOf(doc, target) : undefined

            if (listed && file && !present.has(file) && !isExternal(doc)) continue

            const key = file ?? `${target.slug}/${doc.id}`

            if (!isOldEnough(doc.updatedAt, options.minAge)) {
              seen.add(pairOf(target.slug, key))
              continue
            }

            stats.unused += 1
            report.unused += 1
            report.unusedBytes += doc.filesize ?? 0

            batch.push({
              collectionSlug: target.slug,
              documentId: String(doc.id),
              kind: 'unused',
              lastSeenAt: now,
              objectKey: key,
              run: runId,
              size: doc.filesize ?? undefined,
              ...tenantOf(doc),
              uploadedAt: doc.createdAt,
              usage: refs ?? [],
            })
          }

          await flush(batch)
        })
      }
    }
  }

  await dropResolved(payload, options, seen, scanned, beat)

  return report
}

const upsertFindings = async (payload: Payload, options: ResolvedOptions, inputs: FindingInput[]): Promise<void> => {
  const unique = [...new Map(inputs.map((input) => [pairOf(input.collectionSlug, input.objectKey), input])).values()]

  for (let start = 0; start < unique.length; start += CHUNK) {
    const chunk = unique.slice(start, start + CHUNK)
    const slugs = [...new Set(chunk.map((input) => input.collectionSlug))]
    const found = await payload.find({
      collection: options.findingsSlug as never,
      depth: 0,
      limit: 0,
      pagination: false,
      where: {
        or: slugs.map((slug): Where => ({
          and: [
            { collectionSlug: { equals: slug } },
            {
              objectKey: {
                in: chunk.filter((input) => input.collectionSlug === slug).map((input) => input.objectKey),
              },
            },
          ] as Where[],
        })),
      },
      overrideAccess: true,
    })
    const existing = new Map(
      (found.docs as unknown as (Existing & { collectionSlug: string })[]).map((doc) => [
        pairOf(doc.collectionSlug, doc.objectKey),
        doc,
      ]),
    )

    for (const input of chunk) {
      await writeFinding(payload, options, input, existing.get(pairOf(input.collectionSlug, input.objectKey)))
    }
  }
}

const writeFinding = async (
  payload: Payload,
  options: ResolvedOptions,
  input: FindingInput,
  current: Existing | undefined,
): Promise<void> => {
  if (!current) {
    await payload.create({
      collection: options.findingsSlug as never,
      data: { ...input, status: 'found' } as never,
      overrideAccess: true,
    })

    return
  }

  const moved =
    input.tenant !== undefined && tenantIdsOf(current.tenant).length > 0 && !sameTenants(current.tenant, input.tenant)
  const changed =
    current.kind !== input.kind ||
    (current.documentId ?? undefined) !== input.documentId ||
    current.status === 'deleted' ||
    moved

  const data = changed
    ? {
        error: null,
        purgedAt: null,
        purgedBy: null,
        documentId: input.documentId ?? null,
        kind: input.kind,
        lastSeenAt: input.lastSeenAt,
        ref: input.ref ?? null,
        run: input.run,
        size: input.size ?? null,
        status: 'found',
        ...(options.tenants ? { tenant: input.tenant ?? [] } : {}),
        uploadedAt: input.uploadedAt ?? null,
        usage: input.usage ?? null,
      }
    : {
        lastSeenAt: input.lastSeenAt,
        run: input.run,
        ...(input.tenant ? { tenant: input.tenant } : {}),
        ...(current.status === 'found'
          ? { size: input.size, uploadedAt: input.uploadedAt ?? null, usage: input.usage }
          : {}),
      }

  await payload.update({
    collection: options.findingsSlug as never,
    context: { [PLUGIN_NAME]: true },
    data: data as never,
    id: current.id,
    overrideAccess: true,
  })
}

const dropResolved = async (
  payload: Payload,
  options: ResolvedOptions,
  seen: Set<string>,
  scanned: Set<string>,
  beat: () => Promise<void>,
): Promise<void> => {
  const stale: (number | string)[] = []

  for (let page = 1; ; page += 1) {
    const result = await payload.find({
      collection: options.findingsSlug as never,
      depth: 0,
      limit: PAGE_SIZE,
      page,
      select: { collectionSlug: true, kind: true, objectKey: true } as never,
      sort: 'id',
      where: { status: { equals: 'found' } },
      overrideAccess: true,
    })

    for (const doc of result.docs as unknown as {
      collectionSlug: string
      id: number | string
      kind: Kind
      objectKey: string
    }[]) {
      if (!scanned.has(pairOf(doc.kind, doc.collectionSlug))) continue
      if (seen.has(pairOf(doc.collectionSlug, doc.objectKey))) continue

      stale.push(doc.id)
    }

    await beat()

    if (!result.hasNextPage) break
  }

  for (let start = 0; start < stale.length; start += CHUNK) {
    await payload.delete({
      collection: options.findingsSlug as never,
      where: { and: [{ id: { in: stale.slice(start, start + CHUNK) } }, { status: { equals: 'found' } }] },
      overrideAccess: true,
    })
    await beat()
  }
}
