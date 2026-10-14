import config from '@payload-config'
import { GRAPHQL_POST, REST_OPTIONS } from '@payloadcms/next/routes'

export const OPTIONS = REST_OPTIONS(config)
export const POST = GRAPHQL_POST(config)
