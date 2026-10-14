import {
  type Access,
  type AccessResult,
  type CollectionConfig,
  type Field,
  type FieldHook,
  ValidationError,
} from 'payload'

import { tenantScope } from '@/server/tenants.js'
import { PLUGIN_NAME } from '@/shared/constants.js'
import { label, title } from '@/shared/translations/index.js'
import type { CollectionOverride, JanitorAccess } from '@/shared/types/options.js'
import type { ResolvedOptions } from '@/shared/types/resolved.js'

const fact = { update: () => false }

const purgeOnly: FieldHook = ({ context, previousValue, req, value }) => {
  if (context[PLUGIN_NAME] === true || value === previousValue || (value !== 'deleted' && previousValue !== 'deleted'))
    return value

  throw new ValidationError({
    errors: [{ message: req.t(`${PLUGIN_NAME}:deletedByPlugin` as never), path: 'status' }],
  })
}

export const CLIENT = '@seshuk/payload-plugin-janitor/client'

export const RSC = '@seshuk/payload-plugin-janitor/rsc'

export const DATE = { date: { displayFormat: 'PPpp' } }

export const HIDDEN = { disableGroupBy: true, disableListColumn: true, disableListFilter: true, hidden: true }

export const adminOf = (options: ResolvedOptions): CollectionConfig['admin'] =>
  options.admin ? { group: options.admin.group } : { hidden: true }

export const withOverride = (collection: CollectionConfig, override: CollectionOverride = {}): CollectionConfig => {
  const { fields, ...rest } = override
  const hooks: Record<string, unknown[] | undefined> = { ...collection.hooks }

  for (const [name, added] of Object.entries(rest.hooks ?? {})) hooks[name] = [...(hooks[name] ?? []), ...(added ?? [])]

  return {
    ...collection,
    ...rest,
    access: { ...collection.access, ...rest.access },
    admin: { ...collection.admin, ...rest.admin },
    fields: fields ? fields({ defaultFields: collection.fields }) : collection.fields,
    hooks: hooks as CollectionConfig['hooks'],
    labels: { ...collection.labels, ...rest.labels },
  }
}

const scoped = (access: JanitorAccess, options: ResolvedOptions): Access => {
  if (!options.tenants) return access

  return async (args) => {
    const allowed: AccessResult = await access(args)

    if (!allowed) return false

    const scope = await tenantScope(args.req, options)

    if (allowed === true || scope === false) return scope

    return scope === true ? allowed : { and: [allowed, scope] }
  }
}

const tenantFields = (options: ResolvedOptions): Field[] =>
  options.tenants
    ? [
        {
          name: 'tenant',
          access: fact,
          type: 'relationship',
          admin: { readOnly: true },
          hasMany: true,
          index: true,
          label: title('tenant'),
          relationTo: options.tenants.collection,
        },
      ]
    : []

export const buildFindingsCollection = (options: ResolvedOptions): CollectionConfig => {
  const collection: CollectionConfig = {
    slug: options.findingsSlug,
    access: {
      create: () => false,
      delete: scoped(options.access.approve, options),
      read: scoped(options.access.read, options),
      update: scoped(options.access.approve, options),
    },
    admin: {
      ...(options.admin && options.endpoints
        ? {
            components: {
              listMenuItems: [
                {
                  clientProps: {
                    endpointsPath: options.endpoints.path,
                    findingsSlug: options.findingsSlug,
                    runsSlug: options.runsSlug,
                  },
                  path: `${CLIENT}#JanitorMenu`,
                },
              ],
            },
          }
        : {}),
      defaultColumns: [
        'objectKey',
        'documentId',
        'collectionSlug',
        ...(options.tenants ? ['tenant'] : []),
        'kind',
        'status',
        'size',
        'uploadedAt',
      ],
      ...adminOf(options),
      listSearchableFields: ['objectKey'],
      useAsTitle: 'objectKey',
    },
    disableDuplicate: true,
    versions: false,
    indexes: [{ fields: ['collectionSlug', 'objectKey'], unique: true }],
    fields: [
      {
        name: 'summary',
        type: 'ui',
        admin: { components: { Field: `${CLIENT}#FindingSummary` }, disableListColumn: true },
      },
      {
        name: 'status',
        type: 'radio',
        admin: {
          components: { Description: `${CLIENT}#StatusDescription`, Field: `${CLIENT}#StatusField` },
          position: 'sidebar',
        },
        defaultValue: 'found',
        hooks: { beforeChange: [purgeOnly] },
        index: true,
        label: title('status'),
        options: [
          { label: title('undecided'), value: 'found' },
          { label: title('keep'), value: 'keep' },
          { label: title('toDelete'), value: 'delete' },
          { label: title('deleted'), value: 'deleted' },
        ],
        required: true,
      },
      { name: 'note', type: 'textarea', admin: { position: 'sidebar' }, label: title('note') },
      {
        name: 'error',
        access: fact,
        type: 'textarea',
        admin: { condition: (data) => Boolean(data.error), position: 'sidebar', readOnly: true },
        label: title('errorText'),
      },
      {
        name: 'usage',
        access: fact,
        type: 'json',
        admin: {
          components: {
            Field: {
              clientProps: { endpointsPath: options.endpoints ? options.endpoints.path : undefined },
              path: `${CLIENT}#FindingUsage`,
            },
          },
          condition: (data) => Boolean(data.documentId),
          readOnly: true,
        },
        label: title('label'),
      },
      {
        type: 'collapsible',
        admin: { initCollapsed: true },
        label: title('details'),
        fields: [
          {
            name: 'objectKey',
            access: fact,
            type: 'text',
            admin: { description: label('keyHint'), readOnly: true },
            index: true,
            label: title('key'),
            required: true,
          },
          {
            name: 'ref',
            access: fact,
            type: 'text',
            admin: HIDDEN,
          },
          {
            name: 'kind',
            access: fact,
            type: 'select',
            admin: { readOnly: true },
            index: true,
            label: title('finding'),
            options: [
              { label: title('orphanedFile'), value: 'orphan' },
              { label: title('brokenUpload'), value: 'missing' },
              { label: title('unreferencedDocument'), value: 'unused' },
            ],
            required: true,
          },
          {
            type: 'row',
            fields: [
              {
                name: 'collectionSlug',
                access: fact,
                type: 'text',
                admin: {
                  components: { Cell: `${CLIENT}#CollectionCell`, Field: `${CLIENT}#CollectionField` },
                  readOnly: true,
                  width: '50%',
                },
                index: true,
                label: title('collection'),
                required: true,
              },
              {
                name: 'documentId',
                access: fact,
                type: 'text',
                admin: {
                  components: { Cell: `${CLIENT}#FindingTargetCell`, Field: `${CLIENT}#FindingTargetField` },
                  readOnly: true,
                  width: '50%',
                },
                label: title('document'),
              },
            ],
          },
          ...tenantFields(options),
          {
            type: 'row',
            fields: [
              {
                name: 'size',
                access: fact,
                type: 'number',
                admin: {
                  components: { Cell: `${CLIENT}#BytesCell`, Field: `${CLIENT}#BytesField` },
                  condition: (data) => typeof data.size === 'number',
                  readOnly: true,
                  width: '33%',
                },
                label: title('size'),
              },
              {
                name: 'uploadedAt',
                access: fact,
                type: 'date',
                admin: { ...DATE, readOnly: true, width: '33%' },
                label: title('createdAt'),
              },
              {
                name: 'lastSeenAt',
                access: fact,
                type: 'date',
                admin: { ...DATE, readOnly: true, width: '34%' },
                label: title('lastSeenAt'),
              },
            ],
          },
          {
            name: 'run',
            access: fact,
            type: 'relationship',
            admin: { readOnly: true },
            index: true,
            label: title('foundBy'),
            relationTo: options.runsSlug,
          },
          {
            name: 'purgedBy',
            access: fact,
            type: 'relationship',
            admin: { condition: (data) => Boolean(data.purgedBy), readOnly: true },
            index: true,
            label: title('purgedBy'),
            relationTo: options.runsSlug,
          },
          {
            name: 'onlyVersions',
            access: fact,
            type: 'checkbox',
            admin: { condition: (data) => data.kind === 'unused', readOnly: true },
            hooks: {
              afterRead: [
                ({ siblingData }) =>
                  Array.isArray(siblingData?.usage) &&
                  siblingData.usage.length > 0 &&
                  siblingData.usage.every((ref: { versions?: boolean }) => ref.versions === true),
              ],
            },
            label: title('onlyInOldVersions'),
            virtual: true,
          },
          {
            name: 'purgedAt',
            access: fact,
            type: 'date',
            admin: { ...DATE, condition: (data) => data.status === 'deleted', readOnly: true },
            label: title('deletedAt'),
          },
        ],
      },
    ],
    labels: {
      plural: label('janitorFindings'),
      singular: label('janitorFinding'),
    },
  }

  return withOverride(collection, options.overrides.findings)
}
