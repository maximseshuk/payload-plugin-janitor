import { getTranslation } from '@payloadcms/translations'
import { CircledXIcon, ClockIcon, SearchIcon, TrashIcon } from '@payloadcms/ui'
import type { UIFieldServerProps } from 'payload'
import React from 'react'

import { agoOf, bytesOf, durationOf, localeOf } from '@/client/findingData.js'
import type { Translate } from '@/client/usageData.js'
import { PLUGIN_NAME } from '@/shared/constants.js'

import { breakdownOf, type Tally } from './RunSummary.utils.js'
import '@/client/FindingFields/FindingFields.css'

import './RunSummary.css'

const SUMMARY = 'janitor-summary'

const TALLIES: Tally[] = ['orphans', 'missing', 'unused', 'deleted', 'notDeleted']

export const RunSummary: React.FC<UIFieldServerProps> = async ({ data, id, req }) => {
  const run = (data ?? {}) as Record<string, unknown>

  if (id === undefined || (run.mode !== 'scan' && run.mode !== 'purge')) return null

  const t = req.i18n.t as Translate
  const { language } = req.i18n
  const mode = run.mode
  const status = run.status
  const number = new Intl.NumberFormat(localeOf(language))
  const countOf = (name: string) => (typeof run[name] === 'number' ? number.format(run[name]) : '')
  const head =
    status === 'failed'
      ? {
          icon: <CircledXIcon size={24} />,
          text: typeof run.error === 'string' ? run.error : '',
          title: 'runFailedTitle',
        }
      : status === 'running'
        ? {
            icon: <ClockIcon />,
            text: t(`${PLUGIN_NAME}:runRunning`),
            title: mode === 'scan' ? 'runScanRunningTitle' : 'runPurgeRunningTitle',
          }
        : mode === 'scan'
          ? { icon: <SearchIcon />, text: t(`${PLUGIN_NAME}:runScan`), title: 'scanDone' }
          : { icon: <TrashIcon />, text: t(`${PLUGIN_NAME}:runPurge`), title: 'purgeFinished' }
  const facts = (
    [
      [`${PLUGIN_NAME}:startedAt`, agoOf(run.startedAt, language)],
      [`${PLUGIN_NAME}:duration`, durationOf(run.startedAt, run.finishedAt, language)],
      ...(mode === 'scan'
        ? ([
            [`${PLUGIN_NAME}:scanned`, countOf('scanned')],
            [`${PLUGIN_NAME}:orphans`, countOf('orphans')],
            [`${PLUGIN_NAME}:missing`, countOf('missing')],
            [`${PLUGIN_NAME}:unused`, countOf('unused')],
          ] as const)
        : ([
            [`${PLUGIN_NAME}:deleted`, countOf('deleted')],
            [`${PLUGIN_NAME}:failed`, countOf('failed')],
            [`${PLUGIN_NAME}:skipped`, countOf('skipped')],
            [`${PLUGIN_NAME}:freed`, bytesOf(run.freedBytes, language)],
          ] as const)),
    ] as const
  ).filter(([, fact]) => fact)
  const rows = status === 'running' ? [] : await breakdownOf(req, id, mode)
  const columns = TALLIES.filter((tally) => rows.some((row) => row.counts[tally] !== undefined))
  const labelOf = (slug: string) => {
    const singular = req.payload.collections[slug as never]?.config.labels.singular

    return (singular ? getTranslation(singular, req.i18n) : '') || slug
  }

  return (
    <section className={`field-type ${SUMMARY}${status === 'failed' ? ` ${SUMMARY}--danger` : ''}`}>
      <header className={`${SUMMARY}__header`}>
        <span aria-hidden="true" className={`${SUMMARY}__icon`}>
          {head.icon}
        </span>
        <div className={`${SUMMARY}__heading`}>
          <h3 className={`${SUMMARY}__title`}>{t(`${PLUGIN_NAME}:${head.title}`)}</h3>
          {head.text && <p className={`${SUMMARY}__text`}>{head.text}</p>}
        </div>
      </header>
      {facts.length > 0 && (
        <dl className={`${SUMMARY}__facts`}>
          {facts.map(([key, fact]) => (
            <div className={`${SUMMARY}__fact`} key={key}>
              <dt>{t(key)}</dt>
              <dd>{fact}</dd>
            </div>
          ))}
        </dl>
      )}
      {rows.length > 0 && (
        <table className={`${SUMMARY}__table`}>
          <thead>
            <tr>
              <th scope="col">{t(`${PLUGIN_NAME}:collection`)}</th>
              {columns.map((tally) => (
                <th key={tally} scope="col">
                  {t(`${PLUGIN_NAME}:${tally}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.slug}>
                <th scope="row">{labelOf(row.slug)}</th>
                {columns.map((tally) => (
                  <td key={tally}>{number.format(row.counts[tally] ?? 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
