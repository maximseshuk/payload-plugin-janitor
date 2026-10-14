import type { CollectionAfterChangeHook, CollectionConfig, NumberField } from 'payload'

import { seesAllTenants } from '@/server/tenants.js'
import { label, title } from '@/shared/translations/index.js'
import type { ResolvedOptions } from '@/shared/types/resolved.js'

import { adminOf, CLIENT, DATE, HIDDEN, RSC, withOverride } from './findings.js'

type Mode = 'purge' | 'scan'

const shownIn = (mode: Mode) => ({
  condition: (data: Record<string, unknown>) => data.mode === mode,
  width: mode === 'scan' ? '20%' : '25%',
})

const count = (
  name: 'deleted' | 'failed' | 'missing' | 'orphans' | 'scanned' | 'skipped' | 'unused',
  mode: Mode,
): NumberField => ({
  name,
  type: 'number',
  admin: { components: { Cell: `${CLIENT}#CountCell` }, ...shownIn(mode) },
  label: title(name),
})

const bytes = (
  name: 'freedBytes' | 'reclaimableBytes',
  key: 'freed' | 'widgetReclaimable',
  mode: Mode,
): NumberField => ({
  name,
  type: 'number',
  admin: { components: { Cell: `${CLIENT}#BytesCell`, Field: `${CLIENT}#BytesField` }, ...shownIn(mode) },
  label: title(key),
})

const titled: CollectionAfterChangeHook = async ({ collection, doc, operation, req }) => {
  if (operation !== 'create' || doc.title) return doc

  const runTitle = `#${doc.id}`

  await req.payload.update({
    collection: collection.slug as never,
    data: { title: runTitle } as never,
    id: doc.id,
    overrideAccess: true,
    req,
  })

  return { ...doc, title: runTitle }
}

export const buildRunsCollection = (options: ResolvedOptions): CollectionConfig => {
  const collection: CollectionConfig = {
    slug: options.runsSlug,
    access: {
      create: () => false,
      delete: async (args) =>
        (await options.access.approve(args)) && (await seesAllTenants(args.req, options))
          ? { status: { not_equals: 'running' } }
          : false,
      read: async (args) => (await options.access.read(args)) && seesAllTenants(args.req, options),
      update: () => false,
    },
    admin: {
      defaultColumns: ['startedAt', 'mode', 'status', 'orphans', 'missing', 'unused', 'deleted'],
      ...adminOf(options),
      useAsTitle: 'title',
    },
    disableDuplicate: true,
    hooks: { afterChange: [titled] },
    versions: false,
    fields: [
      {
        name: 'title',
        type: 'text',
        admin: HIDDEN,
      },
      {
        name: 'lock',
        type: 'text',
        admin: HIDDEN,
        unique: true,
      },
      {
        name: 'summary',
        type: 'ui',
        admin: { components: { Field: `${RSC}#RunSummary` }, disableListColumn: true },
      },
      {
        name: 'findings',
        type: 'join',
        admin: {
          allowCreate: false,
          condition: (data) => data.mode === 'scan',
          defaultColumns: ['objectKey', 'documentId', 'kind', 'status'],
          description: label('runFindingsHint'),
        },
        collection: options.findingsSlug,
        label: title('janitorFindings'),
        on: 'run',
      },
      {
        name: 'purged',
        type: 'join',
        admin: {
          allowCreate: false,
          condition: (data) => data.mode === 'purge',
          defaultColumns: ['objectKey', 'documentId', 'kind', 'status', 'note', 'error'],
          description: label('runPurgedHint'),
        },
        collection: options.findingsSlug,
        label: title('janitorFindings'),
        on: 'purgedBy',
      },
      {
        type: 'collapsible',
        admin: { initCollapsed: true },
        label: title('details'),
        fields: [
          {
            type: 'row',
            fields: [
              {
                name: 'startedAt',
                type: 'date',
                admin: { ...DATE, width: '50%' },
                index: true,
                label: title('startedAt'),
                required: true,
              },
              {
                name: 'heartbeatAt',
                type: 'date',
                admin: { ...DATE, condition: (data) => data.status !== 'done', readOnly: true, width: '50%' },
                index: true,
                label: title('lastSignOfLife'),
              },
              {
                name: 'finishedAt',
                type: 'date',
                admin: { ...DATE, condition: (data) => data.status === 'done', width: '50%' },
                label: title('finishedAt'),
              },
            ],
          },
          {
            type: 'row',
            fields: [
              {
                name: 'mode',
                type: 'select',
                admin: { width: '50%' },
                label: title('mode'),
                options: [
                  { label: title('modeScan'), value: 'scan' },
                  { label: title('modePurge'), value: 'purge' },
                ],
                required: true,
              },
              {
                name: 'status',
                type: 'select',
                admin: { width: '50%' },
                defaultValue: 'running',
                label: title('status'),
                options: [
                  { label: title('running'), value: 'running' },
                  { label: title('done'), value: 'done' },
                  { label: title('failed'), value: 'failed' },
                ],
                required: true,
              },
            ],
          },
          {
            type: 'row',
            fields: [
              count('scanned', 'scan'),
              count('orphans', 'scan'),
              count('missing', 'scan'),
              count('unused', 'scan'),
              bytes('reclaimableBytes', 'widgetReclaimable', 'scan'),
            ],
          },
          {
            type: 'row',
            fields: [
              count('deleted', 'purge'),
              count('failed', 'purge'),
              count('skipped', 'purge'),
              bytes('freedBytes', 'freed', 'purge'),
            ],
          },
          {
            name: 'error',
            type: 'textarea',
            admin: { condition: (data) => data.status === 'failed', readOnly: true },
            label: title('errorText'),
          },
        ],
      },
    ],
    labels: {
      plural: label('janitorRuns'),
      singular: label('janitorRun'),
    },
  }

  return withOverride(collection, options.overrides.runs)
}
