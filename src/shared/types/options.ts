import type { CollectionConfig, CollectionSlug, Field, PayloadRequest, UIField } from 'payload'

import type { StorageAdapter } from './storage.js'

/**
 * Where the usage field goes in a collection: the sidebar by default, or next to a field you name.
 * A field inside a group or tab can be named by its dotted path, such as `meta.alt`.
 */
export type InsertPosition = 'first' | 'last' | 'sidebar' | { after: string } | { before: string }

/** Changes to one of the plugin's collections. Top-level keys replace the default; `access`, `admin` and `labels` are merged one level deep; `hooks` run after the plugin's own. */
export type CollectionOverride = Partial<Omit<CollectionConfig, 'fields'>> & {
  /** Builds the field list from the default one. Keep the fields the plugin reads and writes. */
  fields?: (args: { defaultFields: Field[] }) => Field[]
}

/** Who may use the plugin. Receives the request; return `true` to let it through. */
export type JanitorAccess = (args: { req: PayloadRequest }) => boolean | Promise<boolean>

export type UsageFieldOptions = {
  /** Where the plugin puts the field. Ignored when the field is added by hand. Payload 4 shows the sidebar of an upload collection below its fields, so there the panel goes first. @default 'sidebar', or 'first' on an upload collection */
  position?: InsertPosition
  /** The plugin's `endpoints.path`, when you changed it. @default '/janitor' */
  endpointsPath?: string
  /** How many referencing documents the panel lists before the rest move behind a button; the drawer always lists all. `0` lists three. @default 0 */
  limit?: number
  /** Payload field overrides; `name` and `type` stay as they are. */
  overrides?: Partial<Omit<UIField, 'name' | 'type'>>
}

/** What a scan may report for one collection. `orphans` and `missing` need storage; `unused` needs the reverse index. */
export type Check = 'missing' | 'orphans' | 'unused'

/** The usage panel as the plugin places it: where, and how many places before the rest hide behind a button. */
export type UsagePanelOptions = Omit<UsageFieldOptions, 'endpointsPath'>

export type JanitorCollectionOptions = {
  /** Which findings a scan writes. `true` is every check this collection can have; `false` scans nothing but keeps `usagePanel` and `blockDelete`. @default true */
  report?: boolean | Check[]
  /** The «where is this used» panel on the edit view. `true` puts it in the sidebar, or first on an upload collection; an object says where and how much. @default true, or false with `endpoints: false` */
  usagePanel?: boolean | UsagePanelOptions
  /** Refuse `delete` while another document or global still references this one. A reference in an old version counts only with `references.versions: 'used'`. @default true */
  blockDelete?: boolean
  /** Listing and deletion for this collection's objects. Overrides the global `storage`. Upload collections only. @default the top-level `storage` */
  storage?: StorageAdapter
  /** Key prefix inside that storage. Upload collections only. @default the default of the storage plugin's `prefix` field, or `''` without one */
  prefix?: string
  /** The storage plugin runs with `useCompositePrefixes`: keys are `prefix/<document folder>/<filename>`. Needs `prefix`, the one the storage plugin was given (`''` for none). Upload collections only. @default false */
  compositePrefixes?: boolean
}

export type JobsOptions = {
  /** Payload jobs queue the `janitor-run` task is added to. Something must run that queue: `autoRun`, `payload.jobs.run()` or `GET /api/payload-jobs/run`. @default 'default' */
  queue?: string
  /** Cron for a scheduled scan, for example `0 3 * * *`. Needs `autoRun` or `GET /api/payload-jobs/handle-schedules`; `autoRun` never fires on serverless. @default none */
  schedule?: string
}

export type JanitorTenantsOptions = {
  /** Slug of the tenants collection. @default 'tenants' */
  collection?: CollectionSlug
  /** Name of the tenant relationship field on documents. @default 'tenant' */
  field?: string
}

/** Who may do what. A function covers every action; an object sets each action on its own. */
export type JanitorAccessOptions =
  | JanitorAccess
  | {
      /** Read findings and runs, and the usage panel. @default a logged-in user of the `admin.user` collection */
      read?: JanitorAccess
      /** Change a finding's status or note, and delete findings and runs. @default a logged-in user of the `admin.user` collection */
      approve?: JanitorAccess
      /** Start a scan. @default a logged-in user of the `admin.user` collection */
      scan?: JanitorAccess
      /** Start a purge. The user also needs `delete` access, without a query, on every collection with approved findings. @default a logged-in user of the `admin.user` collection */
      purge?: JanitorAccess
    }

export type JanitorPluginOptions = {
  /** `false` switches the plugin off but keeps the schema: both collections and the `janitor-run` task stay, the task does nothing, and no routes, panels, guards or admin UI are added. @default true */
  enabled?: boolean
  /** Collections to look after, by slug. Nothing is watched unless listed here. `true` means every check, panel and guard the collection can have; `false` skips the entry. */
  collections: Partial<Record<CollectionSlug, boolean | JanitorCollectionOptions>>
  /** Listing and deletion for every upload collection that does not name its own `storage`. */
  storage?: StorageAdapter
  /** Seconds. Objects and documents younger than this are never reported or deleted: an upload and its row are not written atomically. `0` or at least `3600`. @default 86400 */
  minAge?: number
  /** How runs start. `false` runs a scan or purge inside the request. An object queues them as Payload jobs, and its `schedule` adds a scan on a cron. Your own code can call `startJanitor` or `runJanitor`. @default false */
  jobs?: false | JobsOptions
  /** Who may read, approve, scan and purge. A purge also needs `delete` access on the collections it deletes from. @default a logged-in user of the `admin.user` collection, for every action */
  access?: JanitorAccessOptions
  /**
   * Findings per tenant, for sites built with `@payloadcms/plugin-multi-tenant`. A `missing` or `unused` finding takes
   * the tenant of its document. A user sees, approves and deletes only the findings of the tenants they may read.
   * Findings without a tenant, runs, scans and purges are only for users who may read every tenant: the tenants
   * collection's `read` access returns `true` for them. A tenant admin who may read every tenant sees every finding.
   * `true` uses the multi-tenant plugin's defaults.
   * @default false
   */
  tenants?: boolean | JanitorTenantsOptions
  references?: {
    /** Tables, Mongo collections or collection slugs whose references do not keep a document alive: audit logs, analytics. A slug covers every table of that collection. Payload's and the plugin's own bookkeeping is always ignored. @default [] */
    ignoreTables?: string[]
    /** Also match ids stored whole in plain `text`, `varchar` and `select` columns. Full scan of every such column; slower, never less safe. @default false */
    text?: boolean
    /** Whether a reference that exists only in an old version keeps a document. `'used'` keeps it; `'unused'` reports it, and the finding lists the versions. The latest draft always counts as live. @default 'used' */
    versions?: 'unused' | 'used'
  }
  /** Admin UI: the findings list menu, the field highlight provider, the nav group of the two collections and the «Cleanup» dashboard widget. `group: false` keeps the collections out of the nav, but their pages stay. `false` mounts nothing and hides both collections. @default { group: 'System', widget: true } */
  admin?: false | { group?: false | string; widget?: boolean }
  /** REST routes for scan, purge and the panel. `false` registers none and needs `admin: false`. @default { path: '/janitor' } */
  endpoints?: false | { path?: string }
  /** Changes to the two bookkeeping collections. `slug` renames one. @default { findings: { slug: 'janitor-findings' }, runs: { slug: 'janitor-runs' } } */
  overrides?: { findings?: CollectionOverride; runs?: CollectionOverride }
  /**
   * Anonymous usage telemetry: plugin, Payload and Node versions and the features in use. On by default.
   * It never sends secrets, IP addresses, keys, file names, URLs, paths, hostnames or collection names.
   * The first run logs a notice.
   *
   * Off when `payload.config.telemetry` is `false`, when `DO_NOT_TRACK` or `JANITOR_TELEMETRY_DISABLED`
   * is set, in CI or with `NODE_ENV=test`. Set `false` to turn it off. Pass `{ url }` to use your own collector.
   *
   * @see https://github.com/maximseshuk/payload-plugin-janitor#telemetry
   * @default true
   */
  telemetry?:
    | boolean
    | {
        /**
         * Collector URL that receives the telemetry report.
         * @default the plugin's public collector
         */
        url?: string
      }
}
