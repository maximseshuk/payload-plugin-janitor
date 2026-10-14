import { reportTelemetry } from '@seshuk/payload-plugin-tooling/telemetry'
import type { Payload } from 'payload'

import { DEFAULT_ENDPOINTS_PATH, DEFAULT_MIN_AGE, PLUGIN_NAME } from '@/shared/constants.js'
import type { JanitorPluginOptions } from '@/shared/types/options.js'
import type { ResolvedOptions } from '@/shared/types/resolved.js'

export type TelemetryFeatures = {
  access: boolean
  admin: boolean
  adminGroupOff: boolean
  adminWidget: boolean
  blockDelete: boolean
  checkMissing: boolean
  checkOrphans: boolean
  checkUnused: boolean
  collectionStorage: boolean
  compositePrefixes: boolean
  documentCollections: boolean
  endpoints: boolean
  endpointsPath: boolean
  jobs: boolean
  minAge: boolean
  overrides: boolean
  referencesIgnoreTables: boolean
  referencesText: boolean
  referencesVersionsUnused: boolean
  schedule: boolean
  storage: boolean
  tenants: boolean
  uploadCollections: boolean
  usagePanel: boolean
}

export const buildFeatures = ({
  options,
  resolved,
}: {
  options: JanitorPluginOptions
  resolved: ResolvedOptions
}): TelemetryFeatures => {
  const { collections } = resolved
  const settings = Object.values(options.collections).flatMap((value) => (typeof value === 'object' ? [value] : []))

  return {
    access: options.access !== undefined,
    admin: resolved.admin !== false,
    adminGroupOff: resolved.admin !== false && resolved.admin.group === false,
    adminWidget: resolved.admin !== false && resolved.admin.widget,
    blockDelete: collections.some((collection) => collection.blockDelete),
    checkMissing: collections.some((collection) => collection.checks.includes('missing')),
    checkOrphans: collections.some((collection) => collection.checks.includes('orphans')),
    checkUnused: collections.some((collection) => collection.checks.includes('unused')),
    collectionStorage: settings.some((value) => value.storage !== undefined),
    compositePrefixes: collections.some((collection) => collection.composite),
    documentCollections: collections.some((collection) => !collection.upload),
    endpoints: resolved.endpoints !== false,
    endpointsPath: resolved.endpoints !== false && resolved.endpoints.path !== DEFAULT_ENDPOINTS_PATH,
    jobs: resolved.jobs !== false,
    minAge: resolved.minAge !== DEFAULT_MIN_AGE,
    overrides: Boolean(options.overrides?.findings || options.overrides?.runs),
    referencesIgnoreTables: Boolean(options.references?.ignoreTables?.length),
    referencesText: resolved.references.text,
    referencesVersionsUnused: resolved.references.versions === 'unused',
    schedule: resolved.jobs !== false && resolved.jobs.schedule !== undefined,
    storage: options.storage !== undefined,
    tenants: resolved.tenants !== false,
    uploadCollections: collections.some((collection) => collection.upload),
    usagePanel: collections.some((collection) => collection.usagePanel !== false),
  }
}

export const reportJanitorTelemetry = ({
  features,
  options,
  payload,
}: {
  features: TelemetryFeatures
  options: JanitorPluginOptions
  payload: Payload
}): Promise<void> =>
  reportTelemetry({
    disableEnv: 'JANITOR_TELEMETRY_DISABLED',
    docsUrl: 'https://github.com/maximseshuk/payload-plugin-janitor#telemetry',
    features,
    option: options.telemetry,
    packageName: PLUGIN_NAME,
    payload,
    product: 'payload-plugin-janitor',
  })
