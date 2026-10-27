import { definePlugin } from 'payload'
import type { Config, Plugin } from 'payload'

import { buildFindingsCollection } from '@/server/collections/findings.js'
import { buildRunsCollection } from '@/server/collections/runs.js'
import { withJanitor } from '@/server/collections/upload.js'
import { buildEndpoints } from '@/server/endpoints.js'
import { resolveOptions } from '@/server/options/resolveOptions.js'
import { validateRuntime } from '@/server/options/validateRuntime.js'
import { ensureRunLock, janitorTask } from '@/server/run.js'
import { buildFeatures, reportJanitorTelemetry } from '@/server/telemetry.js'
import { PLUGIN_NAME, WIDGET_SLUG } from '@/shared/constants.js'
import { label, translations } from '@/shared/translations/index.js'
import type { JanitorPluginOptions } from '@/shared/types/options.js'

type Translations = NonNullable<NonNullable<Config['i18n']>['translations']>

const mergeTranslations = (existing: Translations | undefined): Translations => {
  const merged = { ...existing } as Record<string, Record<string, unknown>>

  for (const [language, strings] of Object.entries(translations)) {
    merged[language] = { ...merged[language], ...strings }
  }

  return merged as Translations
}

const withSchema = (options: JanitorPluginOptions, config: Config): Config => {
  const resolved = resolveOptions(options, config)

  return {
    ...config,
    collections: [...(config.collections ?? []), buildFindingsCollection(resolved), buildRunsCollection(resolved)],
    i18n: {
      ...config.i18n,
      translations: mergeTranslations(config.i18n?.translations),
    },
    jobs: {
      ...config.jobs,
      tasks: [...(config.jobs?.tasks ?? []), { ...janitorTask(resolved), handler: async () => ({ output: {} }) }],
    },
  }
}

const withPlugin = (options: JanitorPluginOptions, config: Config): Config => {
  const resolved = resolveOptions(options, config)
  const features = buildFeatures({ options, resolved })

  return {
    ...config,
    admin: resolved.admin
      ? {
          ...config.admin,
          components: {
            ...config.admin?.components,
            providers: [
              ...(config.admin?.components?.providers ?? []),
              '@seshuk/payload-plugin-janitor/client#FieldHighlight',
            ],
          },
          dashboard: resolved.admin.widget
            ? {
                ...config.admin?.dashboard,
                widgets: [
                  ...(config.admin?.dashboard?.widgets ?? []),
                  {
                    slug: WIDGET_SLUG,
                    Component: '@seshuk/payload-plugin-janitor/rsc#JanitorWidget',
                    label: label('widgetLabel'),
                    maxWidth: 'full',
                    minWidth: 'medium',
                  },
                ],
              }
            : config.admin?.dashboard,
        }
      : config.admin,
    collections: [
      ...(config.collections ?? []).map((collection) => withJanitor(collection, resolved)),
      buildFindingsCollection(resolved),
      buildRunsCollection(resolved),
    ],
    custom: {
      ...config.custom,
      [PLUGIN_NAME]: resolved,
    },
    endpoints: [...(config.endpoints ?? []), ...buildEndpoints(resolved)],
    i18n: {
      ...config.i18n,
      translations: mergeTranslations(config.i18n?.translations),
    },
    jobs: {
      ...config.jobs,
      tasks: [...(config.jobs?.tasks ?? []), janitorTask(resolved)],
    },
    onInit: async (payload) => {
      validateRuntime(payload, resolved)
      await ensureRunLock(payload, resolved)

      await config.onInit?.(payload)
      void reportJanitorTelemetry({ features, options, payload })
    },
  }
}

export const janitor: (options: JanitorPluginOptions) => Plugin = definePlugin<JanitorPluginOptions>({
  slug: PLUGIN_NAME,
  plugin: ({ config, options }) => {
    if (options.enabled === false) return withSchema(options, config)

    if (!config.storage?.length) return withPlugin(options, config)

    return {
      ...config,
      storage: [
        ...config.storage,
        { collections: [], init: (stored) => withPlugin(options, stored), name: PLUGIN_NAME },
      ],
    }
  },
})

export { usageField } from '@/server/collections/usageField.js'
export type { UsageFieldOptions } from '@/shared/types/options.js'
export type { InsertPosition } from '@/shared/types/options.js'
export { purgeApproved } from '@/server/purge.js'
export { janitorOptions, runJanitor, startJanitor } from '@/server/run.js'
export { JANITOR_TASK } from '@/server/run.js'
export { scanStorage } from '@/server/scan.js'
export { buildUsageIndex, findUsage, findUsageDetail, supportsUsage } from '@/server/usage/index.js'
export type { UsageOptions } from '@/server/usage/index.js'

export type {
  Check,
  CollectionOverride,
  JanitorAccess,
  JanitorAccessOptions,
  JanitorCollectionOptions,
  JanitorPluginOptions,
  JanitorTenantsOptions,
  JobsOptions,
  UsagePanelOptions,
} from '@/shared/types/options.js'
export type { ResolvedCollection, ResolvedOptions } from '@/shared/types/resolved.js'
export type {
  StorageAdapter,
  StorageDeleteArgs,
  StorageListArgs,
  StorageObject,
  StorageScope,
} from '@/shared/types/storage.js'
export type { JanitorMode, PurgeReport, ScanReport, StartResult, UsageHit, UsageRef } from '@/shared/types/index.js'
