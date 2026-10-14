import { describe } from 'vitest'

import { contract, gcs } from '../../helpers/storage.js'

describe('gcs adapter', () => {
  contract(gcs)
})
