import type { CollectionConfig, Config, Field } from 'payload'
import { isFieldDisabled } from 'payload/shared'
import { describe, expect, it } from 'vitest'

import { janitor } from '@/index.js'
import type { JanitorPluginOptions } from '@/shared/types/options.js'

const PROVIDER = '@seshuk/payload-plugin-janitor/client#FieldHighlight'

const WIDGET = {
  slug: 'janitor',
  Component: '@seshuk/payload-plugin-janitor/rsc#JanitorWidget',
  maxWidth: 'full',
  minWidth: 'medium',
}

const flat = (fields: Field[] = []): Field[] =>
  fields.flatMap((field) => ('fields' in field && !('name' in field) ? flat(field.fields) : [field]))

const tags: CollectionConfig = { slug: 'tags', fields: [{ name: 'name', type: 'text' }], versions: false }

describe('factory', () => {
  const config = { collections: [tags] } as Config

  it('mounts the provider, the menu and the routes by default', () => {
    const result = janitor({ collections: { tags: { usagePanel: false } } })(config) as Config
    const findings = result.collections?.find((item) => item.slug === 'janitor-findings')

    expect(result.admin?.components?.providers).toContain(PROVIDER)
    expect(findings?.admin?.components?.listMenuItems).toHaveLength(1)
    expect(result.admin?.dashboard?.widgets).toEqual([expect.objectContaining(WIDGET)])
    expect(result.admin?.dashboard?.defaultLayout).toBeUndefined()
    expect(result.endpoints?.map((item) => item.path)).toEqual([
      '/janitor/scan',
      '/janitor/purge',
      '/janitor/usage/:collection/:id',
    ])
  })

  it('documents every route for OpenAPI with its path parameters', () => {
    const result = janitor({ collections: { tags: { usagePanel: false } }, endpoints: { path: '/cleanup' } })(
      config,
    ) as Config

    for (const endpoint of result.endpoints ?? []) {
      const openapi = endpoint.custom?.openapi as {
        parameters?: { in: string; name: string }[]
        responses: Record<string, unknown>
        summary: string
        tags: string[]
      }
      const inPath = [...endpoint.path.matchAll(/:(\w+)/g)].map((match) => match[1])

      expect(endpoint.path.startsWith('/cleanup/')).toBe(true)
      expect(openapi.summary).toEqual(expect.any(String))
      expect(openapi.tags).toEqual(['Janitor'])
      expect(Object.keys(openapi.responses)).toContain('403')
      expect(openapi.parameters?.filter((item) => item.in === 'path').map((item) => item.name) ?? []).toEqual(inPath)
    }

    expect(result.endpoints).toHaveLength(3)
  })

  it('adds the widget next to the widgets already there, labelled in every language', () => {
    const own = { slug: 'sales', Component: './Sales.js' }
    const result = janitor({ collections: { tags: { usagePanel: false } } })({
      ...config,
      admin: { dashboard: { widgets: [own] } },
    }) as Config
    const widget = result.admin?.dashboard?.widgets?.at(-1)

    expect(result.admin?.dashboard?.widgets?.[0]).toBe(own)
    expect(widget?.label).toMatchObject({ de: 'Bereinigung', en: 'Cleanup' })
  })

  it('leaves the widget out with admin.widget: false and with admin: false', () => {
    const off = janitor({ admin: { widget: false }, collections: { tags: { usagePanel: false } } })(config) as Config
    const headless = janitor({
      admin: false,
      collections: { tags: { usagePanel: false } },
      endpoints: false,
    })(config) as Config

    expect(off.admin?.components?.providers).toContain(PROVIDER)
    expect(off.admin?.dashboard).toBeUndefined()
    expect(headless.admin?.dashboard).toBeUndefined()
  })

  it('keeps both collections and a no-op task, and nothing else, with enabled: false', async () => {
    const result = janitor({
      collections: { nope: true },
      enabled: false,
      overrides: { findings: { slug: 'cleanup' } },
    })(config) as Config
    const task = result.jobs?.tasks?.find((item) => item.slug === 'janitor-run')
    const handler = task?.handler as () => Promise<unknown>

    expect(result.collections?.map((item) => item.slug)).toEqual(['tags', 'cleanup', 'janitor-runs'])
    expect(result.collections?.[0]).toBe(tags)
    expect(result.collections?.[1]?.admin?.hidden).toBe(true)
    expect(result.collections?.[2]?.admin?.hidden).toBe(true)
    expect(task?.schedule).toBeUndefined()
    await expect(handler()).resolves.toEqual({ output: {} })
    expect(result.endpoints).toBeUndefined()
    expect(result.admin).toBeUndefined()
    expect(result.custom).toBeUndefined()
    expect(result.onInit).toBeUndefined()
  })

  it('keeps the collection pages with admin.group: false and drops them only with admin: false', () => {
    const grouped = (admin: JanitorPluginOptions['admin']) =>
      (
        janitor({ admin, collections: { tags: { usagePanel: false } }, endpoints: admin ? undefined : false })(
          config,
        ) as Config
      ).collections
        ?.filter((item) => item.slug.startsWith('janitor-'))
        .map((item) => item.admin)

    expect(grouped({ group: false })).toEqual([
      expect.objectContaining({ group: false }),
      expect.objectContaining({ group: false }),
    ])
    expect(grouped({ group: false })?.some((admin) => admin?.hidden)).toBe(false)
    expect(grouped(false)).toEqual([
      expect.objectContaining({ hidden: true }),
      expect.objectContaining({ hidden: true }),
    ])
  })

  it('puts read on both collections and approve on changing and deleting their rows', async () => {
    const read = () => true
    const approve = () => false
    const result = janitor({ access: { approve, read }, collections: { tags: { usagePanel: false } } })(
      config,
    ) as Config
    const accessOf = (slug: string) => result.collections!.find((item) => item.slug === slug)!.access!
    const args = { req: {} } as never

    expect(await accessOf('janitor-findings').read!(args)).toBe(true)
    expect(await accessOf('janitor-findings').update!(args)).toBe(false)
    expect(await accessOf('janitor-findings').delete!(args)).toBe(false)
    expect(await accessOf('janitor-runs').read!(args)).toBe(true)
    expect(await accessOf('janitor-runs').delete!(args)).toBe(false)
  })

  it('puts the schedule on the task with the jobs queue', () => {
    const result = janitor({ collections: { tags: { usagePanel: false } }, jobs: { schedule: '0 3 * * *' } })(
      config,
    ) as Config

    expect(result.jobs?.tasks?.find((item) => item.slug === 'janitor-run')?.schedule).toEqual([
      { cron: '0 3 * * *', queue: 'default' },
    ])
    expect(Object.values(result.custom ?? {})).toMatchObject([{ jobs: { queue: 'default', schedule: '0 3 * * *' } }])
  })

  it('shapes the admin fields of both collections for reading', () => {
    const result = janitor({ collections: { tags: { usagePanel: false } } })(config) as Config
    const fieldsOf = (slug: string) => flat(result.collections?.find((item) => item.slug === slug)?.fields)
    const all = [...fieldsOf('janitor-findings'), ...fieldsOf('janitor-runs')]
    const named = (slug: string, name: string) =>
      fieldsOf(slug).find((field) => 'name' in field && field.name === name) as
        | undefined
        | { admin?: Record<string, unknown> & { components?: Record<string, unknown> } }

    for (const field of all.filter((item) => item.type === 'date')) {
      expect(field.admin).toMatchObject({ date: { displayFormat: 'PPpp' } })
    }
    for (const field of all.filter((item) => item.type === 'join')) {
      expect(field.admin).toMatchObject({ allowCreate: false })
    }
    for (const name of ['scanned', 'orphans', 'missing', 'unused', 'deleted']) {
      expect(named('janitor-runs', name)?.admin?.components?.Cell).toBe(
        '@seshuk/payload-plugin-janitor/client#CountCell',
      )
    }
    expect(named('janitor-runs', 'freedBytes')?.admin?.components?.Field).toBe(
      '@seshuk/payload-plugin-janitor/client#BytesField',
    )
    expect(named('janitor-findings', 'size')?.admin?.components?.Field).toBe(
      '@seshuk/payload-plugin-janitor/client#BytesField',
    )
    expect(named('janitor-findings', 'collectionSlug')?.admin?.components?.Field).toBe(
      '@seshuk/payload-plugin-janitor/client#CollectionField',
    )
    expect(named('janitor-findings', 'objectKey')?.admin?.condition).toBeUndefined()
  })

  it('keeps the hidden fields out of columns, filters and group by', () => {
    const result = janitor({ collections: { tags: { usagePanel: false } } })(config) as Config
    const fieldOf = (slug: string, name: string) =>
      flat(result.collections?.find((item) => item.slug === slug)?.fields).find(
        (field) => 'name' in field && field.name === name,
      ) as { admin?: Record<string, unknown> }

    for (const field of [fieldOf('janitor-findings', 'ref'), fieldOf('janitor-runs', 'title')]) {
      expect(field.admin?.hidden).toBe(true)
      for (const area of ['column', 'filter', 'groupBy'] as const) expect(isFieldDisabled(field, area)).toBe(true)
      expect(isFieldDisabled(field, 'field')).toBe(false)
    }
  })

  it('merges overrides into both collections and builds fields from the defaults', () => {
    const result = janitor({
      collections: { tags: { usagePanel: false } },
      overrides: {
        findings: {
          slug: 'cleanup',
          access: { read: () => true },
          admin: { defaultColumns: ['objectKey'] },
          fields: ({ defaultFields }) => [...defaultFields, { name: 'ticket', type: 'text' }],
        },
        runs: { labels: { plural: 'Sweeps' }, timestamps: true },
      },
    })(config) as Config
    const findings = result.collections?.find((item) => item.slug === 'cleanup')
    const runs = result.collections?.find((item) => item.slug === 'janitor-runs')
    const run = runs?.fields.find((field) => 'name' in field && field.name === 'findings')

    expect(findings?.access?.create?.({} as never)).toBe(false)
    expect(findings?.access?.read?.({} as never)).toBe(true)
    expect(findings?.admin).toMatchObject({ defaultColumns: ['objectKey'], group: 'System', useAsTitle: 'objectKey' })
    expect(findings?.fields.at(-1)).toEqual({ name: 'ticket', type: 'text' })
    expect(flat(findings?.fields).some((field) => 'name' in field && field.name === 'objectKey')).toBe(true)
    expect(runs?.labels).toMatchObject({ plural: 'Sweeps' })
    expect(runs?.labels?.singular).toBeDefined()
    expect(runs?.timestamps).toBe(true)
    expect(run).toMatchObject({ collection: 'cleanup' })
    expect(result.endpoints).toHaveLength(3)
  })

  it('adds override hooks after the plugin hooks', () => {
    const afterChange = () => undefined
    const beforeRead = () => undefined
    const result = janitor({
      collections: { tags: { usagePanel: false } },
      overrides: { runs: { hooks: { afterChange: [afterChange], beforeRead: [beforeRead] } } },
    })(config) as Config
    const runs = result.collections?.find((item) => item.slug === 'janitor-runs')

    expect(runs?.hooks?.afterChange).toHaveLength(2)
    expect(runs?.hooks?.afterChange?.at(-1)).toBe(afterChange)
    expect(runs?.hooks?.beforeRead).toEqual([beforeRead])
  })
})
