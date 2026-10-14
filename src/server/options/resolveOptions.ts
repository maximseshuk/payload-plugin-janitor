import { insertField } from '@seshuk/payload-plugin-tooling/fields'
import type { CollectionConfig, Config, Field } from 'payload'

import { usageField } from '@/server/collections/usageField.js'
import {
  DEFAULT_ENDPOINTS_PATH,
  DEFAULT_FINDINGS_SLUG,
  DEFAULT_MIN_AGE,
  DEFAULT_RUNS_SLUG,
} from '@/shared/constants.js'
import type { Check, JanitorAccess, JanitorCollectionOptions, JanitorPluginOptions } from '@/shared/types/options.js'
import type { ResolvedCollection, ResolvedOptions } from '@/shared/types/resolved.js'
import type { StorageAdapter } from '@/shared/types/storage.js'

const IGNORED_TABLES = [
  'payload_locked_documents',
  'payload_locked_documents_rels',
  'payload_migrations',
  'payload_kv',
  'payload_preferences',
  'payload-locked-documents',
  'payload-migrations',
  'payload-kvs',
  'payload-preferences',
  'payload_jobs',
  'payload_jobs_log',
  'payload-jobs',
]

const CHECKS: Check[] = ['orphans', 'missing', 'unused']

const isControl = (char: string): boolean => char < ' ' || (char >= '\u0080' && char <= '\u009f')

export const cleanPrefix = (value: string): string => {
  let decoded: string

  try {
    decoded = decodeURIComponent(value)
  } catch {
    return ''
  }

  if (/%[0-9a-f]{2}/i.test(decoded)) return ''

  return [...decoded]
    .filter((char) => !isControl(char))
    .join('')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/')
}

export const isRewritten = (value: null | string | undefined): boolean => {
  if (!value) return false

  return (
    [...value].some((char) => isControl(char) || char === '%' || char === '\\') ||
    value.startsWith('/') ||
    value.split('/').some((segment) => segment === '.' || segment === '..')
  )
}

const tableOf = (slug: string): string =>
  slug
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()

export const storedPrefix = (collection: Pick<CollectionConfig, 'fields'>): string | undefined => {
  const field = (collection.fields as { defaultValue?: unknown; name?: string }[]).find(
    (item) => item.name === 'prefix',
  )

  if (!field) return undefined

  return typeof field.defaultValue === 'string' ? cleanPrefix(field.defaultValue) : ''
}

export const ambiguous = (slug: string): Error =>
  new Error(
    `janitor: "${slug}" has a \`prefix\` field with an empty default, so its keys are unknown: the storage plugin may run with \`useCompositePrefixes\`; pass \`prefix\` on the collection, and \`compositePrefixes: true\` if it does`,
  )

export const notComposite = (slug: string, prefix: string): Error =>
  new Error(
    `janitor: "${slug}" is given \`prefix: "${prefix}"\`, but its \`prefix\` field has an empty default, which is how a storage plugin with \`useCompositePrefixes\` marks it; add \`compositePrefixes: true\` if it runs with composite prefixes, or pass \`prefix: ""\` if it has no prefix`,
  )

export const notCompositeStorage = (slug: string, stored: string): Error =>
  new Error(
    `janitor: "${slug}" has \`compositePrefixes\`, but its \`prefix\` field defaults to "${stored}", so its storage plugin does not run with \`useCompositePrefixes\`; drop \`compositePrefixes\``,
  )

export const needsStorage = (checks: Check[]): boolean => checks.includes('orphans') || checks.includes('missing')

const checksOf = (
  slug: string,
  report: JanitorCollectionOptions['report'],
  upload: boolean,
  storage: StorageAdapter | undefined,
): Check[] => {
  if (report === false) return []
  if (report === true || report === undefined) return upload && storage ? [...CHECKS] : ['unused']

  const seen = new Set<Check>()

  for (const check of report) {
    if (!CHECKS.includes(check)) {
      throw new Error(`janitor: "${slug}" has an unknown check "${check}"; use missing, orphans, unused`)
    }

    if (seen.has(check)) {
      throw new Error(`janitor: "${slug}" has a duplicate check "${check}"; use missing, orphans, unused`)
    }

    seen.add(check)
  }

  const listsStorage = needsStorage(report)

  if (listsStorage && !upload) {
    throw new Error(`janitor: "${slug}" is not an upload collection; only \`unused\` can be reported for it`)
  }

  if (listsStorage && !storage) {
    throw new Error(
      `janitor: "${slug}" reports orphans and missing objects but has no storage; pass \`storage\` on the collection or globally`,
    )
  }

  return [...report]
}

const usagePanelOf = (
  slug: string,
  value: JanitorCollectionOptions['usagePanel'],
  fields: Field[],
  endpoints: ResolvedOptions['endpoints'],
): ResolvedCollection['usagePanel'] => {
  if (value === false || (value === undefined && !endpoints)) return false

  if (!endpoints) {
    throw new Error(
      `janitor: "${slug}" has a usage panel, which needs the REST endpoints; set \`usagePanel: false\` or keep \`endpoints\``,
    )
  }

  const options = value === true || value === undefined ? {} : value
  const position = options.position ?? 'sidebar'
  try {
    insertField(fields, position, usageField())
  } catch (error) {
    throw new Error(`janitor: "${slug}" cannot place the usage panel: ${(error as Error).message}`, {
      cause: error,
    })
  }

  return { limit: options.limit ?? 0, overrides: options.overrides, position }
}

const resolveCollection = (
  slug: string,
  value: true | JanitorCollectionOptions,
  options: JanitorPluginOptions,
  config: Config,
  reserved: string[],
  endpoints: ResolvedOptions['endpoints'],
): ResolvedCollection => {
  if (reserved.includes(slug)) {
    throw new Error(`janitor: "${slug}" is the plugin's own collection and cannot be watched`)
  }

  const collection = config.collections?.find((item) => item.slug === slug)

  if (!collection) throw new Error(`janitor: collection "${slug}" does not exist`)

  const settings = value === true ? {} : value
  const upload = Boolean(collection.upload)

  if (!upload && (settings.storage || settings.prefix !== undefined || settings.compositePrefixes !== undefined)) {
    throw new Error(
      `janitor: "${slug}" is not an upload collection; \`storage\`, \`prefix\` and \`compositePrefixes\` do not apply`,
    )
  }

  const composite = settings.compositePrefixes ?? false

  if (composite && settings.prefix === undefined) {
    throw new Error(
      `janitor: "${slug}" has \`compositePrefixes\` but no \`prefix\`; pass the prefix its storage plugin was given, "" for none`,
    )
  }

  const storage = upload ? (settings.storage ?? options.storage) : undefined
  const checks = checksOf(slug, settings.report, upload, storage)
  const stored = upload ? storedPrefix(collection) : undefined

  if (settings.prefix === undefined && stored === '' && needsStorage(checks)) throw ambiguous(slug)

  const prefix = upload ? cleanPrefix(settings.prefix ?? stored ?? '') : ''

  if (settings.prefix !== undefined && stored === '' && !composite && prefix) throw notComposite(slug, prefix)

  if (composite && stored) throw notCompositeStorage(slug, stored)

  if (checks.includes('unused') && collection.timestamps === false) {
    throw new Error(
      `janitor: "${slug}" has \`timestamps: false\`, so an unused document can be neither aged nor re-checked before purge; drop \`unused\` from \`report\` (\`report: false\` for an ordinary collection) or turn timestamps on`,
    )
  }

  const usagePanel = usagePanelOf(slug, settings.usagePanel, collection.fields, endpoints)
  const blockDelete = settings.blockDelete ?? true

  if (!checks.length && !usagePanel && !blockDelete) {
    throw new Error(`janitor: "${slug}" has nothing switched on; remove it or drop it from \`collections\``)
  }

  return {
    blockDelete,
    checks,
    composite,
    prefix,
    prefixFrom: settings.prefix === undefined ? 'config' : 'option',
    slug,
    storage,
    trash: Boolean(collection.trash),
    upload,
    usagePanel,
  }
}

const overlaps = (a: string, b: string): boolean =>
  a !== b && (!a || !b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))

const checkScopes = (collections: ResolvedCollection[]): void => {
  for (const [index, a] of collections.entries()) {
    for (const b of collections.slice(index + 1)) {
      if (
        a.storage &&
        a.storage === b.storage &&
        !a.storage.perCollection &&
        needsStorage(a.checks) &&
        needsStorage(b.checks) &&
        overlaps(a.prefix, b.prefix)
      ) {
        throw new Error(
          `janitor: "${a.slug}" and "${b.slug}" share storage with nested prefixes "${a.prefix}" and "${b.prefix}"; give them the same prefix or separate ones`,
        )
      }
    }
  }
}

const jobsOf = (jobs: JanitorPluginOptions['jobs']): ResolvedOptions['jobs'] => {
  if (jobs === undefined || jobs === false) return false

  if (typeof jobs !== 'object' || jobs === null || Array.isArray(jobs))
    throw new Error('janitor: `jobs` must be `false` or an object')

  if (jobs.queue !== undefined && (typeof jobs.queue !== 'string' || !jobs.queue.trim())) {
    throw new Error('janitor: `jobs.queue` must name a queue')
  }

  if (jobs.schedule !== undefined && (typeof jobs.schedule !== 'string' || !jobs.schedule.trim())) {
    throw new Error('janitor: `jobs.schedule` must be a cron expression')
  }

  return { queue: jobs.queue ?? 'default', ...(jobs.schedule ? { schedule: jobs.schedule } : {}) }
}

const tenantsOf = (
  tenants: JanitorPluginOptions['tenants'],
  reserved: string[],
  config: Config,
): ResolvedOptions['tenants'] => {
  if (tenants === undefined || tenants === false) return false

  if (tenants !== true && (typeof tenants !== 'object' || tenants === null || Array.isArray(tenants))) {
    throw new Error('janitor: `tenants` must be `true`, `false` or an object')
  }

  const { collection = 'tenants', field = 'tenant' } = tenants === true ? {} : tenants

  if (typeof collection !== 'string' || !collection.trim()) {
    throw new Error('janitor: `tenants.collection` must name a collection')
  }

  if (typeof field !== 'string' || !field.trim()) throw new Error('janitor: `tenants.field` must name a field')

  if (reserved.includes(collection)) {
    throw new Error(`janitor: \`tenants.collection\` "${collection}" is the plugin's own collection`)
  }

  if (!config.collections?.some((item) => item.slug === collection)) {
    throw new Error(
      `janitor: \`tenants.collection\` "${collection}" is not a collection in the config; name the tenants collection of @payloadcms/plugin-multi-tenant, or list janitor after the plugin that adds it`,
    )
  }

  return { collection, field }
}

const endpointsOf = (endpoints: JanitorPluginOptions['endpoints']): ResolvedOptions['endpoints'] => {
  if (endpoints === false) return false

  const path = endpoints?.path ?? DEFAULT_ENDPOINTS_PATH

  if (!path.startsWith('/') || /\s/.test(path)) {
    throw new Error('janitor: `endpoints.path` must start with "/"')
  }

  const trimmed = path.replace(/\/+$/, '')

  if (!trimmed) throw new Error('janitor: `endpoints.path` must name a path under /api, such as "/janitor"')

  return { path: trimmed }
}

const defaultAccess =
  (config: Config): JanitorAccess =>
  ({ req }) => {
    const users = req.payload.config.admin?.user ?? config.admin?.user

    return Boolean(req.user) && (!users || req.user?.collection === users)
  }

const accessOf = (access: JanitorPluginOptions['access'], fallback: JanitorAccess): ResolvedOptions['access'] => {
  if (typeof access === 'function') return { approve: access, purge: access, read: access, scan: access }

  return {
    approve: access?.approve ?? fallback,
    purge: access?.purge ?? fallback,
    read: access?.read ?? fallback,
    scan: access?.scan ?? fallback,
  }
}

export const resolveOptions = (options: JanitorPluginOptions, config: Config): ResolvedOptions => {
  const findingsSlug = options.overrides?.findings?.slug ?? DEFAULT_FINDINGS_SLUG
  const runsSlug = options.overrides?.runs?.slug ?? DEFAULT_RUNS_SLUG
  const access = accessOf(options.access, defaultAccess(config))
  const overrides = options.overrides ?? {}
  const tenants = tenantsOf(options.tenants, [findingsSlug, runsSlug], config)

  if (options.enabled === false) {
    return {
      access,
      admin: false,
      collections: [],
      endpoints: false,
      findingsSlug,
      jobs: false,
      minAge: DEFAULT_MIN_AGE,
      overrides,
      references: { ignoreTables: [], text: false, versions: 'used' },
      runsSlug,
      tenants,
    }
  }

  const endpoints = endpointsOf(options.endpoints)

  const collections = Object.entries(options.collections ?? {}).flatMap(([slug, value]) =>
    value === false || value === undefined
      ? []
      : [resolveCollection(slug, value, options, config, [findingsSlug, runsSlug], endpoints)],
  )

  if (!collections.length) {
    throw new Error(
      'janitor: no collection listed; list at least one under `collections` or set `enabled: false` to switch the plugin off',
    )
  }

  checkScopes(collections)

  if (options.storage && !collections.some((collection) => collection.upload)) {
    throw new Error('janitor: `storage` is set but no listed collection is an upload collection')
  }

  const admin =
    options.admin === false ? false : { group: options.admin?.group ?? 'System', widget: options.admin?.widget ?? true }

  if (admin && !endpoints) {
    throw new Error('janitor: the admin UI needs the REST endpoints; set `admin: false` too or keep `endpoints`')
  }

  const jobs = jobsOf(options.jobs)
  const minAge = options.minAge ?? DEFAULT_MIN_AGE

  if (typeof minAge !== 'number' || !Number.isFinite(minAge) || minAge < 0) {
    throw new Error('janitor: `minAge` must be a number of seconds, 0 or more')
  }

  if (minAge > 0 && minAge < 3600) {
    throw new Error(`janitor: \`minAge\` is in seconds and must be 0 or at least 3600; ${minAge} looks like hours`)
  }

  const versions = options.references?.versions ?? 'used'

  if (versions !== 'used' && versions !== 'unused') {
    throw new Error('janitor: `references.versions` must be "used" or "unused"')
  }

  return {
    access,
    admin,
    collections,
    endpoints,
    findingsSlug,
    jobs,
    minAge,
    overrides,
    references: {
      ignoreTables: [
        ...IGNORED_TABLES,
        ...(options.references?.ignoreTables ?? []),
        ...[findingsSlug, runsSlug].flatMap((slug) => [slug, tableOf(slug), `${tableOf(slug)}_rels`]),
      ],
      text: options.references?.text ?? false,
      versions,
    },
    runsSlug,
    tenants,
  }
}
