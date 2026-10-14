import { describe, expect, it, vi } from 'vitest'

import { buildFindingsCollection } from '@/server/collections/findings.js'
import { resolveOptions } from '@/server/options/resolveOptions.js'

import { config, fieldOf } from '../../../helpers/collections.js'

describe('collection configs', () => {
  it('labels findings for every collection kind, not only storage', () => {
    const findings = buildFindingsCollection(resolveOptions({ collections: { media: true } }, config))

    expect(findings.labels).toMatchObject({
      plural: { en: 'Janitor findings', ru: 'Находки чистки' },
      singular: { en: 'Janitor finding', ru: 'Находка чистки' },
    })
    expect(findings.admin?.defaultColumns).toContain('collectionSlug')
  })

  it('keeps findings unique per collection and key', () => {
    const findings = buildFindingsCollection(resolveOptions({ collections: { media: true } }, config))

    expect(findings.indexes).toEqual([{ fields: ['collectionSlug', 'objectKey'], unique: true }])
    expect(fieldOf(findings, 'collectionSlug')).toMatchObject({ index: true, required: true })
    expect(fieldOf(findings, 'objectKey')).toMatchObject({ index: true, required: true })
    expect(fieldOf(findings, 'objectKey').unique).toBeUndefined()
  })

  it('mounts the menu only with the admin UI, and hands it the base path', () => {
    const withAdmin = buildFindingsCollection(
      resolveOptions({ collections: { media: true }, endpoints: { path: '/tidy/' } }, config),
    )
    const headless = buildFindingsCollection(resolveOptions({ admin: false, collections: { media: true } }, config))

    expect(withAdmin.admin?.components?.listMenuItems).toEqual([
      {
        clientProps: { endpointsPath: '/tidy', findingsSlug: 'janitor-findings', runsSlug: 'janitor-runs' },
        path: '@seshuk/payload-plugin-janitor/client#JanitorMenu',
      },
    ])
    expect(headless.admin?.components?.listMenuItems).toBeUndefined()
    expect(headless.admin?.hidden).toBe(true)
  })

  it('shows a finding by its document and its key on every finding, as the Key column does', () => {
    const findings = buildFindingsCollection(resolveOptions({ collections: { media: true, tags: true } }, config))
    const condition = (name: string) =>
      (fieldOf(findings, name).admin as { condition: (data: Record<string, unknown>) => boolean }).condition
    const components = (name: string) => (fieldOf(findings, name).admin as { components: unknown }).components

    expect(findings.admin?.defaultColumns?.slice(0, 2)).toEqual(['objectKey', 'documentId'])
    expect(components('documentId')).toEqual({
      Cell: '@seshuk/payload-plugin-janitor/client#FindingTargetCell',
      Field: '@seshuk/payload-plugin-janitor/client#FindingTargetField',
    })
    expect(components('size')).toMatchObject({ Cell: '@seshuk/payload-plugin-janitor/client#BytesCell' })
    expect(fieldOf(findings, 'objectKey').admin).not.toHaveProperty('condition')
    expect(condition('usage')({ documentId: '1' })).toBe(true)
    expect(condition('usage')({ kind: 'orphan' })).toBe(false)
  })

  it('adds the tenant field and column only with tenants', () => {
    const plain = buildFindingsCollection(resolveOptions({ collections: { media: true } }, config))
    const scoped = buildFindingsCollection(
      resolveOptions({ collections: { media: true }, tenants: { field: 'site' } }, config),
    )

    expect(fieldOf(plain, 'tenant')).toBeUndefined()
    expect(plain.admin?.defaultColumns).not.toContain('tenant')
    expect(fieldOf(scoped, 'tenant')).toMatchObject({
      admin: { readOnly: true },
      hasMany: true,
      index: true,
      relationTo: 'tenants',
      type: 'relationship',
    })
    expect(scoped.admin?.defaultColumns).toContain('tenant')
  })

  it('limits findings to the tenants the user may read, and passes users who see every tenant', async () => {
    const as = (allowed: boolean, tenants: unknown, everyTenant: unknown, readable: { id: number }[] = []) => {
      const find = vi.fn(async () => ({ docs: readable }))
      const access = buildFindingsCollection(
        resolveOptions({ access: () => allowed, collections: { media: true }, tenants: tenants as never }, config),
      ).access!
      const req = {
        payload: { collections: { tenants: { config: { access: { read: () => everyTenant } } } }, find },
        user: { id: 7 },
      }

      return { find, read: () => access.read!({ req } as never), update: () => access.update!({ req } as never) }
    }
    const scoped = { id: { in: [1] } }

    expect(await as(true, false, false).read()).toBe(true)
    expect(await as(true, true, true).read()).toBe(true)
    expect(await as(false, true, true).read()).toBe(false)
    expect(await as(true, true, scoped, [{ id: 1 }, { id: 2 }]).update()).toEqual({ tenant: { in: [1, 2] } })
    expect(await as(true, true, scoped).read()).toBe(false)

    const { find, read } = as(true, true, scoped, [{ id: 3 }])

    await read()

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'tenants', overrideAccess: false, user: { id: 7 } }),
    )
  })

  it('passes the access result through without tenants, and adds the tenant scope to a query with tenants', async () => {
    const own = { owner: { equals: 7 } }
    const readOf = (tenants: boolean, everyTenant: unknown) => {
      const options = resolveOptions({ access: (() => own) as never, collections: { media: true }, tenants }, config)
      const read = buildFindingsCollection(options).access!.read!
      const req = {
        payload: {
          collections: { tenants: { config: { access: { read: () => everyTenant } } } },
          find: async () => ({ docs: [{ id: 1 }] }),
        },
        user: { id: 7 },
      }

      return { options, read, result: () => read({ req } as never) }
    }
    const plain = readOf(false, true)

    expect(plain.read).toBe(plain.options.access.read)
    expect(await plain.result()).toBe(own)
    expect(await readOf(true, true).result()).toBe(own)
    expect(await readOf(true, { id: { in: [1] } }).result()).toEqual({ and: [own, { tenant: { in: [1] } }] })
  })
})
