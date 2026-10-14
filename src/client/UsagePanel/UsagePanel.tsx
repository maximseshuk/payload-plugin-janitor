'use client'

import { getTranslation } from '@payloadcms/translations'
import {
  Banner,
  Button,
  ChevronIcon,
  Drawer,
  DrawerContentContainer,
  DrawerToggler,
  ExternalLinkIcon,
  FieldLabel,
  Pill,
  ShimmerEffect,
  Table,
  useConfig,
  useDocumentInfo,
  useDrawerSlug,
  useModal,
  useTranslation,
} from '@payloadcms/ui'
import type { ClientField, Column } from 'payload'
import React, { useCallback, useEffect, useState } from 'react'

import {
  BASE,
  countsOf,
  dateOf,
  fieldsByVersion,
  type Filter,
  type Group,
  groupByDocument,
  isLive,
  keep,
  type Place,
  previewSize,
  readUsage,
  STATE_STYLE,
  stateOf,
  timeOf,
  type Translate,
  type Verdict,
  verdictOf,
} from '@/client/usageData.js'
import { DEFAULT_ENDPOINTS_PATH, PLUGIN_NAME } from '@/shared/constants.js'
import type { UsageHit } from '@/shared/types/index.js'

import './UsagePanel.css'

type Props = {
  endpointsPath?: string
  collectionSlug?: string
  id?: number | string
  limit?: number
}

type State = {
  error: 'failed' | 'unsupported' | false
  loading: boolean
  ready: boolean
  usage: UsageHit[]
  used?: boolean
}

export const UsagePanel: React.FC<Props> = ({ endpointsPath = DEFAULT_ENDPOINTS_PATH, limit = 0, ...target }) => {
  const info = useDocumentInfo()
  const collectionSlug = target.collectionSlug ?? info.collectionSlug
  const id = target.id ?? info.id
  const { i18n, t } = useTranslation()
  const {
    config: {
      collections,
      routes: { api },
      serverURL,
    },
  } = useConfig()
  const drawerSlug = useDrawerSlug('janitor-usage')

  const [state, setState] = useState<State>({ error: false, loading: true, ready: false, usage: [] })
  const [filter, setFilter] = useState<Filter>('all')
  const [history, setHistory] = useState<Group | undefined>()

  const { modalState, openModal } = useModal()
  const isOpen = Boolean(modalState[drawerSlug]?.isOpen)

  useEffect(() => {
    if (!isOpen) setHistory(undefined)
  }, [isOpen])

  const load = useCallback(async (): Promise<void> => {
    if (!collectionSlug || !id) return

    setState((current) => ({ ...current, error: false, loading: true }))

    try {
      const response = await fetch(
        `${serverURL}${api}${endpointsPath}/usage/${encodeURIComponent(collectionSlug)}/${encodeURIComponent(id)}`,
        {
          credentials: 'include',
        },
      )
      const result = readUsage(response.ok, await response.json().catch(() => undefined))

      setState(
        'usage' in result
          ? { error: false, loading: false, ready: true, usage: result.usage, used: result.used }
          : { error: result.error, loading: false, ready: false, usage: [] },
      )
      setFilter('all')
    } catch {
      setState({ error: 'failed', loading: false, ready: false, usage: [] })
    }
  }, [api, endpointsPath, collectionSlug, id, serverURL])

  useEffect(() => {
    void load()
  }, [load])

  const translate = t as Translate
  const openHistory = (group: Group): void => {
    setHistory(group)
    openModal(drawerSlug)
  }
  const labelOf = useCallback(
    (hit: UsageHit): string => {
      if (hit.global) return translate(`${PLUGIN_NAME}:global`)

      const entity = collections.find((item) => item.slug === hit.collection)
      const label = entity?.labels?.singular

      return label ? getTranslation(label, i18n) : hit.collection
    },
    [collections, i18n, translate],
  )

  if (!id) return null

  const verdict = verdictOf(state.usage, state.used)
  const documents = groupByDocument(state.usage)
  const shown = documents.slice(0, previewSize(limit))
  const filtered = groupByDocument(keep(state.usage, filter))

  return (
    <div
      aria-busy={state.loading}
      className={`${BASE} field-type${state.loading && state.ready ? ` ${BASE}--refreshing` : ''}`}
    >
      <div className={`${BASE}__header`}>
        <FieldLabel label={translate(`${PLUGIN_NAME}:label`)} />
        <Button
          aria-label={translate(`${PLUGIN_NAME}:refresh`)}
          className={`${BASE}__refresh`}
          buttonStyle="icon-label"
          disabled={state.loading}
          icon={<RefreshIcon />}
          margin={false}
          onClick={() => void load()}
          round
          tooltip={translate(`${PLUGIN_NAME}:refresh`)}
        />
      </div>

      {state.loading && !state.ready && (
        <div className={`${BASE}__loading`}>
          {[0, 1, 2].map((row) => (
            <ShimmerEffect animationDelay={`${row * 25}ms`} height="calc(var(--base) * 1.6)" key={row} />
          ))}
        </div>
      )}

      {!state.loading && state.error === 'unsupported' && (
        <Banner type="default">{translate(`${PLUGIN_NAME}:unsupported`)}</Banner>
      )}

      {!state.loading && state.error === 'failed' && (
        <Banner type="error">
          <span className={`${BASE}__banner`}>
            {translate(`${PLUGIN_NAME}:error`)}
            <Button buttonStyle="secondary" margin={false} onClick={() => void load()}>
              {translate(`${PLUGIN_NAME}:retry`)}
            </Button>
          </span>
        </Banner>
      )}

      {state.ready && state.usage.length === 0 && <VerdictView t={translate} verdict={verdict} />}

      {state.usage.length > 0 && (
        <>
          <VerdictView t={translate} verdict={verdict} />

          <Counts counts={countsOf(state.usage).filter((entry) => entry.key !== 'all')} t={translate} />

          <List documents={shown} labelOf={labelOf} language={i18n.language} onHistory={openHistory} t={translate} />

          {documents.length > shown.length && (
            <DrawerToggler className={`${BASE}__open`} slug={drawerSlug}>
              {translate(`${PLUGIN_NAME}:showAll`, { count: documents.length })}
            </DrawerToggler>
          )}

          <Drawer
            className={`${BASE}-drawer`}
            slug={drawerSlug}
            title={
              history
                ? `${translate(`${PLUGIN_NAME}:history`)} – ${history.first.title ?? labelOf(history.first)}`
                : translate(`${PLUGIN_NAME}:drawer`)
            }
          >
            <DrawerContentContainer className={`${BASE} ${BASE}__drawer`}>
              {history ? (
                <HistoryView
                  group={history}
                  language={i18n.language}
                  onBack={() => setHistory(undefined)}
                  t={translate}
                />
              ) : (
                <>
                  <Tabs
                    label={translate(`${PLUGIN_NAME}:status`)}
                    onChange={setFilter}
                    tabs={countsOf(state.usage).map((entry) => ({
                      label: (
                        <>
                          {translate(`${PLUGIN_NAME}:${entry.key}`)}
                          <span className={`${BASE}__count`}>{entry.count}</span>
                        </>
                      ),
                      value: entry.key,
                    }))}
                    value={filter}
                  />

                  <UsageTable
                    documents={filtered}
                    labelOf={labelOf}
                    language={i18n.language}
                    onHistory={setHistory}
                    t={translate}
                  />
                </>
              )}
            </DrawerContentContainer>
          </Drawer>
        </>
      )}
    </div>
  )
}

const columnOf = (accessor: string, Heading: React.ReactNode, renderedCells: React.ReactNode[]): Column => ({
  accessor,
  active: true,
  field: { name: accessor, type: 'text' } as ClientField,
  Heading,
  renderedCells,
})

type ListProps = {
  documents: Group[]
  labelOf: (hit: UsageHit) => string
  language: string
  onHistory: (group: Group) => void
  t: Translate
}

const List: React.FC<ListProps> = ({ documents, labelOf, onHistory, t }) => (
  <ul className={`${BASE}__list`}>
    {documents.map((group) => (
      <li className={`${BASE}__row`} key={`${group.first.collection}-${group.first.id}`}>
        <div className={`${BASE}__title`}>
          <DocumentLink group={group} label={labelOf(group.first)} t={t} />
          <Status places={group.places} t={t} />
        </div>
        <Places onHistory={() => onHistory(group)} places={group.places} t={t} />
      </li>
    ))}
  </ul>
)

const UsageTable: React.FC<ListProps> = ({ documents, labelOf, language, onHistory, t }) => (
  <div className={`${BASE}__table`}>
    <Table
      appearance="condensed"
      columns={[
        columnOf(
          'document',
          t(`${PLUGIN_NAME}:document`),
          documents.map((group) => <DocumentLink group={group} key="document" label={labelOf(group.first)} t={t} />),
        ),
        columnOf(
          'fields',
          t(`${PLUGIN_NAME}:fields`),
          documents.map((group) => (
            <Places key="fields" onHistory={() => onHistory(group)} places={group.places} t={t} />
          )),
        ),
        columnOf(
          'status',
          t(`${PLUGIN_NAME}:status`),
          documents.map((group) => <Status key="status" places={group.places} t={t} />),
        ),
        columnOf(
          'updated',
          t(`${PLUGIN_NAME}:updated`),
          documents.map((group) => (
            <span className={`${BASE}__date`} key="updated">
              {dateOf(group.first.updatedAt, language)}
            </span>
          )),
        ),
      ]}
      data={documents.map((group) => ({ id: `${group.first.collection}-${group.first.id}` }))}
    />
  </div>
)

const DocumentLink: React.FC<{ group: Group; label: string; t: Translate }> = ({ group, label, t }) => (
  <span className={`${BASE}__document`}>
    <ExternalLink href={group.places.find(isLive)?.url ?? group.first.url} t={t}>
      {group.first.title ?? group.first.collection}
    </ExternalLink>
    &nbsp;
    <span className={`${BASE}__type`}>{label}</span>
  </span>
)

const Counts: React.FC<{ counts: ReturnType<typeof countsOf>; t: Translate }> = ({ counts, t }) => (
  <div className={`${BASE}__filters`}>
    {counts.map((entry) => (
      <Pill key={entry.key} pillStyle={entry.style} size="small">
        {`${t(`${PLUGIN_NAME}:${entry.key}`)} ${entry.count}`}
      </Pill>
    ))}
  </div>
)

const VerdictView: React.FC<{ t: Translate; verdict: Verdict }> = ({ t, verdict }) =>
  verdict.kind === 'live' || verdict.kind === 'held' || verdict.kind === 'current' ? (
    <Banner type={verdict.kind === 'live' ? 'error' : 'warning'}>
      <span className={`${BASE}__verdict`}>
        {t(`${PLUGIN_NAME}:${verdict.kind === 'live' ? 'liveTitle' : 'heldTitle'}`)}
        <span className={`${BASE}__detail`}>
          {t(
            `${PLUGIN_NAME}:${{ current: 'verdictHeldCurrent', held: 'verdictHeld', live: 'verdictLive' }[verdict.kind]}`,
            { count: verdict.count },
          )}
        </span>
      </span>
    </Banner>
  ) : (
    <Banner type="success">
      <span className={`${BASE}__verdict`}>
        {t(`${PLUGIN_NAME}:safeTitle`)}
        <span className={`${BASE}__detail`}>
          {t(`${PLUGIN_NAME}:${verdict.kind === 'history' ? 'verdictHistory' : 'verdictNone'}`)}
        </span>
      </span>
    </Banner>
  )

const Status: React.FC<{ places: Place[]; t: Translate }> = ({ places, t }) => {
  const state = stateOf(places)

  return (
    <Pill pillStyle={STATE_STYLE[state]} size="small">
      {t(`${PLUGIN_NAME}:${state}`)}
    </Pill>
  )
}

const Places: React.FC<{ onHistory: () => void; places: Place[]; t: Translate }> = ({ onHistory, places, t }) => {
  const current = places.filter((place) => place.status !== 'version')
  const versions = fieldsByVersion(places).size

  return (
    <ul className={`${BASE}__places`}>
      {current.map((place) => (
        <li className={`${BASE}__place`} key={`${place.versionId ?? 'live'}-${place.fields.join()}`}>
          <ExternalLink href={place.url} t={t}>
            {place.fields.join(', ')}
          </ExternalLink>
          {place.locales?.map((locale) => (
            <Pill key={locale} pillStyle="light-gray" size="small">
              {locale}
            </Pill>
          ))}
          {place.count > 1 && <span className={`${BASE}__count`}>{`×${place.count}`}</span>}
        </li>
      ))}
      {versions > 0 && (
        <li className={`${BASE}__place`}>
          <Button
            buttonStyle="icon-label"
            className={`${BASE}__versions`}
            icon={<ChevronIcon direction="right" size="small" />}
            iconPosition="right"
            margin={false}
            onClick={onHistory}
          >
            {t(`${PLUGIN_NAME}:${current.length === 0 ? 'onlyVersions' : 'alsoVersions'}`, { count: versions })}
          </Button>
        </li>
      )}
    </ul>
  )
}

type HistoryProps = {
  group: Group
  language: string
  onBack: () => void
  t: Translate
}

type Revision = {
  autosave?: boolean
  id: number | string
  updatedAt?: string
  version?: { _status?: string }
}

const VERSIONS = 100

const REVISION_STYLE = { autosave: 'light-gray', draft: 'warning', published: 'success' } as const

const revisionLabel = (revision: Revision): keyof typeof REVISION_STYLE =>
  revision.autosave ? 'autosave' : revision.version?._status === 'published' ? 'published' : 'draft'

export const HistoryView: React.FC<HistoryProps> = ({ group, language, onBack, t }) => {
  const { first } = group
  const {
    config: {
      routes: { admin, api },
      serverURL,
    },
  } = useConfig()

  const [revisions, setRevisions] = useState<Revision[] | undefined>()
  const [total, setTotal] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const collection = first.collection
  const global = Boolean(first.global)
  const id = first.id ?? ''
  const base = global ? `${admin}/globals/${collection}` : `${admin}/collections/${collection}/${id}`

  useEffect(() => {
    const path = global
      ? `${serverURL}${api}/globals/${collection}/versions`
      : `${serverURL}${api}/${collection}/versions?where[parent][equals]=${encodeURIComponent(id)}`

    void fetch(`${path}${global ? '?' : '&'}depth=0&limit=${VERSIONS}&sort=-updatedAt`, { credentials: 'include' })
      .then((response) => response.json() as Promise<{ docs?: Revision[]; totalDocs?: number }>)
      .then((body) => {
        setRevisions(body.docs ?? [])
        setTotal(body.totalDocs ?? 0)
      })
      .catch(() => setRevisions([]))
  }, [api, collection, global, id, serverURL])

  const byVersion = fieldsByVersion(group.places)
  const shown = revisions?.filter((revision) => showAll || byVersion.has(String(revision.id))) ?? []

  return (
    <>
      <div className={`${BASE}__back`}>
        <Button
          buttonStyle="pill"
          icon={<ChevronIcon direction="left" size="small" />}
          iconPosition="left"
          margin={false}
          onClick={onBack}
          size="small"
        >
          {t(`${PLUGIN_NAME}:drawer`)}
        </Button>
      </div>

      <p className="field-description">{t(`${PLUGIN_NAME}:${showAll ? 'historyHintAll' : 'historyHint'}`)}</p>

      {!revisions && <ShimmerEffect height="calc(var(--spacer-6) * 2)" />}

      {revisions && (
        <div className={`${BASE}__table ${BASE}__history`}>
          <Table
            appearance="condensed"
            columns={[
              columnOf(
                'updated',
                t(`${PLUGIN_NAME}:updated`),
                shown.map((revision) => (
                  <ExternalLink href={`${base}/versions/${revision.id}`} key="updated" t={t}>
                    {timeOf(revision.updatedAt, language)}
                  </ExternalLink>
                )),
              ),
              columnOf(
                'status',
                t(`${PLUGIN_NAME}:status`),
                shown.map((revision) => (
                  <Pill key="status" pillStyle={REVISION_STYLE[revisionLabel(revision)]} size="small">
                    {t(`${PLUGIN_NAME}:${revisionLabel(revision)}`)}
                  </Pill>
                )),
              ),
              columnOf(
                'fields',
                t(`${PLUGIN_NAME}:file`),
                shown.map((revision) => {
                  const fields = byVersion.get(String(revision.id)) ?? []

                  return fields.length > 0 ? (
                    <span className={showAll ? `${BASE}__held` : undefined} key="fields">
                      {fields.join(', ')}
                    </span>
                  ) : (
                    <span className={`${BASE}__count`} key="fields">
                      <span aria-hidden="true">&mdash;</span>
                      <span className={`${BASE}__sr`}>{t(`${PLUGIN_NAME}:absent`)}</span>
                    </span>
                  )
                }),
              ),
            ]}
            data={shown.map((revision) => ({ id: revision.id }))}
          />
        </div>
      )}

      {revisions && total > revisions.length && (
        <p className="field-description">
          {t(`${PLUGIN_NAME}:moreVersions`, { count: total, shown: revisions.length })}{' '}
          <ExternalLink href={`${base}/versions`} t={t}>
            {t(`${PLUGIN_NAME}:history`)}
          </ExternalLink>
        </p>
      )}

      {revisions && revisions.length > shown.length && (
        <div>
          <Button buttonStyle="secondary" margin={false} onClick={() => setShowAll(true)}>
            {t(`${PLUGIN_NAME}:showAllVersions`, { count: revisions.length })}
          </Button>
        </div>
      )}
    </>
  )
}

export const NewTab: React.FC<{ t: Translate }> = ({ t }) => (
  <>
    <span aria-hidden="true" className={`${BASE}__new-tab`}>
      <ExternalLinkIcon />
    </span>
    <span className={`${BASE}__sr`}>{` ${t(`${PLUGIN_NAME}:newTab`)}`}</span>
  </>
)

const ExternalLink: React.FC<{ children: string; href?: string; t: Translate }> = ({ children, href, t }) => {
  const tail = children.lastIndexOf(' ') + 1

  return (
    <a className={`${BASE}__link`} href={href} rel="noopener noreferrer" target="_blank">
      {children.slice(0, tail)}
      <span className={`${BASE}__tail`}>
        {children.slice(tail)}
        <NewTab t={t} />
      </span>
    </a>
  )
}

const Tabs: React.FC<{
  label: string
  onChange: (value: Filter) => void
  tabs: { label: React.ReactNode; value: Filter }[]
  value: Filter
}> = ({ label, onChange, tabs, value }) => (
  <fieldset aria-label={label} className={`${BASE}__tabs`}>
    {tabs.map((tab) => (
      <Button
        buttonStyle="tab"
        extraButtonProps={{ 'aria-pressed': tab.value === value }}
        key={tab.value}
        margin={false}
        onClick={() => onChange(tab.value)}
      >
        {tab.label}
      </Button>
    ))}
  </fieldset>
)

const RefreshIcon: React.FC = () => (
  <svg className="icon icon--refresh" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <path
      className="stroke"
      d="M4.5 10a5.5 5.5 0 0 1 9.9-3.3M14.5 3.5v3.3h-3.3M15.5 10a5.5 5.5 0 0 1-9.9 3.3M5.5 16.5v-3.2h3.3"
    />
  </svg>
)
