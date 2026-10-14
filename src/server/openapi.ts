import type { OpenAPIV3_1 } from '@scalar/openapi-types'

const README = 'https://github.com/maximseshuk/payload-plugin-janitor'

const id = { oneOf: [{ type: 'integer' }, { type: 'string' }] } satisfies OpenAPIV3_1.SchemaObject

const startResult: OpenAPIV3_1.SchemaObject = {
  properties: {
    blockedBy: {
      description: 'The run that holds the run lock. Sent only with `reason: "already-running"`.',
      properties: {
        heartbeatAt: {
          description: 'Last sign of life of the blocking run.',
          format: 'date-time',
          type: 'string',
        },
        id: { ...id, description: 'Id of the blocking run.' },
        mode: { enum: ['purge', 'scan'], type: 'string' },
        staleAt: {
          description: 'When the blocker counts as abandoned: 30 minutes after its last heartbeat, or after its start.',
          format: 'date-time',
          type: 'string',
        },
        startedAt: { format: 'date-time', type: 'string' },
      },
      required: ['id', 'staleAt'],
      type: 'object',
    },
    error: { description: 'Error message. Sent only with status `500`.', type: 'string' },
    jobId: { ...id, description: 'Id of the queued `janitor-run` job, with `jobs` set.' },
    queued: {
      description: '`true` when the run was queued as a Payload job.',
      type: 'boolean',
    },
    reason: { description: 'Why the run did not start.', enum: ['already-running'], type: 'string' },
    report: {
      description: 'Purge counts, after an inline purge.',
      properties: {
        deleted: { description: 'Findings deleted.', type: 'integer' },
        failed: {
          description: 'Findings whose delete or storage lookup threw. They stay marked `delete`.',
          type: 'integer',
        },
        skipped: {
          description:
            'Findings not deleted, for example because the re-check did not pass. The reason is in their note.',
          type: 'integer',
        },
      },
      required: ['deleted', 'failed', 'skipped'],
      type: 'object',
    },
    runId: {
      ...id,
      description:
        'Id of the run in the runs collection: the finished run after an inline run, or the run the queued job will perform with `jobs` set.',
    },
    scan: {
      description: 'Scan counts, after an inline scan.',
      properties: {
        missing: { type: 'integer' },
        orphans: { type: 'integer' },
        unused: { type: 'integer' },
      },
      required: ['missing', 'orphans', 'unused'],
      type: 'object',
    },
    started: { description: '`true` when the run ran or was queued.', type: 'boolean' },
  },
  required: ['queued', 'started'],
  type: 'object',
}

const error: OpenAPIV3_1.SchemaObject = {
  properties: { error: { type: 'string' } },
  required: ['error'],
  type: 'object',
}

const json = (schema: OpenAPIV3_1.SchemaObject) => ({ 'application/json': { schema } })

const runResponses: OpenAPIV3_1.ResponsesObject = {
  '200': {
    content: json(startResult),
    description:
      'The run started. With `jobs: false` it has finished, and the body has `runId` and the `scan` or `report` counts. With `jobs` set the run was created with status `running` and queued as a Payload job (`runId`, `jobId`).',
  },
  '403': {
    content: json(error),
    description:
      'Access denied: the `scan` action, or with `tenants` a user who does not see every tenant. The body is `{ "error": "Forbidden" }`.',
  },
  '409': {
    content: json(startResult),
    description:
      'The run did not start because another one is going: a run that holds the run lock and whose last heartbeat is less than 30 minutes old. With `jobs` set, that includes a run whose job still waits in the queue. `started` is `false`, `reason` is `already-running` and `blockedBy` names the blocker. A run with no heartbeat for 30 minutes is marked `failed` first and does not block.',
  },
  '500': {
    content: json(startResult),
    description:
      'Starting or running failed: an inline run threw (the run is marked `failed`) or queueing the job failed. The body has `error`, and `queued` and `started` are `false`. When an access function throws, Payload answers with its own body, `{ "errors": [{ "message": "…" }] }`.',
  },
}

const scanOperation: OpenAPIV3_1.OperationObject = {
  description: `Starts a scan, inside the request or as a Payload job, depending on the \`jobs\` option. A scan only writes findings; it never deletes. Only one run (scan or purge) runs at a time. Needs the \`scan\` access action and, with \`tenants\`, a user who sees every tenant. See [Starting runs](${README}#starting-runs).`,
  responses: runResponses,
  summary: 'Start a scan',
  tags: ['Janitor'],
}

const purgeOperation: OpenAPIV3_1.OperationObject = {
  description: `Starts a purge, inside the request or as a Payload job, depending on the \`jobs\` option. The purge deletes only findings an admin marked \`delete\`, and checks each one again right before it deletes it. Only one run (scan or purge) runs at a time. Needs the \`purge\` access action and, with \`tenants\`, a user who sees every tenant. For every watched collection that has findings marked \`delete\`, that collection's \`access.delete\` must return \`true\` for the user (a query is not enough). See [Access](${README}#access).`,
  responses: {
    ...runResponses,
    '403': {
      content: json(error),
      description:
        'Access denied: the `purge` action, with `tenants` a user who does not see every tenant, or the `delete` access of a collection with findings marked `delete`. The body is `{ "error": "Forbidden" }`.',
    },
  },
  summary: 'Start a purge of approved findings',
  tags: ['Janitor'],
}

const usageHit: OpenAPIV3_1.SchemaObject = {
  properties: {
    anchor: {
      description: 'Path of the field that holds the reference, used for the `#field-…` link in `url`.',
      type: 'string',
    },
    autosave: { description: '`true` when the reference is in an autosaved version.', type: 'boolean' },
    collection: { description: 'Slug of the collection or global that holds the reference.', type: 'string' },
    count: { description: 'How many references this entry groups.', type: 'integer' },
    fields: {
      description:
        'Labels of the fields that hold the reference, in the language of the request. Nested fields read `Label › sub`.',
      items: { type: 'string' },
      type: 'array',
    },
    global: { description: '`true` when `collection` is a global.', type: 'boolean' },
    id: { ...id, description: 'Id of the referencing document.' },
    locales: {
      description: 'Locales the reference is stored in. Empty when the field is not localized.',
      items: { type: 'string' },
      type: 'array',
    },
    status: {
      description:
        '`published` or `draft` for the current document, `draft` also for its newest draft version, `trashed` when the document is in the trash, `version` for an older version.',
      enum: ['draft', 'published', 'trashed', 'version'],
      type: 'string',
    },
    title: {
      description: 'Title of the document (its `useAsTitle`, or the id), or the label of the global.',
      type: 'string',
    },
    updatedAt: { format: 'date-time', type: 'string' },
    url: {
      description: 'Admin URL of the document, version or global, when the plugin can build one.',
      type: 'string',
    },
    versionId: { ...id, description: 'Id of the version, when the reference is in an older version or a newer draft.' },
  },
  required: ['collection', 'count', 'fields', 'global', 'status'],
  type: 'object',
}

const usageOperation: OpenAPIV3_1.OperationObject = {
  description: `Lists every place that references a document: documents, globals and their versions. This is the data of the usage panel. Needs the \`read\` access action, and the user must be able to read the document. Lists only places the user may read, current documents first, then the most recently updated. See [Admin and endpoints](${README}#admin-and-endpoints).`,
  parameters: [
    {
      description: "Slug of a collection listed in the plugin's `collections`.",
      in: 'path',
      name: 'collection',
      required: true,
      schema: { type: 'string' },
    },
    { description: 'Document id.', in: 'path', name: 'id', required: true, schema: { type: 'string' } },
    {
      description:
        'Return only the first N entries of `usage`. `0` or no value returns all. `used` still considers every reference, including ones not listed.',
      in: 'query',
      name: 'limit',
      required: false,
      schema: { minimum: 0, type: 'integer' },
    },
  ],
  responses: {
    '200': {
      content: json({
        properties: {
          supported: {
            description: '`false` when the database has no usage detection. `usage` is then empty.',
            type: 'boolean',
          },
          usage: { items: usageHit, type: 'array' },
          used: {
            description:
              'Whether a reference keeps the document, under `references.versions`: the answer a purge would get. Sent only when `supported` is `true`.',
            type: 'boolean',
          },
        },
        required: ['supported', 'usage'],
        type: 'object',
      }),
      description: 'Where the document is used.',
    },
    '400': {
      content: json(error),
      description:
        'A path parameter is missing (`Missing parameters`), or the collection is not watched by the plugin (`Collection is not watched`).',
    },
    '403': { content: json(error), description: 'Access denied. The body is `{ "error": "Forbidden" }`.' },
    '404': {
      content: json(error),
      description: 'The document does not exist, or the user may not read it. The body is `{ "error": "Not found" }`.',
    },
    '500': {
      description:
        'Usage detection or an access function threw. The request fails rather than report the document as unused. Payload answers with its own body, `{ "errors": [{ "message": "…" }] }`.',
    },
  },
  summary: 'Where a document is used',
  tags: ['Janitor'],
}

export const operations: Record<'purge' | 'scan' | 'usage', object> = {
  purge: purgeOperation,
  scan: scanOperation,
  usage: usageOperation,
}
