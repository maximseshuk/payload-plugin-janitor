import type { Payload, TaskConfig, Where } from 'payload'
import { ValidationError } from 'payload'

import { isMongo } from '@/server/usage/mongo.js'
import { PLUGIN_NAME } from '@/shared/constants.js'
import type { JanitorMode, PurgeReport, ScanReport, StartResult } from '@/shared/types/index.js'
import type { ResolvedOptions } from '@/shared/types/resolved.js'

import { purgeApproved } from './purge.js'
import { scanStorage } from './scan.js'

export const JANITOR_TASK = 'janitor-run'

export const STALE_RUN_MINUTES = 30

const RUN_LOCK = 'running'

type Blocking = NonNullable<StartResult['blockedBy']>

const refused = (blockedBy: Blocking): StartResult => ({
  blockedBy,
  queued: false,
  reason: 'already-running',
  started: false,
})

type Finished = { report: PurgeReport | ScanReport; runId: number | string }

type JanitorJob = { input: { mode?: JanitorMode; runId?: string }; output: object }

export const janitorTask = (options: ResolvedOptions): TaskConfig<JanitorJob> => ({
  slug: JANITOR_TASK,
  handler: async ({ input, req }) => {
    const mode = input.mode === 'purge' ? 'purge' : 'scan'
    const reserved = input.runId ? await claim(req.payload, options, input.runId) : undefined
    const result = reserved
      ? await execute(req.payload, options, mode, reserved)
      : await tryRun(req.payload, options, mode)

    return {
      output: isBlocking(result) ? { blockedBy: result.id, reason: 'already-running' } : { runId: result.runId },
    }
  },
  inputSchema: [
    { name: 'mode', type: 'text' },
    { name: 'runId', type: 'text' },
  ],
  label: 'Janitor',
  retries: 0,
  ...(options.jobs && options.jobs.schedule
    ? { schedule: [{ cron: options.jobs.schedule, queue: options.jobs.queue }] }
    : {}),
})

const finish = async (
  payload: Payload,
  options: ResolvedOptions,
  id: number | string,
  data: Record<string, unknown>,
): Promise<void> => {
  const lock = String(id)
  const finishedAt = new Date().toISOString()
  const write = (fields: Record<string, unknown>) =>
    payload.update({
      collection: options.runsSlug as never,
      data: { ...fields, finishedAt, lock } as never,
      disableTransaction: true,
      overrideAccess: true,
      where: { and: [{ id: { equals: id } }, { status: { equals: 'running' } }] },
    })
  const own = await write(data)

  if (own.docs.length) return

  const [rejected] = own.errors

  if (rejected && (await write({ error: rejected.message, status: 'failed' })).docs.length) return

  await payload.update({
    collection: options.runsSlug as never,
    data: { lock } as never,
    disableTransaction: true,
    overrideAccess: true,
    where: { and: [{ id: { equals: id } }, { lock: { equals: RUN_LOCK } }] },
  })
}

type RunDoc = {
  heartbeatAt?: null | string
  id: number | string
  lock?: null | string
  mode?: JanitorMode
  startedAt?: null | string
  status?: string
}

const abandonStale = async (payload: Payload, options: ResolvedOptions): Promise<void> => {
  const cutoff = new Date(Date.now() - STALE_RUN_MINUTES * 60_000).toISOString()
  const stale = await payload.find({
    collection: options.runsSlug as never,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    where: {
      and: [
        { or: [{ status: { equals: 'running' } }, { lock: { equals: RUN_LOCK } }] },
        {
          or: [
            { heartbeatAt: { less_than: cutoff } },
            { and: [{ heartbeatAt: { exists: false } }, { startedAt: { less_than: cutoff } }] },
          ],
        },
      ],
    },
  })

  await Promise.all(
    (stale.docs as unknown as RunDoc[]).map((run) =>
      finish(payload, options, run.id, {
        error: `Abandoned: no sign of life for ${STALE_RUN_MINUTES} minutes, so the worker most likely stopped`,
        status: 'failed',
      }),
    ),
  )
}

const staleAt = (at: null | string | undefined): string =>
  new Date(new Date(at ?? Date.now()).getTime() + STALE_RUN_MINUTES * 60_000).toISOString()

const blockingRun = (run: RunDoc): Blocking => ({
  heartbeatAt: run.heartbeatAt ?? undefined,
  id: run.id,
  mode: run.mode,
  staleAt: staleAt(run.heartbeatAt ?? run.startedAt),
  startedAt: run.startedAt ?? undefined,
})

const lockHolder = async (payload: Payload, options: ResolvedOptions): Promise<RunDoc | undefined> => {
  const holder = await payload.find({
    collection: options.runsSlug as never,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { lock: { equals: RUN_LOCK } },
  })

  return holder.docs[0] as RunDoc | undefined
}

const isLockTaken = (err: unknown): boolean =>
  err instanceof ValidationError && err.data.errors.some((error) => error.path === 'lock')

const lockRun = async (
  payload: Payload,
  options: ResolvedOptions,
  mode: JanitorMode,
  retry = true,
): Promise<Blocking | RunDoc> => {
  await abandonStale(payload, options)

  const startedAt = new Date().toISOString()

  try {
    return (await payload.create({
      collection: options.runsSlug as never,
      data: { heartbeatAt: startedAt, lock: RUN_LOCK, mode, startedAt, status: 'running' } as never,
      disableTransaction: true,
      overrideAccess: true,
    })) as unknown as RunDoc
  } catch (err) {
    if (!isLockTaken(err)) throw err
  }

  const holder = await lockHolder(payload, options)

  if (holder) return blockingRun(holder)
  if (retry) return lockRun(payload, options, mode, false)

  throw new Error('janitor: another run holds the run lock')
}

const claim = async (payload: Payload, options: ResolvedOptions, runId: string): Promise<RunDoc | undefined> => {
  const held: Where[] = [{ id: { equals: runId } }, { status: { equals: 'running' } }, { lock: { equals: RUN_LOCK } }]
  const found = await payload.find({
    collection: options.runsSlug as never,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { and: held },
  })
  const run = found.docs[0] as RunDoc | undefined

  if (!run?.startedAt || run.heartbeatAt !== run.startedAt) return undefined

  const claimed = await payload.update({
    collection: options.runsSlug as never,
    data: { heartbeatAt: new Date(Math.max(Date.now(), Date.parse(run.startedAt) + 1)).toISOString() } as never,
    overrideAccess: true,
    where: { and: [...held, { heartbeatAt: { equals: run.startedAt } }] },
  })
  const own = claimed.docs[0] as RunDoc | undefined

  return own?.status === 'running' && own.lock === RUN_LOCK ? own : undefined
}

const execute = async (
  payload: Payload,
  options: ResolvedOptions,
  mode: JanitorMode,
  run: RunDoc,
): Promise<Finished> => {
  try {
    if (mode === 'scan') {
      const report = await scanStorage(payload, options, run.id)

      await finish(payload, options, run.id, {
        missing: report.missing,
        orphans: report.orphans,
        reclaimableBytes: report.orphanBytes + report.unusedBytes,
        scanned: report.scanned,
        status: 'done',
        unused: report.unused,
      })

      return { report, runId: run.id }
    }

    const report = await purgeApproved(payload, options, run.id)

    await finish(payload, options, run.id, {
      deleted: report.deleted,
      failed: report.failed.length,
      freedBytes: report.freedBytes,
      skipped: report.skipped.length,
      status: 'done',
    })

    return { report, runId: run.id }
  } catch (err) {
    await finish(payload, options, run.id, { error: (err as Error).message, status: 'failed' }).catch(() => {})

    throw err
  }
}

const isBlocking = (value: Blocking | Finished | RunDoc): value is Blocking => 'staleAt' in value

const tryRun = async (payload: Payload, options: ResolvedOptions, mode: JanitorMode): Promise<Blocking | Finished> => {
  const run = await lockRun(payload, options, mode)

  return isBlocking(run) ? run : execute(payload, options, mode, run)
}

export const runJanitor = async (
  payload: Payload,
  mode: JanitorMode = 'scan',
): Promise<null | PurgeReport | ScanReport> => {
  const result = await tryRun(payload, installedOptions(payload, mode), mode)

  return isBlocking(result) ? null : result.report
}

export const startRun = async (payload: Payload, options: ResolvedOptions, mode: JanitorMode): Promise<StartResult> => {
  if (!options.jobs) {
    const result = await tryRun(payload, options, mode)

    if (isBlocking(result)) return refused(result)

    const { runId } = result

    if (mode === 'scan') {
      const { missing, orphans, unused } = result.report as ScanReport

      return { queued: false, runId, scan: { missing, orphans, unused }, started: true }
    }

    const { deleted, failed, skipped } = result.report as PurgeReport

    return { queued: false, report: { deleted, failed: failed.length, skipped: skipped.length }, runId, started: true }
  }

  const run = await lockRun(payload, options, mode)

  if (isBlocking(run)) return refused(run)

  try {
    const job = (await payload.jobs.queue({
      input: { mode, runId: String(run.id) } as never,
      queue: options.jobs.queue,
      task: JANITOR_TASK as never,
      overrideAccess: true,
    })) as { id: number | string }

    return { jobId: job.id, queued: true, runId: run.id, started: true }
  } catch (err) {
    await finish(payload, options, run.id, { error: (err as Error).message, status: 'failed' }).catch(() => {})

    throw err
  }
}

export const ensureRunLock = async (payload: Payload, options: ResolvedOptions): Promise<void> => {
  if (!isMongo(payload)) return

  const models = (payload.db as unknown as { collections: Record<string, { ensureIndexes: () => Promise<void> }> })
    .collections

  try {
    await models[options.runsSlug]!.ensureIndexes()
  } catch (err) {
    throw new Error(
      `janitor: cannot create the unique index on "${options.runsSlug}.lock" that the run lock needs: ${(err as Error).message}`,
      { cause: err },
    )
  }
}

export const janitorOptions = (payload: Payload): ResolvedOptions | undefined =>
  (payload.config.custom as Record<string, ResolvedOptions> | undefined)?.[PLUGIN_NAME]

const installedOptions = (payload: Payload, mode: JanitorMode): ResolvedOptions => {
  if (mode !== 'scan' && mode !== 'purge') {
    throw new Error(`janitor: mode must be "scan" or "purge", not "${String(mode)}"`)
  }

  const options = janitorOptions(payload)

  if (!options) throw new Error('janitor: the plugin is not installed on this Payload config')

  return options
}

export const startJanitor = async (payload: Payload, mode: JanitorMode = 'scan'): Promise<StartResult> =>
  startRun(payload, installedOptions(payload, mode), mode)
