import type { CollectionConfig, Payload, PayloadRequest } from 'payload'
import { createLocalReq, ValidationError } from 'payload'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { bytesOf } from '@/client/findingData.js'
import { janitor } from '@/index.js'
import { JanitorWidget } from '@/rsc/JanitorWidget/JanitorWidget.js'
import { lastScan } from '@/rsc/JanitorWidget/JanitorWidget.utils.js'
import { breakdownOf } from '@/rsc/RunSummary/RunSummary.utils.js'
import { JANITOR_TASK, janitorOptions, runJanitor, STALE_RUN_MINUTES, startJanitor } from '@/server/run.js'
import type { JanitorPluginOptions } from '@/shared/types/options.js'

import { boot } from '../helpers/boot.js'

type Run = {
  error?: string
  heartbeatAt?: string
  id: number | string
  lock?: string
  mode: string
  startedAt: string
  status: string
}

const label = `${process.env.TEST_DB ?? 'sqlite'}${process.env.BLOCKS_AS_JSON === '1' ? ' (blocks as json)' : ''}`

const PROVIDER = '@seshuk/payload-plugin-janitor/client#FieldHighlight'

const tags: CollectionConfig = { slug: 'tags', fields: [{ name: 'name', type: 'text' }], versions: false }

const withJanitor = (options: Partial<JanitorPluginOptions> = {}) => ({
  collections: [tags],
  plugins: [janitor({ collections: { tags: { report: false, usagePanel: false } }, ...options })],
})

const runs = async (payload: Payload): Promise<Run[]> =>
  (
    await payload.find({
      collection: 'janitor-runs' as never,
      depth: 0,
      pagination: false,
      sort: 'startedAt',
      overrideAccess: true,
    })
  ).docs as unknown as Run[]

const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

const running = (payload: Payload, minutesAgo: number, heartbeatAt?: string) =>
  payload.create({
    collection: 'janitor-runs' as never,
    data: { heartbeatAt, lock: 'running', mode: 'scan', startedAt: ago(minutesAgo), status: 'running' } as never,
    overrideAccess: true,
  }) as unknown as Promise<Run>

const settle = (payload: Payload, run: Run) =>
  payload.update({
    collection: 'janitor-runs' as never,
    data: { lock: String(run.id), status: 'done' } as never,
    id: run.id,
    overrideAccess: true,
  })

const post = (payload: Payload, path: string, user: null | object = { collection: 'users', id: 1 }) => {
  const endpoint = payload.config.endpoints.find((item) => item.path === path)

  return endpoint!.handler({ payload, user } as unknown as PayloadRequest)
}

describe(`inline start on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot(withJanitor()))
  })

  afterAll(async () => {
    await teardown()
  })

  it('runs in the request and says what the scan found', async () => {
    const result = await startJanitor(payload)
    const run = (await runs(payload)).at(-1)

    expect(result).toEqual({
      queued: false,
      runId: run?.id,
      scan: { missing: 0, orphans: 0, unused: 0 },
      started: true,
    })
    expect(run).toMatchObject({ mode: 'scan', reclaimableBytes: 0, status: 'done' })
    expect(run).not.toHaveProperty('report')
  })

  it('runs a scan with the installed options when given only payload', async () => {
    expect(await runJanitor(payload)).toMatchObject({ missing: 0, orphans: 0, unused: 0 })
    expect((await runs(payload)).at(-1)).toMatchObject({ mode: 'scan', status: 'done' })
  })

  it('refuses a second start while one is running, as 409 through the endpoint', async () => {
    const active = await running(payload, 0, ago(0))

    try {
      const refused = {
        blockedBy: {
          heartbeatAt: expect.any(String),
          id: active.id,
          mode: 'scan',
          staleAt: new Date(new Date(active.heartbeatAt!).getTime() + STALE_RUN_MINUTES * 60_000).toISOString(),
          startedAt: active.startedAt,
        },
        queued: false,
        reason: 'already-running',
        started: false,
      }

      expect(await startJanitor(payload)).toEqual(refused)

      const response = await post(payload, '/janitor/scan')

      expect(response.status).toBe(409)
      expect(await response.json()).toEqual(refused)
    } finally {
      await settle(payload, active)
    }
  })

  it('refuses the run routes without access', async () => {
    expect((await post(payload, '/janitor/scan', null)).status).toBe(403)
    expect((await post(payload, '/janitor/purge', null)).status).toBe(403)
  })

  it('marks a stale running run failed and starts the new one', async () => {
    const stale = await running(payload, STALE_RUN_MINUTES + 1)

    expect(await startJanitor(payload)).toMatchObject({ queued: false, started: true })

    const all = await runs(payload)

    expect(all.find((run) => run.id === stale.id)).toMatchObject({
      error: expect.stringMatching(/^Abandoned/),
      lock: String(stale.id),
      status: 'failed',
    })
    expect(all.at(-1)).toMatchObject({ lock: String(all.at(-1)?.id), status: 'done' })
  })

  it('lets only one run hold the lock', async () => {
    const holder = await running(payload, 0, ago(0))

    try {
      await expect(running(payload, 0, ago(0))).rejects.toMatchObject({
        data: { errors: [expect.objectContaining({ path: 'lock' })] },
      })
    } finally {
      await settle(payload, holder)
    }
  })

  it('judges a run by its last heartbeat, not by when it started', async () => {
    const alive = await running(payload, STALE_RUN_MINUTES * 4, ago(1))

    try {
      expect(await startJanitor(payload)).toMatchObject({ reason: 'already-running', started: false })
    } finally {
      await settle(payload, alive)
    }

    const silent = await running(payload, STALE_RUN_MINUTES * 4, ago(STALE_RUN_MINUTES + 1))

    expect(await startJanitor(payload)).toMatchObject({ started: true })
    expect((await runs(payload)).find((run) => run.id === silent.id)).toMatchObject({ status: 'failed' })
  })

  it('tries once more when the lock is taken but its holder is already gone', async () => {
    const create = vi
      .spyOn(payload, 'create')
      .mockRejectedValueOnce(new ValidationError({ errors: [{ message: 'taken', path: 'lock' }] }))

    try {
      expect(await startJanitor(payload)).toMatchObject({ queued: false, started: true })
      expect(create).toHaveBeenCalledTimes(2)
    } finally {
      create.mockRestore()
    }
  })

  it('throws when the lock is still taken on the second try and nothing holds it', async () => {
    const taken = () => new ValidationError({ errors: [{ message: 'taken', path: 'lock' }] })
    const create = vi.spyOn(payload, 'create').mockRejectedValueOnce(taken()).mockRejectedValueOnce(taken())

    try {
      await expect(startJanitor(payload)).rejects.toThrow('janitor: another run holds the run lock')
      expect(create).toHaveBeenCalledTimes(2)
    } finally {
      create.mockRestore()
    }
  })

  it('reports what an inline purge deleted, failed and skipped', async () => {
    await payload.create({
      collection: 'janitor-findings' as never,
      data: {
        collectionSlug: 'tags',
        documentId: '999999',
        kind: 'unused',
        objectKey: 'tags/999999',
        status: 'delete',
      } as never,
      overrideAccess: true,
    })

    const result = await startJanitor(payload, 'purge')
    const run = (await runs(payload)).at(-1) as Run & Record<string, unknown>

    expect(result).toEqual({
      queued: false,
      report: { deleted: 0, failed: 0, skipped: 1 },
      runId: run.id,
      started: true,
    })
    expect(run).toMatchObject({ deleted: 0, failed: 0, skipped: 1 })
    expect(
      await breakdownOf(
        await createLocalReq({ user: { collection: 'users', id: 1 } as never }, payload),
        run.id,
        'purge',
      ),
    ).toEqual([{ counts: { notDeleted: 1 }, slug: 'tags' }])
  })
})

describe(`purge counts on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot(withJanitor({ minAge: 0 })))
  })

  afterAll(async () => {
    await teardown()
  })

  it('stores on the run what a purge deleted, failed and freed', async () => {
    const approved = async (name: string) => {
      const tag = (await payload.create({
        collection: 'tags' as never,
        data: { name } as never,
        overrideAccess: true,
      })) as unknown as { createdAt: string; id: number | string }

      await payload.create({
        collection: 'janitor-findings' as never,
        data: {
          collectionSlug: 'tags',
          documentId: String(tag.id),
          kind: 'unused',
          objectKey: `tags/${tag.id}`,
          size: 100,
          status: 'delete',
          uploadedAt: tag.createdAt,
        } as never,
        overrideAccess: true,
      })

      return tag
    }

    await approved('doomed')

    const stuck = await approved('stuck')
    const remove = payload.delete.bind(payload)
    const deny = vi
      .spyOn(payload, 'delete')
      .mockImplementation(((args: { id?: number | string }) =>
        args.id === stuck.id ? Promise.reject(new Error('denied')) : remove(args as never)) as never)

    try {
      expect(await startJanitor(payload, 'purge')).toMatchObject({ report: { deleted: 1, failed: 1, skipped: 0 } })
    } finally {
      deny.mockRestore()
    }

    const run = (await runs(payload)).at(-1)!

    expect(run).toMatchObject({ deleted: 1, failed: 1, freedBytes: 100, mode: 'purge', skipped: 0, status: 'done' })
    expect(
      await breakdownOf(
        await createLocalReq({ user: { collection: 'users', id: 1 } as never }, payload),
        run.id,
        'purge',
      ),
    ).toEqual([{ counts: { deleted: 1, notDeleted: 1 }, slug: 'tags' }])
  })
})

describe(`run marked failed while it ran on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}
  let fail = false
  let crash = false
  let reject = false

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      collections: [
        {
          ...tags,
          hooks: {
            afterRead: [
              async ({ doc, req }) => {
                if (crash) {
                  crash = false
                  throw new Error('storage went away')
                }
                if (!fail) return doc
                fail = false
                await req.payload.update({
                  collection: 'janitor-runs' as never,
                  data: { error: 'marked', status: 'failed' } as never,
                  where: { status: { equals: 'running' } },
                  overrideAccess: true,
                })

                return doc
              },
            ],
          },
        },
      ],
      plugins: [
        janitor({
          collections: { tags: { usagePanel: false } },
          minAge: 0,
          overrides: {
            runs: {
              hooks: {
                beforeChange: [
                  ({ data }) => {
                    if (!reject || data.status !== 'done') return data
                    reject = false
                    throw new Error('the report is too large')
                  },
                ],
              },
            },
          },
        }),
      ],
    }))
  })

  afterAll(async () => {
    await teardown()
  })

  it('keeps it failed instead of overwriting it with done', async () => {
    await payload.create({ collection: 'tags' as never, data: { name: 'loose' } as never, overrideAccess: true })
    fail = true

    await startJanitor(payload)

    const [marked] = await runs(payload)

    expect(marked).toMatchObject({ error: 'marked', lock: String(marked?.id), status: 'failed' })
  })

  it('releases the lock of a run that threw, so the next start runs', async () => {
    crash = true

    await expect(startJanitor(payload)).rejects.toThrow('storage went away')

    const failed = (await runs(payload)).at(-1)

    expect(failed).toMatchObject({ error: 'storage went away', lock: String(failed?.id), status: 'failed' })
    expect(await startJanitor(payload)).toMatchObject({ queued: false, started: true })
  })

  it('marks the run failed with the error and releases the lock when writing its result fails', async () => {
    reject = true

    const result = await startJanitor(payload)
    const run = (await runs(payload)).find((item) => item.id === result.runId)

    expect(reject).toBe(false)
    expect(run).toMatchObject({ error: 'the report is too large', lock: String(run?.id), status: 'failed' })
  })
})

describe(`run lock on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}
  let hold: { done: Promise<void>; started: () => void } | undefined

  beforeAll(async () => {
    ;({ payload, teardown } = await boot(
      {
        collections: [
          {
            ...tags,
            hooks: {
              afterRead: [
                async ({ doc }) => {
                  const wait = hold

                  hold = undefined
                  if (wait) {
                    wait.started()
                    await wait.done
                  }

                  return doc
                },
              ],
            },
          },
        ],
        plugins: [janitor({ collections: { tags: { usagePanel: false } }, minAge: 0 })],
      },
      { indexes: false },
    ))
    await payload.create({ collection: 'tags' as never, data: { name: 'loose' } as never, overrideAccess: true })
  })

  afterAll(async () => {
    await teardown()
  })

  it('refuses a start whose run lands after another took the lock, even with an earlier start time', async () => {
    let release = (): void => {}
    let scanning = (): void => {}
    let arrive = (): void => {}
    const scanned = new Promise<void>((resolve) => {
      scanning = resolve
    })
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve
    })

    hold = {
      done: new Promise<void>((resolve) => {
        release = resolve
      }),
      started: scanning,
    }

    const create = payload.create.bind(payload)
    let calls = 0
    const spy = vi.spyOn(payload, 'create').mockImplementation((async (args: Parameters<Payload['create']>[0]) => {
      if (args.collection !== 'janitor-runs') return create(args)

      calls += 1
      if (calls === 1) {
        await arrived

        return create(args)
      }

      arrive()
      await scanned

      return create({ ...args, data: { ...args.data, startedAt: ago(1) } })
    }) as never)

    try {
      const first = startJanitor(payload)
      const second = startJanitor(payload)
      const late = await Promise.race([first, second])

      release()

      const results = await Promise.all([first, second])
      const holder = results.find((result) => result.started)

      expect(late).toMatchObject({ reason: 'already-running', started: false })
      expect(results.filter((result) => result.started)).toHaveLength(1)
      expect(late.blockedBy?.id).toBe(holder?.runId)
      expect(await runs(payload)).toMatchObject([{ id: holder?.runId, status: 'done' }])
    } finally {
      spy.mockRestore()
      release()
    }
  })

  it('lets exactly one of several concurrent starts run and refuses the others', async () => {
    let release = (): void => {}
    let othersDone = (): void => {}
    const others = new Promise<void>((resolve) => {
      othersDone = resolve
    })

    hold = {
      done: new Promise<void>((resolve) => {
        release = resolve
      }),
      started: () => {},
    }

    const before = (await runs(payload)).length
    let settled = 0
    const starts = Array.from({ length: 5 }, () =>
      startJanitor(payload).finally(() => {
        settled += 1
        if (settled === 4) othersDone()
      }),
    )

    try {
      await others
    } finally {
      release()
    }

    const results = await Promise.all(starts)
    const started = results.filter((result) => result.started)

    expect(started).toHaveLength(1)
    expect(results.filter((result) => !result.started)).toMatchObject(
      Array.from({ length: 4 }, () => ({ blockedBy: { id: started[0]?.runId }, reason: 'already-running' })),
    )
    expect((await runs(payload)).slice(before)).toMatchObject([{ id: started[0]?.runId, status: 'done' }])
  })

  it('performs a queued run once when its job is delivered twice', async () => {
    const task = payload.config.jobs.tasks!.find((item) => item.slug === JANITOR_TASK)!
    const handle = task.handler as (args: unknown) => Promise<{ output: object }>
    const startedAt = ago(0)
    const queued = (await payload.create({
      collection: 'janitor-runs' as never,
      data: { heartbeatAt: startedAt, lock: 'running', mode: 'scan', startedAt, status: 'running' } as never,
      overrideAccess: true,
    })) as unknown as Run
    const input = { mode: 'scan', runId: String(queued.id) }
    let release = (): void => {}
    let scanning = (): void => {}
    const scanned = new Promise<void>((resolve) => {
      scanning = resolve
    })

    hold = {
      done: new Promise<void>((resolve) => {
        release = resolve
      }),
      started: scanning,
    }

    const first = handle({ input, req: { payload } })

    try {
      await scanned
      expect(await handle({ input, req: { payload } })).toEqual({
        output: { blockedBy: queued.id, reason: 'already-running' },
      })
    } finally {
      release()
    }

    expect(await first).toEqual({ output: { runId: queued.id } })
    expect((await runs(payload)).find((run) => run.id === queued.id)).toMatchObject({ status: 'done' })
  })
})

type Job = { completedAt?: string; hasError?: boolean; id: number | string; log?: { output?: object }[] }

const jobs = async (payload: Payload): Promise<Job[]> =>
  (
    await payload.find({
      collection: 'payload-jobs',
      depth: 0,
      pagination: false,
      where: { taskSlug: { equals: JANITOR_TASK } },
      overrideAccess: true,
    })
  ).docs as unknown as Job[]

describe(`queued start on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      ...withJanitor({ jobs: { queue: 'janitor', schedule: '0 3 * * *' } }),
      jobs: { deleteJobOnComplete: false },
    }))
  })

  afterAll(async () => {
    await teardown()
  })

  afterEach(async () => {
    await payload.delete({ collection: 'payload-jobs', where: { id: { exists: true } }, overrideAccess: true })
    await payload.delete({ collection: 'janitor-runs' as never, where: { id: { exists: true } }, overrideAccess: true })
  })

  it('creates the run at once, queues a job for it, and the job finishes that same run', async () => {
    const result = await startJanitor(payload)

    expect(result).toMatchObject({ queued: true, started: true })
    expect(result.jobId).toBeDefined()
    expect(await runs(payload)).toMatchObject([{ id: result.runId, lock: 'running', mode: 'scan', status: 'running' }])
    expect(
      await payload.findByID({ collection: 'payload-jobs', depth: 0, id: result.jobId!, overrideAccess: true }),
    ).toMatchObject({
      input: { mode: 'scan', runId: String(result.runId) },
      queue: 'janitor',
      taskSlug: JANITOR_TASK,
    })

    await payload.jobs.run({ queue: 'janitor', overrideAccess: true })

    expect(await runs(payload)).toMatchObject([{ id: result.runId, lock: String(result.runId), status: 'done' }])
    expect((await jobs(payload))[0]?.log?.map((entry) => entry.output)).toEqual([{ runId: result.runId }])
  })

  it('starts a fresh run when the run a job was queued for is no longer running', async () => {
    const result = await startJanitor(payload)

    await payload.update({
      collection: 'janitor-runs' as never,
      data: { lock: String(result.runId), status: 'failed' } as never,
      id: result.runId!,
      overrideAccess: true,
    })
    await payload.jobs.run({ queue: 'janitor', overrideAccess: true })

    const all = await runs(payload)

    expect(all).toMatchObject([
      { id: result.runId, status: 'failed' },
      { mode: 'scan', status: 'done' },
    ])
    expect((await jobs(payload))[0]?.log?.map((entry) => entry.output)).toEqual([{ runId: all[1]?.id }])
  })

  it('marks the run failed, releases the lock and answers 500 when queueing the job throws', async () => {
    const queue = vi
      .spyOn(payload.jobs, 'queue')
      .mockRejectedValueOnce(new Error('queue is down'))
      .mockRejectedValueOnce(new Error('queue is down'))

    try {
      await expect(startJanitor(payload)).rejects.toThrow('queue is down')

      const response = await post(payload, '/janitor/scan')

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'queue is down', queued: false, started: false })
    } finally {
      queue.mockRestore()
    }

    const [failed] = await runs(payload)

    expect(failed).toMatchObject({ error: 'queue is down', lock: String(failed?.id), status: 'failed' })
    expect(await startJanitor(payload)).toMatchObject({ queued: true, started: true })
  })

  it('throws the queueing error even when marking the run failed throws too', async () => {
    const update = vi.spyOn(payload, 'update')
    const queue = vi.spyOn(payload.jobs, 'queue').mockImplementationOnce(async () => {
      update.mockRejectedValueOnce(new Error('database is down'))
      throw new Error('queue is down')
    })

    try {
      await expect(startJanitor(payload)).rejects.toThrow('queue is down')
    } finally {
      queue.mockRestore()
      update.mockRestore()
    }

    expect(await runs(payload)).toMatchObject([{ lock: 'running', status: 'running' }])
  })

  it('puts the cron on the task as its schedule', () => {
    const task = payload.config.jobs.tasks?.find((item) => item.slug === JANITOR_TASK)

    expect(task?.schedule).toEqual([{ cron: '0 3 * * *', queue: 'janitor' }])
  })

  it('refuses a second start while the first job still waits, as 409 through the endpoint', async () => {
    const first = await startJanitor(payload)
    const [run] = (await runs(payload)) as (Run & { heartbeatAt: string })[]
    const refused = {
      blockedBy: {
        heartbeatAt: run?.heartbeatAt,
        id: first.runId,
        mode: 'scan',
        staleAt: new Date(new Date(run!.heartbeatAt).getTime() + STALE_RUN_MINUTES * 60_000).toISOString(),
        startedAt: run?.startedAt,
      },
      queued: false,
      reason: 'already-running',
      started: false,
    }

    expect(await startJanitor(payload, 'purge')).toEqual(refused)

    const response = await post(payload, '/janitor/scan')

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(refused)
    expect(await jobs(payload)).toHaveLength(1)
  })

  it('abandons a run whose job waited too long, releases its lock and lets a new start through', async () => {
    const stale = await startJanitor(payload)

    await payload.update({
      collection: 'janitor-runs' as never,
      data: { heartbeatAt: ago(STALE_RUN_MINUTES + 1) } as never,
      id: stale.runId!,
      overrideAccess: true,
    })

    const next = await startJanitor(payload)

    expect(next).toMatchObject({ queued: true, started: true })
    expect(await runs(payload)).toMatchObject([
      { error: expect.stringMatching(/^Abandoned/), id: stale.runId, lock: String(stale.runId), status: 'failed' },
      { id: next.runId, lock: 'running', status: 'running' },
    ])
  })

  it('queues one job for several starts at once, and running the queue makes exactly one run', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => startJanitor(payload)))
    const started = results.filter((result) => result.started)

    expect(started).toHaveLength(1)
    expect(results.filter((result) => !result.started)).toMatchObject(
      Array.from({ length: 4 }, () => ({ blockedBy: { id: started[0]?.runId }, reason: 'already-running' })),
    )
    expect(await jobs(payload)).toHaveLength(1)

    await payload.jobs.run({ queue: 'janitor', overrideAccess: true })

    expect(await runs(payload)).toMatchObject([{ id: started[0]?.runId, mode: 'scan', status: 'done' }])
  })

  it('runs one of two jobs the queue starts together and lets the other end quietly', async () => {
    await payload.jobs.queue({
      input: { mode: 'scan' } as never,
      queue: 'janitor',
      task: JANITOR_TASK as never,
      overrideAccess: true,
    })
    await payload.jobs.queue({
      input: { mode: 'scan' } as never,
      queue: 'janitor',
      task: JANITOR_TASK as never,
      overrideAccess: true,
    })

    await payload.jobs.run({ queue: 'janitor', overrideAccess: true })

    const all = await runs(payload)
    const done = await jobs(payload)

    expect(all).toMatchObject([{ mode: 'scan', status: 'done' }])
    expect(done.map((job) => [Boolean(job.completedAt), Boolean(job.hasError)])).toEqual([
      [true, false],
      [true, false],
    ])
    expect(done.flatMap((job) => job.log?.map((entry) => entry.output) ?? [])).toEqual(
      expect.arrayContaining([{ runId: all[0]?.id }, { blockedBy: all[0]?.id, reason: 'already-running' }]),
    )
  })

  it('runs a scheduled job, which has empty input, as a scan', async () => {
    const task = payload.config.jobs.tasks!.find((item) => item.slug === JANITOR_TASK)!

    await (task.handler as (args: unknown) => Promise<unknown>)({ input: {}, req: { payload } })

    expect(await runs(payload)).toMatchObject([{ mode: 'scan', status: 'done' }])
  })
})

describe(`headless on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot(withJanitor({ admin: false, endpoints: false })))
  })

  afterAll(async () => {
    await teardown()
  })

  it('mounts no provider and no menu with admin: false', () => {
    const findings = payload.config.collections.find((item) => item.slug === 'janitor-findings')

    expect(payload.config.admin.components?.providers ?? []).not.toContain(PROVIDER)
    expect(findings?.admin.components?.listMenuItems).toBeUndefined()
  })

  it('registers no route with endpoints: false', () => {
    expect(payload.config.endpoints.filter((item) => item.path.startsWith('/janitor'))).toEqual([])
  })

  it('still starts a run from code', async () => {
    expect(await startJanitor(payload)).toMatchObject({ queued: false, started: true })
  })
})

describe(`dashboard widget on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot(withJanitor()))
  })

  afterAll(async () => {
    await teardown()
  })

  const scan = (minutesAgo: number, status: string, counts: Record<string, unknown>) =>
    payload.create({
      collection: 'janitor-runs' as never,
      data: { finishedAt: ago(minutesAgo), mode: 'scan', startedAt: ago(minutesAgo), status, ...counts } as never,
      overrideAccess: true,
    })

  const admin = () => createLocalReq({ user: { collection: 'users', id: 1 } as never }, payload)

  it('shows zeros and a link to the findings before the first scan', async () => {
    const req = await admin()
    const { findingsSlug, runsSlug } = janitorOptions(payload)!
    const widget = await JanitorWidget({
      permissions: { collections: { [findingsSlug]: { read: true }, [runsSlug]: { read: true } } },
      req,
    } as never)
    const html = renderToStaticMarkup(widget!)

    expect(await lastScan(req)).toBeNull()
    expect(html).toContain('Not yet')
    expect(html).toContain(bytesOf(0, 'en'))
    expect(html).not.toContain('janitor-widget__stat--link')
    expect(html).toContain(`<a href="${payload.config.routes.admin}/collections/${findingsSlug}">`)
  })

  it('renders nothing for a user who may read findings but not runs', async () => {
    const { findingsSlug, runsSlug } = janitorOptions(payload)!
    const widget = await JanitorWidget({
      permissions: { collections: { [findingsSlug]: { read: true }, [runsSlug]: { read: false } } },
      req: await admin(),
    } as never)

    expect(widget).toBeNull()
  })

  it('shows the last finished scan, never a running one, with the bytes a purge would free', async () => {
    await scan(60, 'done', { missing: 9, orphans: 9, unused: 9 })
    const shown = (await scan(30, 'done', { missing: 1, orphans: 2, reclaimableBytes: 2500, unused: 3 })) as {
      id: number | string
    }
    await scan(5, 'running', { orphans: 7 })
    await payload.create({
      collection: 'janitor-runs' as never,
      data: { mode: 'purge', startedAt: ago(1), status: 'done' } as never,
      overrideAccess: true,
    })

    expect(await lastScan(await admin())).toEqual({
      finishedAt: expect.any(String),
      id: shown.id,
      missing: 1,
      orphans: 2,
      reclaimable: 2500,
      unused: 3,
    })
  })

  it("reads runs with the reader's access", async () => {
    await expect(lastScan(await createLocalReq({}, payload))).rejects.toThrow()
  })
})

describe(`enabled: false on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot(withJanitor({ enabled: false })))
  })

  afterAll(async () => {
    await teardown()
  })

  it('keeps both tables and runs the queued task as a no-op', async () => {
    const job = (await payload.jobs.queue({
      input: { mode: 'scan' } as never,
      overrideAccess: true,
      task: JANITOR_TASK as never,
    })) as { id: number | string }

    const result = await payload.jobs.runByID({ id: job.id, overrideAccess: true })

    expect(result.jobStatus?.[job.id]).toMatchObject({ status: 'success' })
    expect(await runs(payload)).toEqual([])
    expect((await payload.find({ collection: 'janitor-findings' as never, overrideAccess: true })).totalDocs).toBe(0)
    expect(payload.config.endpoints.some((item) => item.path.startsWith('/janitor'))).toBe(false)
    await expect(startJanitor(payload)).rejects.toThrow('janitor: the plugin is not installed on this Payload config')
    await expect(runJanitor(payload)).rejects.toThrow('janitor: the plugin is not installed on this Payload config')
    await expect(runJanitor(payload, 'Scan' as never)).rejects.toThrow(
      'janitor: mode must be "scan" or "purge", not "Scan"',
    )
  })
})

describe(`access per action on ${label}`, () => {
  let payload: Payload
  let teardown = async (): Promise<void> => {}

  beforeAll(async () => {
    ;({ payload, teardown } = await boot({
      collections: [{ ...tags, access: { delete: ({ req }) => req.user?.id === 1 } }],
      plugins: [
        janitor({
          access: { purge: ({ req }) => req.user?.id !== 3 },
          collections: { tags: { report: false, usagePanel: false } },
        }),
      ],
    }))
  })

  afterAll(async () => {
    await teardown()
  })

  it('checks each action on its own, and a purge also needs delete access on the collection it deletes from', async () => {
    const admin = { collection: 'users', id: 1 }
    const editor = { collection: 'users', id: 2 }

    expect((await post(payload, '/janitor/scan', { collection: 'users', id: 3 })).status).toBe(200)
    expect((await post(payload, '/janitor/purge', { collection: 'users', id: 3 })).status).toBe(403)
    expect((await post(payload, '/janitor/purge', editor)).status).toBe(200)

    const tag = await payload.create({
      collection: 'tags' as never,
      data: { name: 'old' } as never,
      overrideAccess: true,
    })

    await payload.create({
      collection: 'janitor-findings' as never,
      data: {
        collectionSlug: 'tags',
        documentId: String(tag.id),
        kind: 'unused',
        objectKey: `tags/${tag.id}`,
        status: 'delete',
      } as never,
      overrideAccess: true,
    })

    expect((await post(payload, '/janitor/purge', editor)).status).toBe(403)
    expect((await post(payload, '/janitor/purge', admin)).status).toBe(200)
  })
})
