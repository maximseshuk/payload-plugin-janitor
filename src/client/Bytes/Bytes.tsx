'use client'

import { mergeFieldStyles, TextInput, useField, useTranslation } from '@payloadcms/ui'
import type { DefaultCellComponentProps, NumberFieldClientProps } from 'payload'
import React from 'react'

import { bytesOf, localeOf } from '@/client/findingData.js'

export const BytesCell: React.FC<DefaultCellComponentProps> = ({ cellData }) => {
  const { i18n } = useTranslation()

  return <span>{bytesOf(cellData, i18n.language)}</span>
}

export const BytesField: React.FC<NumberFieldClientProps> = ({ field, path }) => {
  const { i18n } = useTranslation()
  const { value } = useField<number>({ path })

  return (
    <TextInput
      label={field.label}
      path={path}
      readOnly
      style={mergeFieldStyles(field)}
      value={bytesOf(value, i18n.language)}
    />
  )
}

export const CountCell: React.FC<DefaultCellComponentProps> = ({ cellData }) => {
  const { i18n } = useTranslation()

  return (
    <span>{typeof cellData === 'number' ? new Intl.NumberFormat(localeOf(i18n.language)).format(cellData) : ''}</span>
  )
}
