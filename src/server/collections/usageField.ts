import type { UIField } from 'payload'

import { DEFAULT_ENDPOINTS_PATH } from '@/shared/constants.js'
import { label } from '@/shared/translations/index.js'
import type { UsageFieldOptions } from '@/shared/types/options.js'

export const usageField = (options: UsageFieldOptions = {}): UIField => {
  return {
    label: label('label'),
    ...options.overrides,
    name: 'janitorUsage',
    type: 'ui',
    admin: {
      ...options.overrides?.admin,
      components: {
        ...options.overrides?.admin?.components,
        Field: {
          clientProps: { endpointsPath: options.endpointsPath ?? DEFAULT_ENDPOINTS_PATH, limit: options.limit ?? 0 },
          path: '@seshuk/payload-plugin-janitor/client#UsagePanel',
        },
      },
      position: options.position === 'sidebar' || !options.position ? 'sidebar' : undefined,
    },
  }
}
