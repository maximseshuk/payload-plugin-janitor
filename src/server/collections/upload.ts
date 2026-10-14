import { getTranslation } from '@payloadcms/translations'
import { insertField } from '@seshuk/payload-plugin-tooling/fields'
import type { CollectionBeforeDeleteHook, CollectionConfig, Payload, PayloadRequest } from 'payload'
import { APIError } from 'payload'

import { isUsed } from '@/server/scan.js'
import { entityOfTable, findUsage, supportsUsage, usageDetail } from '@/server/usage/index.js'
import { PLUGIN_NAME } from '@/shared/constants.js'
import type { UsageHit, UsageRef } from '@/shared/types/index.js'
import type { ResolvedCollection, ResolvedOptions } from '@/shared/types/resolved.js'

import { usageField } from './usageField.js'

const NAMED = 3

const nameOf = (payload: Payload, slug: string, i18n: PayloadRequest['i18n']): string => {
  const label =
    payload.collections[slug]?.config.labels.singular ??
    payload.config.globals.find((global) => global.slug === slug)?.label
  const text = label ? getTranslation(label as never, i18n) : undefined

  return typeof text === 'string' && text ? text : slug
}

const describe = (payload: Payload, hits: UsageHit[], i18n: PayloadRequest['i18n']): string =>
  hits
    .slice(0, NAMED)
    .map((hit) =>
      [hit.title ?? `${nameOf(payload, hit.collection, i18n)} ${hit.id ?? ''}`.trim(), ...hit.fields].join(' › '),
    )
    .join(', ')

const tablesOf = (payload: Payload, usage: UsageRef[], i18n: PayloadRequest['i18n']): string =>
  [
    ...new Set(
      usage.map((ref) => {
        const slug = entityOfTable(payload, ref.table)

        return slug ? nameOf(payload, slug, i18n) : ref.table
      }),
    ),
  ].join(', ')

const guard =
  (options: ResolvedOptions, target: ResolvedCollection): CollectionBeforeDeleteHook =>
  async ({ context, id, req }) => {
    const purge = context[PLUGIN_NAME] as undefined | { collection?: unknown; id?: unknown }

    if (!id || (purge?.collection === target.slug && purge.id === String(id)) || !supportsUsage(req.payload)) return

    const transactionID = await req.transactionID
    const args = {
      ...options.references,
      collection: target.slug,
      id: String(id),
      transactionID,
    }

    const usage = await findUsage(req.payload, args)

    if (!usage || !isUsed(usage, options.references.versions)) return

    const detail = await usageDetail(req.payload, {
      ...args,
      i18n: req.i18n,
      ...(req.payloadAPI === 'local' && !req.user ? {} : { user: req.user }),
    }).catch(() => null)
    const blocking =
      detail?.hits.filter((hit) => options.references.versions === 'used' || hit.status !== 'version') ?? []
    const refs = usage.filter((ref) => options.references.versions === 'used' || !ref.versions)
    const named = blocking.length ? describe(req.payload, blocking, req.i18n) : tablesOf(req.payload, refs, req.i18n)
    const count = detail?.total || refs.reduce((total, ref) => total + ref.count, 0)

    throw new APIError(req.t(`${PLUGIN_NAME}:deleteBlocked` as never, { count, places: named }), 400)
  }

export const withJanitor = (collection: CollectionConfig, options: ResolvedOptions): CollectionConfig => {
  const target = options.collections.find((item) => item.slug === collection.slug)

  if (!target) return collection

  const fields =
    target.usagePanel && options.endpoints
      ? insertField(
          collection.fields,
          target.usagePanel.position,
          usageField({ ...target.usagePanel, endpointsPath: options.endpoints.path }),
        )
      : collection.fields

  return {
    ...collection,
    fields,
    hooks: {
      ...collection.hooks,
      beforeDelete: [
        ...(collection.hooks?.beforeDelete ?? []),
        ...(target.blockDelete ? [guard(options, target)] : []),
      ],
    },
  }
}
