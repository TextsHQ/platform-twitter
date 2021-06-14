import { v4 as uuid } from 'uuid'
import EventSource from 'eventsource'
import { Client as HttpClient, RequestOptions } from 'rust-fetch'
import { CookieJar, Cookie } from 'tough-cookie'
import FormData from 'form-data'
import crypto from 'crypto'
import util from 'util'
import { isEqual } from 'lodash'
import { texts, ReAuthError, RateLimitError } from '@textshq/platform-sdk'

import { chunkBuffer, promiseDelay } from './util'

const { constants, IS_DEV, Sentry } = texts
const { USER_AGENT } = constants

const randomBytes = util.promisify(crypto.randomBytes)

const AUTHORIZATION = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'

const commonHeaders = {
  'Accept-Language': 'en',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'User-Agent': USER_AGENT,
}

const staticFetchHeaders = {
  Authorization: AUTHORIZATION,
  Accept: '*/*',
  'x-twitter-active-user': 'yes',
  'x-twitter-auth-type': 'OAuth2Session',
  'x-twitter-client-language': 'en',
}

const commonParams = {
  include_profile_interstitial_type: '1',
  include_blocking: '1',
  include_blocked_by: '1',
  include_followed_by: '1',
  include_want_retweets: '1',
  include_mute_edge: '1',
  include_can_dm: '1',
  include_can_media_tag: '1',
  skip_status: '1',
}

const commonDMParams = {
  cards_platform: 'Web-12',
  include_cards: '1',
  include_composer_source: 'true',
  include_ext_alt_text: 'true',
  include_reply_count: '1',
  tweet_mode: 'extended',
  dm_users: 'false',
  include_groups: 'true',
  include_inbox_timelines: 'true',
  include_ext_media_color: 'true',
  supports_reactions: 'true',
}

enum MEDIA_CATEGORY {
  DM_IMAGE = 'dm_image',
  DM_VIDEO = 'dm_video',
  DM_GIF = 'dm_gif',
}

const EXT = 'mediaColor,altText,mediaStats,highlightedLabel,cameraMoment'

const ENDPOINT = 'https://api.twitter.com/'
const UPLOAD_ENDPOINT = 'https://upload.twitter.com/'
const MAX_CHUNK_SIZE = 1 * 1024 * 1024

const genCSRFToken = () =>
  randomBytes(16).then(b => b.toString('hex'))

const CT0_MAX_AGE = 6 * 60 * 60

// [ { code: 130, message: 'Over capacity' } ]
// [ { code: 392, message: 'Session not found.' } ]
// [ { code: 88, message: 'Rate limit exceeded.' } ]
const IGNORED_ERRORS = [130, 392]

function handleErrors(url: string, statusCode: number, json: any) {
  // { errors: [ { code: 32, message: 'Could not authenticate you.' } ] }
  const errors = json.errors as { code: number, message: string }[]
  const loggedOutError = errors.find(e => e.code === 32)
  if (loggedOutError) {
    throw new ReAuthError(loggedOutError!.message)
    // todo track reauth event
  }
  console.log(url, statusCode, json.errors)
  const filteredErrors = errors.filter(err => !IGNORED_ERRORS.includes(err.code))
  if (filteredErrors.length > 0) {
    Sentry.captureException(Error(url), {
      extra: {
        errors: json.errors,
      },
    })
  }
}

function getMediaCategory(mimeType: string) {
  if (mimeType === 'image/gif') return MEDIA_CATEGORY.DM_GIF
  if (mimeType.startsWith('image')) return MEDIA_CATEGORY.DM_IMAGE
  if (mimeType.startsWith('video')) return MEDIA_CATEGORY.DM_VIDEO
}

export default class TwitterAPI {
  private csrfToken: string = ''

  cookieJar: CookieJar = null

  httpClient: HttpClient = new HttpClient()

  // private twitterBlocked = false

  setCSRFTokenCookie = async () => {
    const cookies = this.cookieJar.getCookiesSync('https://twitter.com/')
    this.csrfToken = cookies.find(c => c.key === 'ct0')?.value
    if (!this.csrfToken) {
      this.csrfToken = await genCSRFToken()
      const cookie = new Cookie({ key: 'ct0', value: this.csrfToken, secure: true, hostOnly: false, domain: 'twitter.com', maxAge: CT0_MAX_AGE })
      this.cookieJar.setCookie(cookie, 'https://twitter.com/')
    }
  }

  setLoginState = async (cookieJar: CookieJar) => {
    if (!cookieJar) throw TypeError()
    this.cookieJar = cookieJar
    await this.setCSRFTokenCookie()
  }

  fetch = async (options: RequestOptions & {
    referer?: string
    url: string
    includeHeaders?: boolean
  }) => {
    if (!this.cookieJar) throw new Error('Twitter cookie jar not found')
    if (IS_DEV) console.log('[TW] CALLING', options.url)
    await this.setCSRFTokenCookie()

    options.headers = {
      'x-csrf-token': this.csrfToken,
      ...staticFetchHeaders,
      Referer: options.referer,
      ...commonHeaders,
      ...options.headers,
    }

    options.cookieJar = this.cookieJar

    try {
      const res = await this.httpClient.request(options.url, options)
      if (!res.body) return
      const json = JSON.parse(res.body as string)
      // if (res.statusCode === 429) {
      //   throw new RateLimitError()
      // }
      if (json.errors) {
        handleErrors(options.url, res.statusCode, json)
      }
      if (options.includeHeaders) return { headers: res.headers, json }
      return json
    } catch (err) {
      if (err.code === 'ECONNREFUSED' && (err.message.endsWith('0.0.0.0:443') || err.message.endsWith('127.0.0.1:443'))) {
        console.log('twitter is blocked')
        throw Error('Twitter seems to be blocked on your device. This could have been done by an app or a manual entry in /etc/hosts')
        // this.twitterBlocked = true
        // await resolveHost(url)
        // return this.fetch({ headers, referer, ...rest })
      }
      throw err
    }
  }

  authenticatedGet = async (url: string) => {
    if (!this.cookieJar) throw new Error('Not authorized')
    await this.setCSRFTokenCookie()
    const res = await texts.fetch(url, {
      cookieJar: this.cookieJar,
      headers: {
        Accept: 'image/webp,image/apng,image/*,*/*;q=0.8', // todo review for videos
        Referer: 'https://twitter.com/messages/',
        ...commonHeaders,
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'same-site',
      },
    })
    return res.body
  }

  media_upload_init = (referer: string, totalBytes: number, mimeType: string, mediaCategory = getMediaCategory(mimeType)) =>
    this.fetch({
      method: 'POST',
      url: `${UPLOAD_ENDPOINT}i/media/upload.json`,
      searchParams: {
        command: 'INIT',
        total_bytes: totalBytes,
        // instead of total_bytes can have source_url: 'https://media1.giphy.com/media/v1.Y2lkPWU4MjZjOWZjOWUyY2FlY2QzMWJmZjFkODAyOWU0ZDEzN2JkMGYwOGZhZTQ3MjJkMQ/NEvPzZ8bd1V4Y/giphy.gif'
        media_type: mimeType,
        media_category: mediaCategory,
      },
      referer,
    })

  media_upload_append = (referer: string, mediaID: string, multipart: FormData, segment_index: number) =>
    this.fetch({
      method: 'POST',
      url: `${UPLOAD_ENDPOINT}i/media/upload.json`,
      searchParams: {
        command: 'APPEND',
        media_id: mediaID,
        segment_index,
      },
      multipart,
      referer,
    })

  media_upload_finalize = (referer: string, mediaID: string) =>
    this.fetch({
      method: 'POST',
      url: `${UPLOAD_ENDPOINT}i/media/upload.json`,
      searchParams: {
        command: 'FINALIZE',
        media_id: mediaID,
      },
      referer,
    })

  media_upload_status = (referer: string, mediaID: string) =>
    this.fetch({
      method: 'GET',
      url: `${UPLOAD_ENDPOINT}i/media/upload.json`,
      searchParams: {
        command: 'STATUS',
        media_id: mediaID,
      },
      referer,
    })

  waitForProcessing = async (finalizeResponse: any, mediaID: string, referer: string) => {
    if (!finalizeResponse.processing_info) return
    const PROCESSING_TIMEOUT = 20_000
    let pi = finalizeResponse.processing_info
    const start = Date.now()
    while (pi?.state === 'pending' || pi?.state === 'in_progress') {
      if ((Date.now() - start) > PROCESSING_TIMEOUT) throw Error('media processing taking longer than expected')
      const wait = pi.check_after_secs * 1000
      if (IS_DEV) console.log(`waiting ${wait}ms for ${mediaID}`)
      await promiseDelay(wait)
      const statusResponse = await this.media_upload_status(referer, mediaID)
      if (IS_DEV) console.log('media_upload_status', statusResponse)
      pi = statusResponse.processing_info
    }
  }

  upload = async (threadID: string, buffer: Buffer, mimeType: string): Promise<string> => {
    const totalBytes = buffer.length
    const referer = `https://twitter.com/messages/${threadID}`
    const initResponse = await this.media_upload_init(referer, totalBytes, mimeType)
    if (IS_DEV) console.log('media_upload_init', { referer, totalBytes, mimeType }, initResponse)
    if (initResponse.error) throw Error(`media_upload_init error: ${initResponse.error}`)
    const { media_id_string: mediaID } = initResponse
    if (!mediaID) return
    let checksum = 0
    for (const [chunkIndex, chunk] of chunkBuffer(buffer, MAX_CHUNK_SIZE)) {
      const form = new FormData()
      form.append('media', chunk)
      checksum += chunk.length
      await this.media_upload_append(referer, mediaID, form, chunkIndex)
    }
    if (checksum !== buffer.length) throw Error(`assertion failed: ${checksum} !== ${buffer.length}`)
    const finalizeResponse = await this.media_upload_finalize(referer, mediaID)
    if (IS_DEV) console.log('media_upload_finalize', finalizeResponse)
    if (finalizeResponse.error) throw Error(`media_upload_finalize error: ${finalizeResponse.error}`)
    await this.waitForProcessing(finalizeResponse, mediaID, referer)
    return mediaID
  }

  live_pipeline_events = (topic = '') => this.cookieJar
    && new EventSource(ENDPOINT + 'live_pipeline/events?topic=' + encodeURIComponent(topic), {
      headers: {
        Cookie: this.cookieJar.getCookieStringSync(ENDPOINT),
        ...commonHeaders,
      },
    })

  live_pipeline_update_subscriptions = (sessionID: string, subTopics: string[], unsubTopics: string[]) =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/live_pipeline/update_subscriptions`,
      referer: 'https://twitter.com/',
      headers: {
        'livepipeline-session': sessionID,
      },
      form: {
        sub_topics: subTopics.join(','),
        unsub_topics: unsubTopics.join(','),
      },
    })

  account_verify_credentials = () =>
    this.fetch({
      url: `${ENDPOINT}1.1/account/verify_credentials.json`,
      referer: 'https://twitter.com/',
    })

  account_logout = () =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/account/logout.json`,
      referer: 'https://twitter.com/logout',
    })

  typeahead = (q: string) =>
    this.fetch({
      url: `${ENDPOINT}1.1/search/typeahead.json`,
      searchParams: {
        q,
        src: 'compose_message',
        result_type: 'users',
      },
      referer: 'https://twitter.com/messages/compose',
    })

  dm_new = (text: string, threadID: string, generatedMsgID: string, mediaID: string = undefined, includeLinkPreview = true) => {
    const form = {
      ...commonDMParams,
      text,
      conversation_id: threadID,
      media_id: mediaID,
      recipient_ids: 'false',
      request_id: (generatedMsgID || uuid()).toUpperCase(),
      ext: EXT,
      ...(includeLinkPreview ? {} : { card_uri: 'tombstone://card' }),
    }
    if (!form.media_id) delete form.media_id
    return this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/dm/new.json`,
      referer: `https://twitter.com/messages/${threadID}`,
      form,
    })
  }

  dm_destroy = (threadID: string, messageID: string) =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/dm/destroy.json`,
      referer: `https://twitter.com/messages/${threadID}`,
      form: {
        ...commonDMParams,
        id: messageID,
        request_id: uuid().toUpperCase(),
      },
    })

  dm_conversation_thread = (threadID: string, pagination: { min_id?: string, max_id?: string }) => {
    const searchParams = {
      ...commonParams,
      ...commonDMParams,
      include_conversation_info: 'true',
      ...pagination,
      context: 'FETCH_DM_CONVERSATION',
      ext: EXT,
    }
    return this.fetch({
      url: `${ENDPOINT}1.1/dm/conversation/${threadID}.json`,
      referer: `https://twitter.com/messages/${threadID}`,
      searchParams,
    })
  }

  dm_conversation = (participantIDs: string[]) => {
    const searchParams = {
      ...commonParams,
      ...commonDMParams,
      include_conversation_info: 'true',
      participant_ids: participantIDs.join(','),
    }
    return this.fetch({
      url: 'https://api.twitter.com/1.1/dm/conversation.json',
      referer: 'https://twitter.com/messages/compose',
      searchParams,
    })
  }

  dm_inbox_initial_state = () =>
    this.fetch({
      url: `${ENDPOINT}1.1/dm/inbox_initial_state.json`,
      referer: 'https://twitter.com/messages',
      searchParams: {
        ...commonParams,
        ...commonDMParams,
        filter_low_quality: 'false',
        ext: EXT,
      },
    })

  dm_inbox_timeline = (inboxType: string, pagination: { min_id?: string, max_id?: string }) =>
    this.fetch({
      url: `${ENDPOINT}1.1/dm/inbox_timeline/${inboxType}.json`,
      referer: 'https://twitter.com/messages',
      searchParams: {
        ...commonParams,
        ...commonDMParams,
        filter_low_quality: 'false',
        ...pagination,
        ext: EXT,
      },
    })

  dm_user_updates = (cursor: string) =>
    this.fetch({
      includeHeaders: true,
      url: `${ENDPOINT}1.1/dm/user_updates.json`,
      referer: 'https://twitter.com/messages',
      headers: {
        'x-twitter-polling': 'true',
      },
      searchParams: {
        ...commonDMParams,
        cursor,
        filter_low_quality: 'false',
        ext: EXT,
      },
    })

  dm_update_last_seen_event_id = ({ last_seen_event_id, trusted_last_seen_event_id, untrusted_last_seen_event_id }) =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/dm/update_last_seen_event_id.json`,
      referer: 'https://twitter.com/messages',
      form: {
        last_seen_event_id,
        trusted_last_seen_event_id,
        untrusted_last_seen_event_id,
      },
    })

  dm_reaction = (action: string, reactionKey: string, threadID: string, messageID: string) =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/dm/reaction/${action}.json`,
      referer: `https://twitter.com/messages/${threadID}`,
      searchParams: {
        reaction_key: reactionKey,
        conversation_id: threadID,
        dm_id: messageID,
      },
    })

  dm_reaction_new = (reactionKey: string, threadID: string, messageID: string) =>
    this.dm_reaction('new', reactionKey, threadID, messageID)

  dm_reaction_delete = (reactionKey: string, threadID: string, messageID: string) =>
    this.dm_reaction('delete', reactionKey, threadID, messageID)

  dm_conversation_mark_read = (threadID: string, messageID: string) =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/dm/conversation/${threadID}/mark_read.json`,
      referer: `https://twitter.com/messages/${threadID}`,
      form: {
        conversationId: threadID,
        last_read_event_id: messageID,
      },
    })

  dm_conversation_typing = (threadID: string) =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/dm/conversation/${threadID}/typing.json`,
      referer: `https://twitter.com/messages/${threadID}`,
    })

  dm_conversation_delete = (threadID: string) =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/dm/conversation/${threadID}/delete.json`,
      referer: `https://twitter.com/messages/${threadID}`,
      form: commonDMParams,
    })

  dm_conversation_update_name = (threadID: string, title: string) =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/dm/conversation/${threadID}/update_name.json`,
      referer: `https://twitter.com/messages/${threadID}/group-info`,
      form: {
        name: title,
      },
    })

  dm_conversation_update_avatar = (threadID: string, avatarID: string) =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/dm/conversation/${threadID}/update_avatar.json`,
      referer: `https://twitter.com/messages/${threadID}/group-info`,
      form: {
        avatar_id: avatarID,
      },
    })

  dm_conversation_add_participants = (threadID: string, participantIDs: string[]) =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/dm/conversation/${threadID}/add_participants.json`,
      referer: `https://twitter.com/messages/${threadID}/group-info`,
      form: {
        participant_ids: participantIDs.join(','),
      },
    })

  dm_conversation_disable_notifications = (threadID: string, duration = 0) =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/dm/conversation/${threadID}/disable_notifications.json`,
      referer: `https://twitter.com/messages/${threadID}`,
      form: { duration },
    })

  dm_conversation_enable_notifications = (threadID: string) =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/dm/conversation/${threadID}/enable_notifications.json`,
      referer: `https://twitter.com/messages/${threadID}`,
      form: {},
    })

  cards_preview = (linkURL: string) =>
    this.fetch({
      method: 'POST',
      url: 'https://caps.twitter.com/v2/cards/preview.json',
      referer: 'https://twitter.com/',
      searchParams: {
        status: linkURL,
        cards_platform: 'Web-12',
        include_cards: 'true',
      },
    })
}

export class LivePipeline {
  private readonly api: TwitterAPI

  private readonly onLiveEvent: (json: any) => void

  private livePipelineID: string = null

  private subbedTopics: string[] = []

  private es: EventSource

  private subTimeout: NodeJS.Timeout

  private subTtlMs = 120_000

  constructor(api: TwitterAPI, onLiveEvent: (json: any) => void) {
    this.api = api
    this.onLiveEvent = onLiveEvent
  }

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
