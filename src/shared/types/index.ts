export type UsageHit = {
  anchor?: string
  autosave?: boolean
  collection: string
  count: number
  fields: string[]
  global: boolean
  id?: number | string
  locales?: string[]
  status: 'draft' | 'published' | 'trashed' | 'version'
  title?: string
  updatedAt?: string
  url?: string
  versionId?: number | string
}

export type UsageRef = {
  column: string
  count: number
  table: string
  versions?: boolean
}

export type ScanReport = {
  byCollection: Record<string, { missing: number; objects: number; orphans: number; unused: number }>
  missing: number
  orphanBytes: number
  orphans: number
  scanned: number
  unused: number
  unusedBytes: number
}

export type PurgeReport = {
  deleted: number
  failed: { error: string; key: string }[]
  freedBytes: number
  skipped: { key: string; reason: string }[]
}

export type JanitorMode = 'purge' | 'scan'

export type StartResult = {
  blockedBy?: {
    heartbeatAt?: string
    id: number | string
    mode?: JanitorMode
    staleAt: string
    startedAt?: string
  }
  error?: string
  jobId?: number | string
  queued: boolean
  reason?: 'already-running'
  report?: { deleted: number; failed: number; skipped: number }
  runId?: number | string
  scan?: { missing: number; orphans: number; unused: number }
  started: boolean
}
