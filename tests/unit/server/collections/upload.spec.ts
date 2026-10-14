import type { CollectionConfig } from 'payload'
import { describe, expect, it } from 'vitest'

import { withJanitor } from '@/server/collections/upload.js'
import { resolveOptions } from '@/server/options/resolveOptions.js'

import { config, media } from '../../../helpers/collections.js'

describe('collection configs', () => {
  it('mounts the usage panel only when the endpoints exist', () => {
    const resolved = resolveOptions({ collections: { media: { usagePanel: { limit: 4 } } } }, config)
    const names = (collection: CollectionConfig) =>
      collection.fields.map((field) => ('name' in field ? field.name : field.type))
    const mounted = withJanitor(media, resolved)
    const panel = mounted.fields.at(-1) as { admin: { components: { Field: { clientProps: unknown } } } }

    expect(names(mounted)).toEqual(['alt', 'janitorUsage'])
    expect(panel.admin.components.Field.clientProps).toEqual({ endpointsPath: '/janitor', limit: 4 })
    expect(names(withJanitor(media, { ...resolved, endpoints: false }))).toEqual(['alt'])
  })

  it('labels the usage panel without a label function', () => {
    const resolved = resolveOptions({ collections: { media: true } }, config)
    const panel = withJanitor(media, resolved).fields.at(-1) as { label: unknown }

    expect(panel.label).toMatchObject({ en: 'Usage', ru: 'Использование' })
  })
})
