import type { Payload } from 'payload'

import { hasTenantField } from '@/server/tenants.js'
import { supportsUsage } from '@/server/usage/index.js'
import type { ResolvedOptions } from '@/shared/types/resolved.js'

import { ambiguous, needsStorage, notComposite, notCompositeStorage, storedPrefix } from './resolveOptions.js'

export const validateRuntime = (payload: Payload, resolved: ResolvedOptions): void => {
  const needsUsage = resolved.collections.find(
    (collection) => collection.checks.includes('unused') || collection.usagePanel || collection.blockDelete,
  )

  if (needsUsage && !supportsUsage(payload)) {
    throw new Error(
      `janitor: usage detection needs the Postgres, SQLite or MongoDB adapter; "${needsUsage.slug}" cannot be checked`,
    )
  }

  for (const collection of resolved.collections) {
    if (!collection.upload) continue

    const config = payload.config.collections.find((item) => item.slug === collection.slug)
    const stored = config ? storedPrefix(config) : undefined

    if (collection.prefixFrom === 'option') {
      if (stored === '' && !collection.composite && collection.prefix) {
        throw notComposite(collection.slug, collection.prefix)
      }

      if (collection.composite && stored) throw notCompositeStorage(collection.slug, stored)

      continue
    }

    if ((stored ?? '') !== collection.prefix) {
      throw new Error(
        `janitor: "${collection.slug}" stores files under "${stored ?? ''}" but janitor read "${collection.prefix}" before its storage plugin ran; list janitor after the storage plugins in \`plugins\`, or pass \`prefix\``,
      )
    }

    if (stored === '' && needsStorage(collection.checks)) throw ambiguous(collection.slug)
  }

  for (const collection of resolved.collections) {
    if (collection.upload && !collection.storage && collection.checks.length) {
      payload.logger.info(`janitor: "${collection.slug}" has no storage, so only \`unused\` is reported`)
    }
  }

  if (resolved.tenants) {
    const { collection, field } = resolved.tenants
    const unscoped = resolved.collections.filter((item) => !hasTenantField(payload, resolved, item.slug))

    if (unscoped.length === resolved.collections.length) {
      throw new Error(
        `janitor: \`tenants\` is on, but no listed collection has a \`${field}\` relationship to "${collection}"; is @payloadcms/plugin-multi-tenant set up?`,
      )
    }

    for (const item of unscoped) {
      payload.logger.info(
        `janitor: "${item.slug}" has no \`${field}\` field, so its findings are visible only to users who see every tenant`,
      )
    }
  }

  if (resolved.jobs && resolved.jobs.schedule && !payload.config.jobs?.autoRun) {
    payload.logger.warn(
      `janitor: \`jobs.schedule\` queues a scan but nothing runs the "${resolved.jobs.queue}" queue; set Payload's \`jobs.autoRun\` or call GET /api/payload-jobs/handle-schedules and /run from outside`,
    )
  }
}
