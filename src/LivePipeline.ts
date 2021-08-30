import { isEqual } from 'lodash'
import { texts } from '@textshq/platform-sdk'

import type TwitterAPI from './network-api'

const { IS_DEV, Sentry } = texts

export default class LivePipeline {
  private livePipelineID: string = null

  private subbedTopics: string[] = []

  private es: EventSource

  private subTimeout: NodeJS.Timeout

  private subTtlMs = 120_000

  constructor(
    private readonly api: TwitterAPI,
    private readonly onLiveEvent: (json: any) => void,
  ) {}

  setup() {
    this.es?.close()
    this.es = this.api.live_pipeline_events(this.subbedTopics.join(','))
    if (!this.es) return
    this.es.onopen = event => {
      if (IS_DEV) console.log(new Date(), 'es open', event)
    }
    this.es.onmessage = event => {
      if (!event.data.startsWith('{')) {
        if (IS_DEV) console.log('unknown data', event.data)
        return
      }
      const json = JSON.parse(event.data)
      if (IS_DEV) console.log(new Date(), 'es', json)
      if (json.topic === '/system/config') {
        const { session_id, subscription_ttl_millis } = json.payload.config
        this.subTtlMs = subscription_ttl_millis
        this.livePipelineID = session_id
      } else {
        this.onLiveEvent(json)
      }
    }
    let errorCount = 0
    this.es.onerror = event => {
      if (this.es.readyState === this.es.CLOSED) {
        texts.error('[twitter]', new Date(), 'es closed, reconnecting')
        Sentry.captureMessage(`twitter es reconnecting ${this.es.readyState}`)
        this.setup()
      }
      texts.error('[twitter]', new Date(), 'es error', event, ++errorCount)
    }
  }

  async updateSubscriptions(unsubTopics: string[] = []) {
    clearTimeout(this.subTimeout)
    if (IS_DEV) {
      console.log('updating subscriptions', this.subbedTopics, unsubTopics)
    }
    if (this.subbedTopics.length === 0 && unsubTopics.length === 0) return
    const { errors } = await this.api.live_pipeline_update_subscriptions(this.livePipelineID, this.subbedTopics, unsubTopics) || {}
    // [ { code: 392, message: 'Session not found.' } ]
    if (errors?.[0].code === 392) {
      this.setup()
    }
    this.subTimeout = setTimeout(() => this.updateSubscriptions(), this.subTtlMs - 10)
  }

  setSubscriptions(subscribeTo: string[]) {
    if (!this.livePipelineID) return
    if (isEqual(subscribeTo, this.subbedTopics)) return
    const unsubTopics = [...this.subbedTopics]
    this.subbedTopics = subscribeTo
    this.updateSubscriptions(unsubTopics)
  }

  dispose() {
    this.es?.close()
    this.es = null
  }
}
