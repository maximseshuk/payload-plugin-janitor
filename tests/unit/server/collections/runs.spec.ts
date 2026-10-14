import { describe, expect, it } from 'vitest'

import { buildRunsCollection } from '@/server/collections/runs.js'
import { resolveOptions } from '@/server/options/resolveOptions.js'

import { config, fieldOf } from '../../../helpers/collections.js'

describe('collection configs', () => {
  it('titles runs by a top-level text and joins the findings they saw', () => {
    const runs = buildRunsCollection(resolveOptions({ collections: { media: true } }, config))
    const top = runs.fields.find((field) => 'name' in field && field.name === runs.admin?.useAsTitle)

    expect(top).toMatchObject({ name: 'title', type: 'text' })
    expect(fieldOf(runs, 'findings')).toMatchObject({ collection: 'janitor-findings', on: 'run', type: 'join' })
  })

  it('shows and deletes runs only for users who see every tenant with tenants', async () => {
    const access = buildRunsCollection(
      resolveOptions({ access: () => true, collections: { media: true }, tenants: true }, config),
    ).access!
    const as = (everyTenant: unknown) =>
      ({ req: { payload: { collections: { tenants: { config: { access: { read: () => everyTenant } } } } } } }) as never

    expect(await access.read!(as(true))).toBe(true)
    expect(await access.read!(as({ id: { in: [1] } }))).toBe(false)
    expect(await access.delete!(as(true))).toEqual({ status: { not_equals: 'running' } })
    expect(await access.delete!(as({ id: { in: [1] } }))).toBe(false)
  })
})
