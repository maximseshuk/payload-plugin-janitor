'use client'

import {
  ConfirmationModal,
  PopupList,
  toast,
  useAuth,
  useConfig,
  useListQuery,
  useModal,
  useRouter,
  useSelection,
  useTranslation,
} from '@payloadcms/ui'
import React, { useCallback, useEffect, useState } from 'react'

import { type Notice, noticeOf, UNDECIDED } from '@/client/findingData.js'
import type { Translate } from '@/client/usageData.js'
import { DEFAULT_FINDINGS_SLUG, DEFAULT_RUNS_SLUG, PLUGIN_NAME } from '@/shared/constants.js'
import type { JanitorMode } from '@/shared/types/index.js'

type Props = {
  endpointsPath: string
  findingsSlug?: string
  runsSlug?: string
}

export const PURGE_MODAL = 'janitor-purge-confirm'

const STATUSES = [
  ['found', 'undecided'],
  ['keep', 'keep'],
  ['delete', 'toDelete'],
] as const

const DELETABLE = 'where[and][0][status][equals]=delete&where[and][1][kind][not_equals]=missing'

export const JanitorMenu: React.FC<Props> = ({
  endpointsPath,
  findingsSlug = DEFAULT_FINDINGS_SLUG,
  runsSlug = DEFAULT_RUNS_SLUG,
}) => {
  const {
    config: {
      routes: { admin, api },
      serverURL,
    },
  } = useConfig()
  const { t } = useTranslation()
  const translate = t as Translate
  const router = useRouter()
  const { openModal } = useModal()
  const { data } = useListQuery()
  const { count: selected, getQueryParams } = useSelection()
  const { permissions } = useAuth()

  const [busy, setBusy] = useState(false)
  const [approved, setApproved] = useState<number | undefined>()

  const count = useCallback(async (): Promise<number | undefined> => {
    try {
      const response = await fetch(`${serverURL}${api}/${findingsSlug}/count?${DELETABLE}`, {
        credentials: 'include',
      })
      const body = response.ok ? ((await response.json()) as { totalDocs?: unknown }) : {}
      const total = typeof body.totalDocs === 'number' ? body.totalDocs : undefined

      setApproved(total)

      return total
    } catch {
      setApproved(undefined)

      return undefined
    }
  }, [api, findingsSlug, serverURL])

  useEffect(() => {
    void count()
  }, [count, data])

  const status = translate(`${PLUGIN_NAME}:toDelete`)
  const runs = `${admin}/collections/${runsSlug}?sort=-startedAt`

  const notify = (notice: Notice): void => {
    const text = translate(`${PLUGIN_NAME}:${notice.key}`, notice.options)
    const action = notice.runs
      ? { action: { label: translate(`${PLUGIN_NAME}:openRuns`), onClick: () => router.push(runs) } }
      : undefined

    toast[notice.level](text, action)
  }

  const start = async (mode: JanitorMode): Promise<void> => {
    setBusy(true)

    try {
      const response = await fetch(`${serverURL}${api}${endpointsPath}/${mode}`, {
        credentials: 'include',
        method: 'POST',
      })
      const body: unknown = await response.json().catch(() => undefined)
      const notice = noticeOf(mode, response.status, body)

      notify(notice)

      if (notice.level === 'success' || notice.level === 'warning') router.refresh()
    } catch {
      notify({ key: 'runFailed', level: 'error', runs: true })
    } finally {
      setBusy(false)
      void count()
    }
  }

  const mark = async (next: (typeof STATUSES)[number][0]): Promise<void> => {
    setBusy(true)

    try {
      const where = getQueryParams({ status: { not_equals: 'deleted' } })
      const response = await fetch(`${serverURL}${api}/${findingsSlug}${where}&depth=0`, {
        body: JSON.stringify({ status: next }),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        method: 'PATCH',
      })
      const body = (await response.json().catch(() => undefined)) as
        | { errors?: unknown[]; message?: unknown }
        | undefined
      const text = typeof body?.message === 'string' ? body.message : t('error:unknown')

      if (response.ok && !body?.errors?.length) toast.success(text)
      else toast.error(text)

      router.refresh()
    } catch {
      toast.error(t('error:unknown'))
    } finally {
      setBusy(false)
      void count()
    }
  }

  const confirm = async (): Promise<void> => {
    const total = await count()

    if (total === 0) {
      toast.info(translate(`${PLUGIN_NAME}:purgeNothing`, { status }))

      return
    }

    openModal(PURGE_MODAL)
  }

  const runner = Boolean(permissions?.collections?.[runsSlug]?.read)

  return (
    <>
      {runner ? (
        <PopupList.Button disabled={busy} onClick={() => void start('scan')}>
          {translate(`${PLUGIN_NAME}:scan`)}
        </PopupList.Button>
      ) : null}
      <PopupList.Button href={`${admin}/collections/${findingsSlug}?${UNDECIDED}`}>
        {translate(`${PLUGIN_NAME}:showUndecided`)}
      </PopupList.Button>
      {selected > 0 && permissions?.collections?.[findingsSlug]?.update
        ? STATUSES.map(([value, label]) => (
            <PopupList.Button disabled={busy} key={value} onClick={() => void mark(value)}>
              {`${translate(`${PLUGIN_NAME}:markSelected`, { status: translate(`${PLUGIN_NAME}:${label}`) })} (${selected})`}
            </PopupList.Button>
          ))
        : null}
      {runner ? (
        <>
          <PopupList.Button disabled={busy || approved === 0} onClick={() => void confirm()}>
            {approved === undefined
              ? translate(`${PLUGIN_NAME}:purge`)
              : `${translate(`${PLUGIN_NAME}:purge`)} (${approved})`}
          </PopupList.Button>

          <ConfirmationModal
            body={translate(`${PLUGIN_NAME}:purgeConfirm`, { count: approved ?? 0, status })}
            confirmLabel={translate(`${PLUGIN_NAME}:purge`)}
            heading={translate(`${PLUGIN_NAME}:purgeConfirmTitle`)}
            modalSlug={PURGE_MODAL}
            onConfirm={() => start('purge')}
          />
        </>
      ) : null}
    </>
  )
}
