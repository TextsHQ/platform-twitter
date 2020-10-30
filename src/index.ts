import type { Platform } from '@textshq/platform-sdk'

export default {
  get info() {
    return require('./info')
  },

  get api() {
    return require('./api')
  },
} as Platform
