import { withPayload } from '@payloadcms/next/withPayload'

export default withPayload({
  experimental: { extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } },
  reactStrictMode: true,
})
