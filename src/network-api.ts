import crypto, { randomUUID as uuid } from 'crypto'
import EventSource from 'eventsource'
import { CookieJar, Cookie } from 'tough-cookie'
import FormData from 'form-data'
import { setTimeout as setTimeoutAsync } from 'timers/promises'
import util from 'util'
import { texts, ReAuthError, FetchOptions, RateLimitError } from '@textshq/platform-sdk'

import { TwitterError } from './errors'
import { chunkBuffer } from './util'

const { constants, Sentry } = texts
const { USER_AGENT } = constants

const randomBytes = util.promisify(crypto.randomBytes)

const AUTHORIZATION = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'

const MAX_RETRY_COUNT = 5

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
  'X-Twitter-Active-User': 'yes',
  'X-Twitter-Auth-Type': 'OAuth2Session',
  'X-Twitter-Client-Language': 'en',
  'Sec-Ch-Ua': '"Chromium";v="105", "Google Chrome";v="105", "Not;A=Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
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

const enum MEDIA_CATEGORY {
  DM_IMAGE = 'dm_image',
  DM_VIDEO = 'dm_video',
  DM_GIF = 'dm_gif',
}

const EXT = 'mediaColor,altText,mediaStats,highlightedLabel,cameraMoment'

const API_ENDPOINT = 'https://api.x.com/'
const UPLOAD_ENDPOINT = 'https://upload.x.com/'
const GRAPHQL_ENDPOINT = 'https://x.com/i/api/graphql/'
const NOTIFICATIONS_URL = 'https://x.com/notifications'
const MAX_CHUNK_SIZE = 1 * 1024 * 1024

const genCSRFToken = () =>
  randomBytes(80).then(b => b.toString('hex'))

const CT0_MAX_AGE = 6 * 60 * 60

// [ { code: 130, message: 'Over capacity' } ]
// [ { code: 392, message: 'Session not found.' } ]
// [ { code: 88, message: 'Rate limit exceeded.' } ]
const SENTRY_IGNORED_ERRORS = [TwitterError.OverCapacity, TwitterError.SessionNotFound, TwitterError.RateLimitExceeded]

function handleErrors(url: string, statusCode: number, json: any) {
  const errors = json.errors as { code: number, message: string }[]
  const loggedOutError = errors.find(e => e.code === TwitterError.LoggedOut)
  if (loggedOutError) {
    throw new ReAuthError(loggedOutError!.message)
    // todo track reauth event
  }
  if (errors) {
    throw Error(errors.map(e => `${e.code}: ${e.message}`).join(', '))
  }
  texts.log(url, statusCode, json.errors)
  const filteredErrors = errors.filter(err => !SENTRY_IGNORED_ERRORS.includes(err.code))
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

function normalizeReaction(reaction: string) {
  return reaction[0].toUpperCase() + reaction.slice(1)
}

export default class TwitterAPI {
  private csrfToken = ''

  clientUUID?: string

  cookieJar: CookieJar = null

  httpClient = texts.createHttpClient()

  // private twitterBlocked = false

  setCSRFTokenCookie = async () => {
    const cookies = this.cookieJar.getCookiesSync('https://x.com/')
    this.csrfToken = cookies.find(c => c.key === 'ct0')?.value
    if (!this.csrfToken) {
      this.csrfToken = await genCSRFToken()
      const cookie = new Cookie({ key: 'ct0', value: this.csrfToken, secure: true, hostOnly: false, domain: 'x.com', maxAge: CT0_MAX_AGE })
      this.cookieJar.setCookie(cookie, 'https://x.com/')
    }
  }

  setLoginState = async (cookieJar: CookieJar) => {
    if (!cookieJar) throw TypeError()
    this.cookieJar = cookieJar
    await this.setCSRFTokenCookie()
  }

  fetch = async (options: FetchOptions & {
    referer?: string
    url: string
    includeHeaders?: boolean
    dontThrow?: boolean
  }, retryNumber = 0) => {
    if (!this.cookieJar) throw new Error('Twitter cookie jar not found')
    // if (IS_DEV) console.log('[TW] CALLING', options.url)
    await this.setCSRFTokenCookie()

    options.headers = {
      'x-csrf-token': this.csrfToken,
      'x-client-uuid': this.clientUUID,
      ...staticFetchHeaders,
      Referer: options.referer,
      ...commonHeaders,
      ...options.headers,
    }

    options.cookieJar = this.cookieJar

    try {
      const res = await this.httpClient.requestAsString(options.url, options)
      if (res.statusCode === 429) throw new RateLimitError()
      if (!res.body) {
        if (res.statusCode === 204) return
        throw Error('falsey body')
      }
      const json = JSON.parse(res.body)
      if (json.errors) {
        if (retryNumber < MAX_RETRY_COUNT && json.errors[0]?.code === TwitterError.OverCapacity) {
          texts.log('[tw] retrying bc over capacity', { retryNumber }, options.url)
          await setTimeoutAsync(100 * retryNumber)
          return this.fetch(options, retryNumber + 1)
        }
        if (!options.dontThrow) handleErrors(options.url, res.statusCode, json)
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

  private readonly gqlMutation = async (variables: object, queryId: string, mutationName: string, fetchOptions: Partial<ReturnType<typeof this.fetch>> = {}, bodyExtras?: object) =>
    this.fetch({
      method: 'POST',
      url: `${GRAPHQL_ENDPOINT}${queryId}/${mutationName}`,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        variables: JSON.stringify(variables),
        ...bodyExtras,
        queryId,
      }),
      referer: 'https://x.com/',
      ...fetchOptions,
    })

  private readonly gqlQuery = async (variables: object, queryId: string, queryName: string, fetchOptions: Partial<ReturnType<typeof this.fetch>> = {}, extraSearchParams: object = {}) =>
    this.fetch({
      method: 'GET',
      url: `${GRAPHQL_ENDPOINT}${queryId}/${queryName}?` + new URLSearchParams({ variables: JSON.stringify(variables), ...extraSearchParams }).toString(),
      headers: {
        'Content-Type': 'application/json',
      },
      referer: 'https://x.com/',
      ...fetchOptions,
    })

  authenticatedGet = async (url: string) => {
    if (!this.cookieJar) throw new Error('Not authorized')
    await this.setCSRFTokenCookie()
    const parsed = new URL(url)
    parsed.hostname = parsed.hostname.replace('twitter.com', 'x.com')
    const res = await this.httpClient.requestAsBuffer(parsed.toString(), {
      cookieJar: this.cookieJar,
      headers: {
        Accept: 'image/webp,image/apng,image/*,*/*;q=0.8', // todo review for videos
        Referer: 'https://x.com/messages/',
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

  media_upload_append = (referer: string, mediaID: string, body: FormData, segment_index: number) =>
    this.fetch({
      method: 'POST',
      url: `${UPLOAD_ENDPOINT}i/media/upload.json`,
      searchParams: {
        command: 'APPEND',
        media_id: mediaID,
        segment_index,
      },
      body,
      referer,
    })

  media_upload_finalize = (referer: string, mediaID: string, original_md5: string) =>
    this.fetch({
      method: 'POST',
      url: `${UPLOAD_ENDPOINT}i/media/upload.json`,
      searchParams: {
        command: 'FINALIZE',
        media_id: mediaID,
        original_md5,
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
      texts.log(`waiting ${wait}ms for ${mediaID}`)
      await setTimeoutAsync(wait)
      const statusResponse = await this.media_upload_status(referer, mediaID)
      texts.log('media_upload_status', statusResponse)
      pi = statusResponse.processing_info
    }
  }

  upload = async (threadID: string, buffer: Buffer, mimeType: string): Promise<string> => {
    const totalBytes = buffer.length
    const referer = `https://x.com/messages/${threadID}`
    const initResponse = await this.media_upload_init(referer, totalBytes, mimeType)
    texts.log('media_upload_init', { referer, totalBytes, mimeType }, initResponse)
    if (initResponse.error) throw Error(`media_upload_init error: ${initResponse.error}`)
    const { media_id_string: mediaID } = initResponse
    if (!mediaID) return
    let checksum = 0
    const md5 = crypto.createHash('md5').update(buffer).digest('hex')
    for (const [chunkIndex, chunk] of chunkBuffer(buffer, MAX_CHUNK_SIZE)) {
      const form = new FormData()
      form.append('media', chunk)
      checksum += chunk.length
      const appendRes = await this.media_upload_append(referer, mediaID, form, chunkIndex)
      texts.log('media_upload_append', chunk.length, appendRes)
      if (appendRes?.error) throw Error(`media_upload_append error: ${appendRes.error}`)
    }
    if (checksum !== buffer.length) throw Error(`assertion failed: ${checksum} !== ${buffer.length}`)
    const finalizeResponse = await this.media_upload_finalize(referer, mediaID, md5)
    texts.log('media_upload_finalize', finalizeResponse)
    if (finalizeResponse.error) throw Error(`media_upload_finalize error: ${finalizeResponse.error}`)
    await this.waitForProcessing(finalizeResponse, mediaID, referer)
    return mediaID
  }

  live_pipeline_events = (topic = '') => this.cookieJar
    && new EventSource(API_ENDPOINT + 'live_pipeline/events?topic=' + encodeURIComponent(topic), {
      headers: {
        Cookie: this.cookieJar.getCookieStringSync(API_ENDPOINT),
        ...commonHeaders,
      },
    })

  live_pipeline_update_subscriptions = (sessionID: string, subTopics: string[], unsubTopics: string[]) =>
    this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/live_pipeline/update_subscriptions`,
      referer: 'https://x.com/',
      headers: {
        'livepipeline-session': sessionID,
      },
      form: {
        sub_topics: subTopics.join(','),
        unsub_topics: unsubTopics.join(','),
      },
    })

  account_multi_list = () =>
    this.fetch({
      url: `${API_ENDPOINT}1.1/account/multi/list.json`,
      referer: 'https://x.com/',
    })

  account_verify_credentials = () =>
    this.fetch({
      url: `${API_ENDPOINT}1.1/account/verify_credentials.json`,
      referer: 'https://x.com/',
    })

  account_logout = () =>
    this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/account/logout.json`,
      referer: 'https://x.com/logout',
    })

  typeahead = (q: string) =>
    this.fetch({
      url: `${API_ENDPOINT}1.1/search/typeahead.json`,
      searchParams: {
        q,
        src: 'compose_message',
        result_type: 'users',
      },
      referer: 'https://x.com/messages/compose',
    })

  dm_new2({ generatedMsgID, text, threadID, replyID, recipientIDs, mediaID, includeLinkPreview = true }: {
    generatedMsgID?: string
    text: string
    threadID?: string
    replyID?: string
    recipientIDs?: string[]
    mediaID?: string
    includeLinkPreview?: boolean
  }) {
    const body = {
      cards_platform: 'Web-12',
      conversation_id: threadID,
      // dm_users: 'true',
      include_cards: 1,
      include_quote_count: true,
      media_id: mediaID,
      recipient_ids: threadID ? 'false' : recipientIDs.join(','),
      reply_to_dm_id: replyID,
      request_id: (generatedMsgID || uuid()).toUpperCase(),
      ...(includeLinkPreview ? {} : { card_uri: 'tombstone://card' }),
      text,
    }
    return this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/dm/new2.json`,
      referer: `https://x.com/messages/${threadID}`,
      body: JSON.stringify(body),
    })
  }

  dm_destroy = (threadID: string, messageID: string) =>
    this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/dm/destroy.json`,
      referer: `https://x.com/messages/${threadID}`,
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
      url: `${API_ENDPOINT}1.1/dm/conversation/${threadID}.json`,
      referer: `https://x.com/messages/${threadID}`,
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
      url: `${API_ENDPOINT}1.1/dm/conversation.json`,
      referer: 'https://x.com/messages/compose',
      searchParams,
    })
  }

  dm_inbox_initial_state = () =>
    this.fetch({
      url: `${API_ENDPOINT}1.1/dm/inbox_initial_state.json`,
      referer: 'https://x.com/messages',
      searchParams: {
        ...commonParams,
        ...commonDMParams,
        filter_low_quality: 'false',
        ext: EXT,
      },
    })

  dm_inbox_timeline = (inboxType: string, pagination: { min_id?: string, max_id?: string }) =>
    this.fetch({
      url: `${API_ENDPOINT}1.1/dm/inbox_timeline/${inboxType}.json`,
      referer: 'https://x.com/messages',
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
      dontThrow: true,
      includeHeaders: true,
      url: `${API_ENDPOINT}1.1/dm/user_updates.json`,
      referer: 'https://x.com/messages',
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

  dm_update_last_seen_event_id = ({ last_seen_event_id, trusted_last_seen_event_id = undefined, untrusted_last_seen_event_id = undefined }) =>
    this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/dm/update_last_seen_event_id.json`,
      referer: 'https://x.com/messages',
      form: {
        last_seen_event_id,
        trusted_last_seen_event_id,
        untrusted_last_seen_event_id,
      },
    })

  dm_reaction = (reactionKey: string, threadID: string, messageID: string, action: 'new' | 'delete') =>
    this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/dm/reaction/${action}.json`,
      referer: `https://x.com/messages/${threadID}`,
      form: {
        conversation_id: threadID,
        dm_id: messageID,
        emoji_reaction: reactionKey,
        reaction_key: 'emoji',
      },
    })

  dm_conversation_mark_read = (threadID: string, messageID: string) =>
    this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/dm/conversation/${threadID}/mark_read.json`,
      referer: `https://x.com/messages/${threadID}`,
      form: {
        conversationId: threadID,
        last_read_event_id: messageID,
      },
    })

  dm_conversation_typing = async (threadID: string) => {
    const response = await this.gqlMutation({
      conversationId: threadID,
    }, 'HL96-xZ3Y81IEzAdczDokg', 'useTypingNotifierMutation')
    if (response?.data?.post_typing_indicator?.__typename === 'TypingIndicatorSuccess') return true
    // throw new Error(`[tw] dm_conversation_typing failed: ${JSON.stringify(response)}`)
  }

  dm_conversation_delete = (threadID: string) =>
    this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/dm/conversation/${threadID}/delete.json`,
      referer: `https://x.com/messages/${threadID}`,
      form: commonDMParams,
    })

  dm_conversation_update_name = (threadID: string, title: string) =>
    this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/dm/conversation/${threadID}/update_name.json`,
      referer: `https://x.com/messages/${threadID}/group-info`,
      form: {
        name: title,
      },
    })

  dm_conversation_update_avatar = (threadID: string, avatarID: string) =>
    this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/dm/conversation/${threadID}/update_avatar.json`,
      referer: `https://x.com/messages/${threadID}/group-info`,
      form: {
        avatar_id: avatarID,
      },
    })

  dm_conversation_add_participants = (threadID: string, participantIDs: string[]) =>
    this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/dm/conversation/${threadID}/add_participants.json`,
      referer: `https://x.com/messages/${threadID}/group-info`,
      form: {
        participant_ids: participantIDs.join(','),
      },
    })

  dm_conversation_disable_notifications = (threadID: string, duration = 0) =>
    this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/dm/conversation/${threadID}/disable_notifications.json`,
      referer: `https://x.com/messages/${threadID}`,
      form: { duration },
    })

  dm_conversation_enable_notifications = (threadID: string) =>
    this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/dm/conversation/${threadID}/enable_notifications.json`,
      referer: `https://x.com/messages/${threadID}`,
      form: {},
    })

  dm_conversation_accept = (threadID: string) =>
    this.fetch({
      method: 'POST',
      url: `${API_ENDPOINT}1.1/dm/conversation/${threadID}/accept.json`,
      referer: `https://x.com/messages/${threadID}`,
      form: {},
    })

  cards_preview = (linkURL: string) =>
    this.fetch({
      method: 'POST',
      url: 'https://caps.x.com/v2/cards/preview.json',
      referer: 'https://x.com/',
      searchParams: {
        status: linkURL,
        cards_platform: 'Web-12',
        include_cards: 'true',
      },
    })

  timeline_home = (cursor: string) =>
    this.fetch({
      includeHeaders: true,
      url: 'https://x.com/i/api/2/timeline/home.json',
      searchParams: {
        include_profile_interstitial_type: '1',
        include_blocking: '1',
        include_blocked_by: '1',
        include_followed_by: '1',
        include_want_retweets: '1',
        include_mute_edge: '1',
        include_can_dm: '1',
        include_can_media_tag: '1',
        include_ext_has_nft_avatar: '1',
        skip_status: '1',
        cards_platform: 'Web-12',
        include_cards: '1',
        include_ext_alt_text: 'true',
        include_quote_count: 'true',
        include_reply_count: '1',
        tweet_mode: 'extended',
        include_entities: 'true',
        include_user_entities: 'true',
        include_ext_media_color: 'true',
        include_ext_media_availability: 'true',
        include_ext_sensitive_media_warning: 'true',
        send_error_codes: 'true',
        simple_quoted_tweet: 'true',
        earned: '1',
        count: '20',
        cursor,
        lca: 'true',
        ext: 'mediaStats,highlightedLabel,voiceInfo,superFollowMetadata',
      },
      referer: 'https://x.com/home',
    })

  notifications_all = (cursor: string) =>
    this.fetch({
      includeHeaders: true,
      url: 'https://x.com/i/api/2/notifications/all.json',
      searchParams: {
        include_profile_interstitial_type: 1,
        include_blocking: 1,
        include_blocked_by: 1,
        include_followed_by: 1,
        include_want_retweets: 1,
        include_mute_edge: 1,
        include_can_dm: 1,
        include_can_media_tag: 1,
        skip_status: 1,
        cards_platform: 'Web-12',
        include_cards: 1,
        include_ext_alt_text: 'true',
        include_quote_count: 'true',
        include_reply_count: 1,
        tweet_mode: 'extended',
        include_entities: 'true',
        include_user_entities: 'true',
        include_ext_media_color: 'true',
        include_ext_media_availability: 'true',
        send_error_codes: 'true',
        simple_quoted_tweet: 'true',
        count: cursor ? 40 : 20,
        cursor,
        ext: 'mediaStats,highlightedLabel,voiceInfo',
      },
      headers: {
        'x-twitter-polling': 'true',
      },
      referer: NOTIFICATIONS_URL,
    })

  notifications_all_last_seen_cursor = (cursor: string) =>
    this.fetch({
      method: 'POST',
      url: 'https://x.com/i/api/2/notifications/all/last_seen_cursor.json',
      form: { cursor },
      referer: NOTIFICATIONS_URL,
    })

  favoriteTweet = (tweetID: string) =>
    this.gqlMutation({
      tweet_id: tweetID,
    }, 'lI07N6Otwv1PhnEgXILM7A', 'FavoriteTweet', {
      referer: NOTIFICATIONS_URL,
    })

  unfavoriteTweet = (tweetID: string) =>
    this.gqlMutation({
      tweet_id: tweetID,
    }, 'ZYKSe-w7KEslx3JhSIk5LA', 'UnfavoriteTweet', {
      referer: NOTIFICATIONS_URL,
    })

  createTweet = (text: string, in_reply_to_tweet_id?: string) => this.gqlMutation({
    tweet_text: text,
    dark_request: false,
    media: { media_entities: [], possibly_sensitive: false },
    reply: in_reply_to_tweet_id ? { in_reply_to_tweet_id, exclude_reply_user_ids: [] } : undefined,
    withDownvotePerspective: false,
    withReactionsMetadata: false,
    withReactionsPerspective: false,
    withSuperFollowsTweetFields: true,
    withSuperFollowsUserFields: true,
    semantic_annotation_ids: [],
  }, 'yL4KIHnJPXt-JUpRDrBDDw', 'CreateTweet', {
    referer: NOTIFICATIONS_URL,
  }, {
    features: {
      view_counts_public_visibility_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: false,
      tweetypie_unmention_optimization_enabled: true,
      responsive_web_uc_gql_enabled: true,
      vibe_api_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      interactive_text_enabled: true,
      responsive_web_text_conversations_enabled: false,
      responsive_web_twitter_blue_verified_badge_is_enabled: true,
      verified_phone_label_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_enhance_cards_enabled: false,
    },
  })

  userByScreenName = (screen_name: string) => this.gqlQuery({
    screen_name,
    withSafetyModeUserFields: true,
  }, 'G3KGOASz96M-Qu0nwmGXNg', 'UserByScreenName', {
    referer: `https://x.com/${screen_name}`,
  }, {
    features: JSON.stringify({
      hidden_profile_likes_enabled: false,
      hidden_profile_subscriptions_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      subscriptions_verification_info_is_identity_verified_enabled: false,
      subscriptions_verification_info_verified_since_enabled: true,
      highlights_tweets_tab_ui_enabled: true,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
    }),
    fieldToggles: JSON.stringify({ withAuxiliaryUserLabels: false }),
  })

  private readonly getPushDeviceInfo = (endpoint: string, p256dh: string, auth: string) => {
    const deviceId = 'Mac/Chrome' // can be Mac/Firefox, Mac/Safari, Mac/Other Browser, Other OS/Other Browser
    return {
      // checksum is optional? "templateChecksum"?
      // checksum: undefined,
      os_version: deviceId,
      udid: deviceId,
      env: 3,
      locale: 'en',
      protocol_version: 1,
      token: endpoint,
      encryption_key1: p256dh,
      encryption_key2: auth,
    }
  }

  notifications_settings_login = (endpoint: string, p256dh: string, auth: string) =>
    this.fetch({
      url: `${API_ENDPOINT}1.1/notifications/settings/login.json`,
      method: 'POST',
      referer: 'https://x.com/settings/push_notifications',
      body: JSON.stringify({
        push_device_info: this.getPushDeviceInfo(endpoint, p256dh, auth),
      }),
    })

  notifications_settings_checkin = (endpoint: string, p256dh: string, auth: string) =>
    this.fetch({
      url: `${API_ENDPOINT}1.1/notifications/settings/checkin.json`,
      method: 'POST',
      referer: 'https://x.com/settings/push_notifications',
      body: JSON.stringify({
        push_device_info: this.getPushDeviceInfo(endpoint, p256dh, auth),
      }),
    })

  notifications_settings_logout = (endpoint: string, p256dh: string, auth: string) =>
    this.fetch({
      url: `${API_ENDPOINT}1.1/notifications/settings/logout.json`,
      method: 'POST',
      referer: 'https://x.com/settings/push_notifications',
      body: JSON.stringify(this.getPushDeviceInfo(endpoint, p256dh, auth)),
    })

  notifications_settings_save = (endpoint: string, p256dh: string, auth: string) =>
    this.fetch({
      url: `${API_ENDPOINT}1.1/notifications/settings/save.json`,
      method: 'POST',
      referer: 'https://x.com/settings/push_notifications',
      body: JSON.stringify({
        push_device_info: {
          ...this.getPushDeviceInfo(endpoint, p256dh, auth),
          settings: {
            AddressbookSetting: 'off',
            AdsSetting: 'off',
            DirectMessagesSetting: 'on',
            DmReactionSetting: 'reaction_your_own', // or reaction_everyone
            FollowersNonVitSetting: 'off',
            FollowersVitSetting: 'off',
            LifelineAlertsSetting: 'off',
            LikesNonVitSetting: 'off',
            LikesVitSetting: 'off',
            LiveVideoSetting: 'off',
            MentionsSetting: 'off',
            MomentsSetting: 'off',
            NewsSetting: 'off',
            PhotoTagsSetting: 'off',
            RecommendationsSetting: 'off',
            RetweetsSetting: 'off',
            SpacesSetting: 'off',
            TopicsSetting: 'off',
            TweetsSetting: 'off',
          },
        },
      }),
    })
}
