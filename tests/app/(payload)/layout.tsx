import type { ServerFunctionClient } from 'payload'

import config from '@payload-config'
import '@payloadcms/next/css'
import { generatePayloadViewport, handleServerFunctions, RootLayout } from '@payloadcms/next/layouts'
import React from 'react'

import { importMap } from './admin/importMap.js'

import './custom.css'

export const generateViewport = generatePayloadViewport

const serverFunction: ServerFunctionClient = async (args) => {
  'use server'

  return handleServerFunctions({ ...args, config, importMap })
}

const Layout = ({ children }: { children: React.ReactNode }) => (
  <RootLayout config={config} importMap={importMap} serverFunction={serverFunction}>
    {children}
  </RootLayout>
)

export default Layout
