'use client'

import { getTranslation } from '@payloadcms/translations'
import {
  CircledXIcon,
  DocumentIcon,
  FieldDescription,
  fieldBaseClass,
  FieldLabel,
  Link,
  LinkIcon,
  mergeFieldStyles,
  Pill,
  RadioGroupField,
  TextInput,
  Thumbnail,
  useConfig,
  useField,
  useFormFields,
  useTranslation,
} from '@payloadcms/ui'
import type {
  ClientCollectionConfig,
  DefaultCellComponentProps,
  JSONFieldClientProps,
  RadioFieldClientProps,
  RadioFieldDescriptionClientProps,
  TextFieldClientProps,
  UIFieldClientProps,
} from 'payload'
import { getBestFitFromSizes, isImage } from 'payload/shared'
import React, { useEffect, useState } from 'react'

import {
  agoOf,
  bytesOf,
  type Doc,
  type Finding,
  isImageKey,
  kindOf,
  linkOf,
  loadDoc,
  titleOf,
} from '@/client/findingData.js'
import type { Translate } from '@/client/usageData.js'
import { NewTab, UsagePanel } from '@/client/UsagePanel/UsagePanel.js'
import { PLUGIN_NAME } from '@/shared/constants.js'
import type { UsageRef } from '@/shared/types/index.js'

import './FindingFields.css'

const BASE = 'janitor-target'

type Loaded = { doc: Doc | null; state: 'done' } | { state: 'failed' } | { state: 'loading' }

const useDoc = (entity: ClientCollectionConfig | undefined, id: null | string | undefined): Loaded => {
  const {
    config: {
      routes: { api },
      serverURL,
    },
  } = useConfig()
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const slug = entity?.slug
  const trash = Boolean(entity?.trash)

  useEffect(() => {
    if (!slug || !id) return

    let live = true

    setLoaded({ state: 'loading' })
    loadDoc(`${serverURL}${api}/${slug}${trash ? '?trash=true' : ''}`, id)
      .then((doc) => live && setLoaded({ doc, state: 'done' }))
      .catch(() => live && setLoaded({ state: 'failed' }))

    return () => {
      live = false
    }
  }, [api, id, serverURL, slug, trash])

  return loaded
}

const previewOf = (doc: Doc | null, entity: ClientCollectionConfig | undefined): string | undefined => {
  if (!doc || !entity?.upload || entity.upload.displayPreview === false) return undefined

  const thumbnail = typeof doc.thumbnailURL === 'string' ? doc.thumbnailURL : undefined
  const url = typeof doc.url === 'string' ? doc.url : undefined

  if (!isImage(String(doc.mimeType ?? ''))) return thumbnail

  return getBestFitFromSizes({
    sizes: doc.variants as never,
    thumbnailURL: thumbnail,
    url: url ?? '',
    width: typeof doc.width === 'number' ? doc.width : undefined,
  })
}

const useCollectionLabel = (slug: string): { entity: ClientCollectionConfig | undefined; label: string } => {
  const { getEntityConfig } = useConfig()
  const { i18n } = useTranslation()
  const entity = slug ? (getEntityConfig({ collectionSlug: slug }) as ClientCollectionConfig | undefined) : undefined
  const singular = entity?.labels?.singular

  return { entity, label: (singular ? getTranslation(singular, i18n) : '') || slug }
}

export const CollectionCell: React.FC<DefaultCellComponentProps> = ({ cellData }) => (
  <span>{useCollectionLabel(typeof cellData === 'string' ? cellData : '').label}</span>
)

export const CollectionField: React.FC<TextFieldClientProps> = ({ field, path }) => {
  const { value } = useField<string>({ path })

  return (
    <TextInput
      label={field.label}
      path={path}
      readOnly
      required={field.required}
      style={mergeFieldStyles(field)}
      value={useCollectionLabel(value ?? '').label}
    />
  )
}

export const FindingTarget: React.FC<{ finding: Finding }> = ({ finding }) => {
  const {
    config: {
      routes: { admin },
    },
  } = useConfig()
  const { t } = useTranslation()
  const translate = t as Translate
  const slug = finding.collectionSlug ?? ''
  const { entity } = useCollectionLabel(slug)
  const loaded = useDoc(entity, finding.documentId)
  const kind = kindOf(finding, Boolean(entity?.upload))

  if (kind === 'object') {
    const href = linkOf(finding.ref)

    if (!href) return <span className={`${BASE} ${BASE}--empty`}>&mdash;</span>

    return (
      <span className={BASE}>
        {isImageKey(finding.objectKey) && (
          <Thumbnail
            className={`${BASE}__thumb`}
            doc={{ filename: finding.objectKey ?? '' }}
            fileSrc={href}
            size="small"
          />
        )}
        <span className={`${BASE}__text`}>
          <a className={`${BASE}__link`} href={href} rel="noopener noreferrer" target="_blank">
            {translate(`${PLUGIN_NAME}:openFile`)}
            <NewTab t={translate} />
          </a>
        </span>
      </span>
    )
  }

  const id = finding.documentId ?? ''
  const doc = loaded.state === 'done' ? loaded.doc : null
  const gone = loaded.state === 'done' && !loaded.doc
  const named = titleOf(doc, entity?.admin?.useAsTitle)
  const title = named ?? `ID: ${id}`
  const meta = gone ? translate(`${PLUGIN_NAME}:documentGone`) : named && named !== id ? `ID: ${id}` : undefined
  const shown = kind === 'file' && finding.kind !== 'missing'
  const preview = shown ? previewOf(doc, entity) : undefined

  return (
    <span className={BASE}>
      {shown && doc && (
        <Thumbnail
          className={`${BASE}__thumb`}
          collectionSlug={slug}
          doc={doc}
          fileSrc={preview}
          size="small"
          uploadConfig={entity?.upload as never}
        />
      )}
      <span className={`${BASE}__text`}>
        {gone ? (
          <span className={`${BASE}__title`}>{`ID: ${id}`}</span>
        ) : (
          <Link
            className={`${BASE}__link`}
            href={`${admin}/collections/${slug}/${encodeURIComponent(id)}`}
            prefetch={false}
          >
            {title}
          </Link>
        )}
        {meta && <span className={`${BASE}__meta`}>{meta}</span>}
      </span>
    </span>
  )
}

export const FindingTargetCell: React.FC<DefaultCellComponentProps> = ({ rowData }) => (
  <FindingTarget finding={rowData as Finding} />
)

const useFinding = () => {
  const fields = useFormFields(([state]) => state)

  const value = (name: string): string | undefined => {
    const entry = fields[name]?.value

    return typeof entry === 'string' ? entry : undefined
  }

  return { fields, value }
}

export const FindingTargetField: React.FC<TextFieldClientProps> = ({ field, path }) => {
  const { value } = useFinding()

  return (
    <div className={`${fieldBaseClass} ${BASE}-field`} style={mergeFieldStyles(field)}>
      <FieldLabel label={field.label} path={path} />
      <FindingTarget
        finding={{
          collectionSlug: value('collectionSlug'),
          documentId: value('documentId'),
          kind: value('kind') as Finding['kind'],
          objectKey: value('objectKey'),
          ref: value('ref'),
        }}
      />
    </div>
  )
}

export const StatusField: React.FC<RadioFieldClientProps> = (props) => {
  const { value } = useField<string>({ path: props.path })
  const deleted = value === 'deleted'
  const options = props.field.options.filter(
    (option) => ((typeof option === 'string' ? option : option.value) === 'deleted') === deleted,
  )

  return <RadioGroupField {...props} field={{ ...props.field, options }} readOnly={deleted || props.readOnly} />
}

export const StatusDescription = ({ path }: RadioFieldDescriptionClientProps) => {
  const { t } = useTranslation()
  const { value } = useFinding()
  const missing = value('kind') === 'missing'

  if (!missing && value('status') === 'deleted') return null

  return (
    <FieldDescription
      description={(t as Translate)(missing ? `${PLUGIN_NAME}:missingHint` : `${PLUGIN_NAME}:statusHint`)}
      path={path}
    />
  )
}

const SUMMARY = 'janitor-summary'

const SUMMARIES = {
  missing: {
    icon: <CircledXIcon size={24} />,
    text: `${PLUGIN_NAME}:summaryMissing`,
    title: `${PLUGIN_NAME}:brokenUpload`,
  },
  orphan: {
    icon: <DocumentIcon />,
    text: `${PLUGIN_NAME}:summaryOrphan`,
    title: `${PLUGIN_NAME}:orphanedFile`,
  },
  unused: {
    icon: <LinkIcon />,
    text: `${PLUGIN_NAME}:summaryUnused`,
    title: `${PLUGIN_NAME}:unreferencedDocument`,
  },
}

export const FindingSummary: React.FC<UIFieldClientProps> = () => {
  const { i18n, t } = useTranslation()
  const translate = t as Translate
  const { fields, value } = useFinding()
  const kind = value('kind') as Finding['kind']
  const { entity, label: collection } = useCollectionLabel(value('collectionSlug') ?? '')
  const summary = kind && SUMMARIES[kind]

  if (!summary) return null

  const text = kind === 'unused' && entity?.upload ? `${PLUGIN_NAME}:summaryUnusedFile` : summary.text
  const size = fields.size?.value
  const target: Finding = {
    collectionSlug: value('collectionSlug'),
    documentId: value('documentId'),
    kind,
    objectKey: value('objectKey'),
    ref: value('ref'),
  }
  const facts = (
    [
      [`${PLUGIN_NAME}:collection`, collection],
      [`${PLUGIN_NAME}:size`, typeof size === 'number' ? bytesOf(size, i18n.language) : ''],
      ['general:createdAt', agoOf(value('createdAt'), i18n.language)],
      ['general:deletedAt', value('status') === 'deleted' ? agoOf(value('purgedAt'), i18n.language) : ''],
    ] as const
  ).filter(([, fact]) => fact)

  return (
    <section className={`${fieldBaseClass} ${SUMMARY}${kind === 'missing' ? ` ${SUMMARY}--danger` : ''}`}>
      <header className={`${SUMMARY}__header`}>
        <span aria-hidden="true" className={`${SUMMARY}__icon`}>
          {summary.icon}
        </span>
        <div className={`${SUMMARY}__heading`}>
          <h3 className={`${SUMMARY}__title`}>{translate(summary.title)}</h3>
          <p className={`${SUMMARY}__text`}>{translate(text, { collection })}</p>
        </div>
      </header>
      <dl className={`${SUMMARY}__facts`}>
        {facts.map(([key, fact]) => (
          <div className={`${SUMMARY}__fact`} key={key}>
            <dt>{translate(key)}</dt>
            <dd>{fact}</dd>
          </div>
        ))}
      </dl>
      {(target.documentId || linkOf(target.ref)) && (
        <footer className={`${SUMMARY}__target`}>
          <FindingTarget finding={target} />
        </footer>
      )}
    </section>
  )
}

export const FindingUsage: React.FC<{ endpointsPath?: string } & JSONFieldClientProps> = ({
  endpointsPath,
  field,
  path,
}) => {
  const { t } = useTranslation()
  const translate = t as Translate
  const { fields, value } = useFinding()
  const snapshot = (Array.isArray(fields[path]?.value) ? fields[path]?.value : []) as UsageRef[]
  const collectionSlug = value('collectionSlug')
  const id = value('documentId')

  return (
    <div className={`${fieldBaseClass} ${BASE}-field`} style={mergeFieldStyles(field)}>
      {endpointsPath && collectionSlug && id ? (
        <UsagePanel endpointsPath={endpointsPath} collectionSlug={collectionSlug} id={id} />
      ) : (
        <FieldLabel label={field.label} path={path} />
      )}
      {snapshot.length > 0 && (
        <div className={`${BASE}__snapshot`}>
          <span className="field-description">{translate(`${PLUGIN_NAME}:snapshot`)}</span>
          <ul className={`${BASE}__refs`}>
            {snapshot.map((ref) => (
              <li className={`${BASE}__ref`} key={`${ref.table}.${ref.column}`}>
                <code>{`${ref.table}.${ref.column}`}</code>
                {ref.count > 1 && <span className={`${BASE}__meta`}>{`×${ref.count}`}</span>}
                {ref.versions && (
                  <Pill pillStyle="light-gray" size="small">
                    {translate(`${PLUGIN_NAME}:version`)}
                  </Pill>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
