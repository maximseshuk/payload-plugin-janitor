import type { Config, Field, UIField } from 'payload'
import { describe, expect, it } from 'vitest'

import { janitor } from '@/index.js'
import type { JanitorPluginOptions } from '@/shared/types/options.js'

import { config } from '../../../helpers/options.js'

describe('usage field placement', () => {
  const plain = { slug: 'media', fields: [{ name: 'alt', type: 'text' }], upload: true }
  const build = (options: JanitorPluginOptions, collection: object = plain) => {
    const plugin = janitor(options)
    const result = plugin({ ...config, collections: [collection] } as unknown as Config)

    return (result as Config).collections!.find((item) => item.slug === 'media')!.fields
  }

  const names = (fields: Field[]) => fields.map((field) => ('name' in field ? field.name : field.type))

  it('adds the panel to the sidebar of a watched collection', () => {
    const tags = { slug: 'media', fields: [{ name: 'name', type: 'text' }] }
    const fields = build({ collections: { media: true } }, tags)

    expect(names(fields)).toEqual(['name', 'janitorUsage'])
    expect((fields.at(-1) as UIField).admin?.position).toBe('sidebar')
  })

  it('puts the panel first on an upload collection, whose sidebar Payload 4 shows below the fields', () => {
    const fields = build({ collections: { media: true } })

    expect(names(fields)).toEqual(['janitorUsage', 'alt'])
    expect((fields[0] as UIField).admin?.position).toBeUndefined()
    expect(names(build({ collections: { media: { usagePanel: { position: 'sidebar' } } } }))).toEqual([
      'alt',
      'janitorUsage',
    ])
  })

  it('puts the panel where the collection asked for it', () => {
    const fields = build({ collections: { media: { usagePanel: { position: { before: 'alt' } } } } })

    expect(names(fields)).toEqual(['janitorUsage', 'alt'])
    expect((fields[0] as UIField).admin?.position).toBeUndefined()
  })

  it('finds the anchor field inside a tab', () => {
    const tabbed = {
      slug: 'media',
      fields: [{ type: 'tabs', tabs: [{ label: 'Meta', fields: [{ name: 'alt', type: 'text' }] }] }],
      upload: true,
    }
    const fields = build({ collections: { media: { usagePanel: { position: { after: 'alt' } } } } }, tabbed)
    const tab = (fields[0] as { tabs: { fields: Field[] }[] }).tabs[0]!

    expect(names(tab.fields)).toEqual(['alt', 'janitorUsage'])
  })

  it('leaves the collection alone when the field is switched off', () => {
    expect(names(build({ collections: { media: { usagePanel: false } } }))).toEqual(['alt'])
  })

  it('keeps the panel on a collection that reports nothing', () => {
    expect(names(build({ collections: { media: { report: false } } }))).toEqual(['janitorUsage', 'alt'])
  })
})
