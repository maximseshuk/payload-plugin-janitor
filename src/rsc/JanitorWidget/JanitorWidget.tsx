import type { WidgetServerProps } from 'payload'
import React from 'react'

import { agoOf, bytesOf, localeOf } from '@/client/findingData.js'
import type { Translate } from '@/client/usageData.js'
import { janitorOptions } from '@/server/run.js'
import { PLUGIN_NAME } from '@/shared/constants.js'

import { lastScan } from './JanitorWidget.utils.js'
import './JanitorWidget.css'

const BASE = 'janitor-widget'

const STATS = [
  ['orphans', 'orphan'],
  ['unused', 'unused'],
  ['missing', 'missing'],
] as const

export const JanitorWidget: React.FC<WidgetServerProps> = async ({ permissions, req }) => {
  const options = janitorOptions(req.payload)

  const can = (slug: string) => Boolean(permissions?.collections?.[slug]?.read)

  if (!options || !can(options.findingsSlug) || !can(options.runsSlug)) return null

  const last = await lastScan(req)
  const scan = last ?? { id: '', missing: 0, orphans: 0, reclaimable: 0, unused: 0 }
  const t = req.i18n.t as Translate
  const { language } = req.i18n
  const href = `${req.payload.config.routes.admin}/collections/${options.findingsSlug}`
  const count = new Intl.NumberFormat(localeOf(language))

  return (
    <section className={BASE}>
      <h3 className={`${BASE}__title`}>{t(`${PLUGIN_NAME}:widgetLabel`)}</h3>

      <div className={`card ${BASE}__body`}>
        <div className={`${BASE}__summary`}>
          <div className={`${BASE}__fact`}>
            <span className={`${BASE}__muted`}>{t(`${PLUGIN_NAME}:widgetReclaimable`)}</span>
            <span className={`${BASE}__total`}>{bytesOf(scan.reclaimable, language)}</span>
          </div>
          <div className={`${BASE}__fact ${BASE}__fact--end`}>
            <span className={`${BASE}__muted`}>{t(`${PLUGIN_NAME}:widgetLastScan`)}</span>
            <span className={`${BASE}__strong`}>
              {last ? agoOf(last.finishedAt, language) : t(`${PLUGIN_NAME}:widgetNever`)}
            </span>
          </div>
        </div>

        <div aria-hidden="true" className={`${BASE}__bar`}>
          {STATS.filter(([field]) => scan[field] > 0).map(([field]) => (
            <span className={`${BASE}__part ${BASE}__part--${field}`} key={field} style={{ flexGrow: scan[field] }} />
          ))}
        </div>

        <ul className={`${BASE}__stats`}>
          {STATS.map(([field, kind]) => {
            const content = (
              <>
                <span className={`${BASE}__stat-label`}>
                  <span aria-hidden="true" className={`${BASE}__dot ${BASE}__part--${field}`} />
                  {t(`${PLUGIN_NAME}:${field}`)}
                </span>
                <span className={`${BASE}__strong`}>{count.format(scan[field])}</span>
              </>
            )

            return (
              <li key={field}>
                {scan[field] > 0 ? (
                  <a
                    className={`${BASE}__stat ${BASE}__stat--link`}
                    href={`${href}?where[and][0][kind][equals]=${kind}&where[and][1][run][equals]=${encodeURIComponent(scan.id)}`}
                  >
                    {content}
                  </a>
                ) : (
                  <span className={`${BASE}__stat`}>{content}</span>
                )}
              </li>
            )
          })}
        </ul>

        {last ? null : (
          <p className={`${BASE}__empty`}>
            <a href={href}>{t(`${PLUGIN_NAME}:widgetEmpty`)}</a>
          </p>
        )}
      </div>
    </section>
  )
}
