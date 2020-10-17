import got from 'got'
import { v4 as uuid } from 'uuid'
import EventSource from 'eventsource'
import { CookieJar, Cookie } from 'tough-cookie'
import FormData from 'form-data'
import crypto from 'crypto'
import bluebird from 'bluebird'
import { texts, ReAuthError } from '@textshq/platform-sdk'

const { constants, IS_DEV, Sentry } = texts
const { USER_AGENT } = constants

const randomBytes = bluebird.promisify(crypto.randomBytes)

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

const EXT = 'mediaColor,altText,mediaStats,highlightedLabel,cameraMoment'

const ENDPOINT = 'https://api.twitter.com/'
const UPLOAD_ENDPOINT = 'https://upload.twitter.com/'

const genCSRFToken = () =>
  randomBytes(16).then(b => b.toString('hex'))

const CT0_MAX_AGE = 6 * 60 * 60

function handleErrors(url: string, statusCode: number, json: any) {
  const firstError = json.errors[0]
  // { errors: [ { code: 32, message: 'Could not authenticate you.' } ] }
  if (firstError?.code === 32) throw new ReAuthError(firstError!.message)
  console.log(url, statusCode, json.errors)
  Sentry.captureException(Error(url), {
    extra: {
      errors: json.errors,
    },
  })
}

export default class TwitterAPI {
  csrfToken: string = ''

  cookieJar: CookieJar = null

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

  fetch = async ({ headers = {}, referer, ...rest }) => {
    if (!this.cookieJar) throw new Error('Twitter cookie jar not found')
    if (IS_DEV) console.log('[TW] CALLING', rest.url)
    await this.setCSRFTokenCookie()
    const res = await got({
      // http2: true,
      throwHttpErrors: false,
      cookieJar: this.cookieJar,
      headers: {
        'x-csrf-token': this.csrfToken,
        ...staticFetchHeaders,
        Referer: referer,
        ...commonHeaders,
        ...headers,
      },
      ...rest,
    })
    if (!res.body) return
    const json = JSON.parse(res.body)
    if (json.errors) {
      handleErrors(res.url, res.statusCode, json)
    }
    return json
  }

  // fetchStream = async ({ headers = {}, referer, ...rest }) => {
  //   if (!this.cookieJar) throw new Error('Twitter cookie jar not found')
  //   if (IS_DEV) console.log('[TW] CALLING', rest.url)
  //   await this.setCSRFTokenCookie()
  //   return got.stream({
  //     // http2: true,
  //     throwHttpErrors: false,
  //     cookieJar: this.cookieJar,
  //     headers: {
  //       'x-csrf-token': this.csrfToken,
  //       ...staticFetchHeaders,
  //       Referer: referer,
  //       ...commonHeaders,
  //       ...headers,
  //     },
  //     ...rest,
  //   })
  // }

  authenticatedGet = async (url: string) => {
    if (!this.cookieJar) throw new Error('Not authorized')
    await this.setCSRFTokenCookie()
    return got({
      // http2: true,
      cookieJar: this.cookieJar,
      responseType: 'buffer',
      headers: {
        Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: 'https://twitter.com/messages/',
        ...commonHeaders,
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'same-site',
      },
      url,
    })
  }

  media_upload_init = (referer: string, totalBytes: number, mimeType: string) =>
    this.fetch({
      method: 'POST',
      url: `${UPLOAD_ENDPOINT}i/media/upload.json`,
      searchParams: {
        command: 'INIT',
        total_bytes: totalBytes,
        media_type: mimeType,
        media_category: 'dm_image',
      },
      referer,
    })

  media_upload_append = (referer: string, mediaID: string, body: FormData) =>
    this.fetch({
      method: 'POST',
      url: `${UPLOAD_ENDPOINT}i/media/upload.json`,
      searchParams: {
        command: 'APPEND',
        media_id: mediaID,
        segment_index: 0,
      },
      body,
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

  upload = async (threadID: string, buffer: Buffer, mimeType: string): Promise<string> => {
    const totalBytes = buffer.length
    const referer = `https://twitter.com/messages/${threadID}`
    const res = await this.media_upload_init(referer, totalBytes, mimeType)
    if (IS_DEV) console.log(res)
    const { media_id_string: mediaID } = res
    if (!mediaID) return
    const form = new FormData()
    form.append('media', buffer)
    await this.media_upload_append(referer, mediaID, form)
    await this.media_upload_finalize(referer, mediaID)
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

  dm_reaction = (action: string, reactionName: string, threadID: string, messageID: string) =>
    this.fetch({
      method: 'POST',
      url: `${ENDPOINT}1.1/dm/reaction/${action}.json`,
      referer: `https://twitter.com/messages/${threadID}`,
      searchParams: {
        reaction_key: reactionName,
        conversation_id: threadID,
        dm_id: messageID,
      },
    })

  dm_reaction_new = (reactionName: string, threadID: string, messageID: string) =>
    this.dm_reaction('new', reactionName, threadID, messageID)

  dm_reaction_delete = (reactionName: string, threadID: string, messageID: string) =>
    this.dm_reaction('delete', reactionName, threadID, messageID)

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
        include_cards: true,
      },
    })
}
