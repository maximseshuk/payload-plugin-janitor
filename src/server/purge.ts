import type { Payload } from 'payload'

import { sameTenants, tenantIdsOf } from '@/server/tenants.js'
import { findUsage } from '@/server/usage/index.js'
import { PLUGIN_NAME } from '@/shared/constants.js'
import type { PurgeReport } from '@/shared/types/index.js'
import type { ResolvedCollection, ResolvedOptions } from '@/shared/types/resolved.js'
import type { StorageObject } from '@/shared/types/storage.js'

import type { Stored } from './scan.js'
import { heartbeat, isHeld, isKeyUnknown, isOldEnough, isUsed, keysOf, namesOf } from './scan.js'

type Finding = {
  collectionSlug?: null | string
  documentId?: null | string
  id: number | string
  kind: 'missing' | 'orphan' | 'unused'
  note?: null | string
  objectKey: string
  ref?: null | string
  size?: null | number
  tenant?: unknown
  uploadedAt?: null | string
}

type Document = Stored & {
  createdAt?: null | string
  deletedAt?: null | string
  id: number | string
  updatedAt?: null | string
}

const PAGE_SIZE = 1000

const sameMoment = (a: null | string | undefined, b: null | string | undefined): boolean =>
  Boolean(a && b) && new Date(a!).getTime() === new Date(b!).getTime()

const approvedIds = async (payload: Payload, options: ResolvedOptions): Promise<(number | string)[]> => {
  const ids: (number | string)[] = []

  for (let page = 1; ; page += 1) {
    const result = await payload.find({
      collection: options.findingsSlug as never,
      depth: 0,
      limit: PAGE_SIZE,
      page,
      select: { status: true } as never,
      sort: 'id',
      where: { status: { equals: 'delete' } },
      overrideAccess: true,
    })

    ids.push(...(result.docs as unknown as { id: number | string }[]).map((doc) => doc.id))

    if (!result.hasNextPage) return ids
  }
}

const lookUp = async (target: ResolvedCollection, key: string): Promise<Error | StorageObject | undefined> => {
  try {
    for await (const page of target.storage!.list({ collection: target.slug, keys: [key], prefix: target.prefix })) {
      const hit = page.find((object) => object.key === key)

      if (hit) return hit
    }
  } catch (err) {
    return err as Error
  }

  return undefined
}

export const purgeApproved = async (
  payload: Payload,
  options: ResolvedOptions,
  runId?: number | string,
): Promise<PurgeReport> => {
  const report: PurgeReport = { deleted: 0, failed: [], freedBytes: 0, skipped: [] }
  const beat = heartbeat(payload, options, runId)
  const ids = await approvedIds(payload, options)

  for (let start = 0; start < ids.length; start += PAGE_SIZE) {
    const approved = await payload.find({
      collection: options.findingsSlug as never,
      depth: 0,
      limit: 0,
      pagination: false,
      sort: 'id',
      where: { and: [{ id: { in: ids.slice(start, start + PAGE_SIZE) } }, { status: { equals: 'delete' } }] },
      overrideAccess: true,
    })

    for (const doc of approved.docs as unknown as Finding[]) {
      await beat()
      await purgeOne(payload, options, doc, report, runId)
    }
  }

  return report
}

const purgeOne = async (
  payload: Payload,
  options: ResolvedOptions,
  doc: Finding,
  report: PurgeReport,
  runId: number | string | undefined,
): Promise<void> => {
  const target = options.collections.find((item) => item.slug === doc.collectionSlug)

  const mark = (data: Record<string, unknown>) =>
    payload.update({
      collection: options.findingsSlug as never,
      context: { [PLUGIN_NAME]: true },
      data: { error: null, ...data, ...(runId === undefined ? {} : { purgedBy: runId }) } as never,
      id: doc.id,
      overrideAccess: true,
    })

  const noted = (reason: string): string =>
    !doc.note?.trim() ? reason : doc.note.split('\n').includes(reason) ? doc.note : `${doc.note.trimEnd()}\n${reason}`

  const skip = async (reason: string, status: 'delete' | 'keep' = 'keep'): Promise<void> => {
    report.skipped.push({ key: doc.objectKey, reason })
    await mark({ note: noted(reason), status })
  }

  const fail = async (error: string): Promise<void> => {
    report.failed.push({ error, key: doc.objectKey })
    await mark({ error })
  }

  const remove = async (perform: () => Promise<unknown>, trashed = false): Promise<void> => {
    try {
      await perform()
      await mark({
        ...(trashed ? { note: noted('trashed') } : {}),
        purgedAt: new Date().toISOString(),
        status: 'deleted',
      })

      report.deleted += 1

      if (!trashed) report.freedBytes += doc.size ?? 0
    } catch (err) {
      await fail((err as Error).message)
    }
  }

  if (!target) return skip('collection is not watched', 'delete')

  if (doc.kind === 'missing') return skip('a missing file has nothing to delete')

  if (doc.kind === 'orphan') {
    const adapter = target.storage

    if (!adapter) return skip('no storage adapter configured', 'delete')

    if (target.prefix && !doc.objectKey.startsWith(`${target.prefix}/`)) {
      return skip('the key is outside the collection prefix')
    }

    if (await isHeld(payload, options, [doc.objectKey])) return skip('the file is referenced by a document again')

    const object = await lookUp(target, doc.objectKey)

    if (object instanceof Error) {
      return fail(object.message)
    }

    if (!object) {
      report.deleted += 1
      await mark({ note: noted('the object was already gone'), purgedAt: new Date().toISOString(), status: 'deleted' })

      return
    }

    if (!isOldEnough(object.lastModified, options.minAge)) {
      return skip('the object was written again recently')
    }

    return remove(() =>
      adapter.delete({
        collection: target.slug,
        key: doc.objectKey,
        prefix: target.prefix,
        ref: object.ref ?? doc.ref ?? undefined,
      }),
    )
  }

  const found = doc.documentId
    ? await payload.find({
        collection: target.slug as never,
        depth: 0,
        limit: 1,
        trash: true,
        where: { id: { equals: doc.documentId } },
        overrideAccess: true,
        showHiddenFields: true,
      })
    : undefined

  const document = found?.docs[0] as Document | undefined

  if (!document) return skip('the document is already gone')

  if (!sameMoment(doc.uploadedAt, document.createdAt)) {
    return skip('the document is not the one the scan found: its id now belongs to a newer document')
  }

  if (
    options.tenants &&
    tenantIdsOf(doc.tenant).length > 0 &&
    !sameTenants(doc.tenant, (document as Record<string, unknown>)[options.tenants.field])
  ) {
    return skip('the document moved to another tenant')
  }

  if (document.deletedAt) return skip('the document is already in the trash')

  if (!isOldEnough(document.updatedAt, options.minAge)) return skip('the document changed recently')

  const usage = await findUsage(payload, { ...options.references, collection: target.slug, id: String(document.id) })

  if (usage === null) return skip('usage detection is not available for this database')

  if (isUsed(usage, options.references.versions)) return skip('the document is referenced again')

  const byName = target.upload && isKeyUnknown(document)
  const files = target.upload ? (byName ? namesOf(document) : keysOf(document, target)) : []
  const own = { collection: target.slug, id: String(document.id) }

  if (files.length && (await isHeld(payload, options, files, { byName, except: own }))) {
    return skip('another document holds the same file')
  }

  return remove(async () => {
    if (target.trash) {
      await payload.update({
        collection: target.slug as never,
        data: { deletedAt: new Date().toISOString() } as never,
        id: document.id,
        overrideAccess: true,
      })

      return
    }

    await payload.delete({
      collection: target.slug as never,
      context: { [PLUGIN_NAME]: own },
      id: document.id,
      overrideAccess: true,
      showHiddenFields: true,
    })
  }, target.trash)
}
