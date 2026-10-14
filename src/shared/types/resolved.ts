import type { Check, InsertPosition, JanitorAccess, JanitorPluginOptions, UsagePanelOptions } from './options.js'
import type { StorageAdapter } from './storage.js'

export type ResolvedCollection = {
  slug: string
  upload: boolean
  checks: Check[]
  usagePanel: false | { position: InsertPosition; limit: number; overrides?: UsagePanelOptions['overrides'] }
  blockDelete: boolean
  storage?: StorageAdapter
  prefix: string
  prefixFrom: 'config' | 'option'
  composite: boolean
  trash: boolean
}

export type ResolvedOptions = {
  collections: ResolvedCollection[]
  minAge: number
  jobs: false | { queue: string; schedule?: string }
  access: { approve: JanitorAccess; purge: JanitorAccess; read: JanitorAccess; scan: JanitorAccess }
  references: { ignoreTables: string[]; text: boolean; versions: 'unused' | 'used' }
  admin: false | { group: false | string; widget: boolean }
  endpoints: false | { path: string }
  findingsSlug: string
  runsSlug: string
  tenants: false | { collection: string; field: string }
  overrides: NonNullable<JanitorPluginOptions['overrides']>
}
