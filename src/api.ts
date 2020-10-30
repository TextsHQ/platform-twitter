import { promises as fs } from 'fs'
import { CookieJar } from 'tough-cookie'
import mem from 'mem'
import { isEqual } from 'lodash'
import { texts, PlatformAPI, OnServerEventCallback, Message, LoginResult, Paginated, Thread, MessageContent, InboxName, ReAuthError, MessageSendOptions, PaginationArg } from '@textshq/platform-sdk'

import { mapThreads, mapMessage, mapMessages, mapEvent, REACTION_MAP_TO_TWITTER, mapParticipant, mapCurrentUser, mapUserUpdate, mapMessageLink } from './mappers'
import TwitterAPI from './network-api'

const { IS_DEV, Sentry } = texts

export default class Twitter implements PlatformAPI {
  private readonly api = new TwitterAPI()

  private currentUser = null

  private livePipelineID: string = null

  private subbedTopics: string[] = []

  private es: EventSource = null

  private userUpdatesCursor = null

  // private userUpdatesIDs = {}

  private disposed = false

  init = async (cookieJarJSON: string) => {
    if (!cookieJarJSON) return
    const cookieJar = CookieJar.fromJSON(cookieJarJSON)
    await this.api.setLoginState(cookieJar)
    await this.afterAuth()
    if (!this.currentUser?.id_str) throw new ReAuthError()
  }

  private processUserUpdates = (json: any) => {
    this.userUpdatesCursor = json.user_events?.cursor
    const events = (json.user_events?.entries as any[])?.flatMap(entryObj => mapUserUpdate(entryObj, this.currentUser.id_str, json))
    if (events?.length > 0) this.onServerEvent?.(events)
  }

  private pollTimeout: NodeJS.Timeout

  private pollUserUpdates = async () => {
    clearTimeout(this.pollTimeout)
    if (this.disposed) return
    let increaseDelay = false
    if (this.userUpdatesCursor) {
      try {
        const json = await this.api.dm_user_updates(this.userUpdatesCursor)
        if (IS_DEV) console.log(JSON.stringify(json, null, 2))
        if (json.user_events) {
          this.processUserUpdates(json)
        } else {
          increaseDelay = true
        }
      } catch (err) {
        increaseDelay = true
        console.error('tw error', err)
        Sentry.captureException(err)
      }
    } else {
      texts.log('skipping polling bc !this.userUpdatesCursor')
    }
    // mapThreads(json.user_events, currentUser, inboxType)
    // const { last_seen_event_id, trusted_last_seen_event_id, untrusted_last_seen_event_id } = json.user_events
    // this.userUpdatesIDs = json.user_events
    // await this.api.dm_update_last_seen_event_id({ last_seen_event_id, trusted_last_seen_event_id, untrusted_last_seen_event_id })
    this.pollTimeout = setTimeout(this.pollUserUpdates, increaseDelay ? 60_000 : 8_000)
  }

  setupLivePipeline = () => {
    this.es?.close()
    this.es = this.api.live_pipeline_events(this.subbedTopics.join(','))
    this.es.onopen = event => {
      if (IS_DEV) console.log(new Date(), 'es open', event)
    }
    this.es.onmessage = event => {
      const json = JSON.parse(event.data)
      if (IS_DEV) console.log(new Date(), 'es', json)
      if (json.topic === '/system/config') {
        const { session_id } = json.payload.config
        this.livePipelineID = session_id
      } else {
        const mapped = mapEvent(json)
        if (mapped) this.onServerEvent?.([mapped])
        else this.pollUserUpdates()
      }
    }
    let errorCount = 0
    this.es.onerror = event => {
      if (this.es.readyState === this.es.CLOSED) {
        console.error(new Date(), 'es closed, reconnecting')
        Sentry.captureMessage(`twitter es reconnecting ${this.es.readyState}`)
        this.setupLivePipeline()
      }
      console.error(new Date(), 'es error', event, ++errorCount)
    }
  }

  private onServerEvent: OnServerEventCallback

  subscribeToEvents = (onEvent: OnServerEventCallback): void => {
    this.onServerEvent = onEvent
    this.setupLivePipeline()
    this.pollUserUpdates()
  }

  dispose = () => {
    this.es?.close()
    this.es = null
    this.disposed = true
    clearTimeout(this.pollTimeout)
  }

  onThreadSelected = async (threadID: string) => {
    if (!this.livePipelineID) return
    const toSubscribe = threadID ? [
      '/dm_update/' + threadID,
      '/dm_typing/' + threadID,
    ] : []
    if (toSubscribe.length === 0 && this.subbedTopics.length === 0) return
    if (isEqual(toSubscribe, this.subbedTopics)) return
    const { errors } = await this.api.live_pipeline_update_subscriptions(this.livePipelineID, toSubscribe, this.subbedTopics) || {}
    // [ { code: 392, message: 'Session not found.' } ]
    if (errors?.[0].code === 392) {
      this.setupLivePipeline()
    }
    this.subbedTopics = toSubscribe
  }

  login = async ({ cookieJarJSON }): Promise<LoginResult> => {
    await this.api.setLoginState(CookieJar.fromJSON(cookieJarJSON as any))
    await this.afterAuth()
    if (this.currentUser?.id_str) return { type: 'success' }
    // { errors: [ { code: 32, message: 'Could not authenticate you.' } ] }
    const errorMessages = this.currentUser?.errors?.map(e => e.message)?.join('\n')
    return { type: 'error', errorMessage: errorMessages }
  }

  logout = () => this.api.account_logout()

  serializeSession = () => this.api.cookieJar.toJSON()

  afterAuth = async () => {
    const response = await this.api.account_verify_credentials()
    this.currentUser = response
  }

  getCurrentUser = () => mapCurrentUser(this.currentUser)

  searchUsers = mem(async (typed: string) => {
    const { users } = await this.api.typeahead(typed) || {}
    return (users as any[] || []).map(u => mapParticipant(u, {}))
  })

  getThreads = async (inboxName: InboxName, { cursor, direction }: PaginationArg = { cursor: null, direction: null }): Promise<Paginated<Thread>> => {
    const inboxType = {
      [InboxName.NORMAL]: 'trusted',
      [InboxName.REQUESTS]: 'untrusted',
    }[inboxName]
    let json = null
    let timeline = null
    if (cursor) {
      json = await this.api.dm_inbox_timeline(inboxType, { [direction === 'before' ? 'max_id' : 'min_id']: cursor })
      json = json.inbox_timeline
      timeline = json
    } else {
      json = await this.api.dm_inbox_initial_state()
      json = json.inbox_initial_state
      timeline = json.inbox_timelines[inboxType]
      if (!this.userUpdatesCursor) this.userUpdatesCursor = json.cursor
    }
    return {
      items: mapThreads(json, this.currentUser, inboxType),
      hasMore: timeline.status !== 'AT_END',
      oldestCursor: timeline.min_entry_id,
      newestCursor: timeline.max_entry_id,
    }
  }

  getMessages = async (threadID: string, { cursor, direction }: PaginationArg = { cursor: null, direction: null }): Promise<Paginated<Message>> => {
    const { conversation_timeline } = await this.api.dm_conversation_thread(threadID, cursor ? { [direction === 'before' ? 'max_id' : 'min_id']: cursor } : {})
    const entries = Object.values(conversation_timeline.entries || {})
    const thread = conversation_timeline.conversations[threadID]
    const items = mapMessages(entries, thread, this.currentUser.id_str)
    return {
      items,
      hasMore: conversation_timeline.status !== 'AT_END',
      oldestCursor: conversation_timeline.min_entry_id,
      newestCursor: conversation_timeline.max_entry_id,
    }
  }

  createThread = async (userIDs: string[]) => {
    if (userIDs.length === 0) return null
    if (userIDs.length === 1) {
      const [userID] = userIDs
      const threadID = `${this.currentUser.id_str}-${userID}`
      const { conversation_timeline } = await this.api.dm_conversation_thread(threadID, undefined)
      if (!conversation_timeline) return
      if (IS_DEV) console.log(conversation_timeline)
      return mapThreads(conversation_timeline, this.currentUser, 'trusted')[0]
    }
    // const json = await this.api.dm_conversation(userIDs)
    // console.log(json)
    // return mapThreads(conversation_timeline, this.currentUser, 'trusted')[0]
  }

  sendMessage = async (threadID: string, content: MessageContent, msgSendOptions: MessageSendOptions) => {
    if (content.fileBuffer) {
      return this.sendFileFromBuffer(threadID, content.fileBuffer, content.mimeType, msgSendOptions)
    }
    if (content.filePath) {
      const buffer = await fs.readFile(content.filePath)
      return this.sendFileFromBuffer(threadID, buffer, content.mimeType, msgSendOptions)
    }
    return this.sendTextMessage(threadID, content.text, msgSendOptions)
  }

  private sendTextMessage = async (threadID: string, text: string, { pendingMessageID }: MessageSendOptions) => {
    const { entries, errors } = await this.api.dm_new(text, threadID, pendingMessageID)
    if (IS_DEV) console.log(entries, errors)
    // [ { message: 'Over capacity', code: 130 } ]
    if (errors) {
      throw new Error((errors as any[]).map(err => err.message).join(', '))
    }
    const mapped = (entries as any[])?.map(entry => mapMessage(entry, this.currentUser.id_str, undefined))
    return mapped
  }

  private sendFileFromBuffer = async (threadID: string, fileBuffer: Buffer, mimeType: string, { pendingMessageID }: MessageSendOptions) => {
    const mediaID = await this.api.upload(threadID, fileBuffer, mimeType)
    if (!mediaID) return
    const { entries, errors } = await this.api.dm_new('', threadID, pendingMessageID, mediaID)
    if (IS_DEV) console.log(entries, errors)
    if (errors) {
      throw new Error((errors as any[]).map(err => err.message).join(', '))
    }
    const mapped = (entries as any[])?.map(entry => mapMessage(entry, this.currentUser.id_str, undefined))
    return mapped
  }

  sendTypingIndicator = (threadID: string) =>
    this.api.dm_conversation_typing(threadID)

  addReaction = (threadID: string, messageID: string, reactionKey: string) =>
    this.api.dm_reaction_new(REACTION_MAP_TO_TWITTER[reactionKey], threadID, messageID)

  removeReaction = (threadID: string, messageID: string, reactionKey: string) =>
    this.api.dm_reaction_delete(REACTION_MAP_TO_TWITTER[reactionKey], threadID, messageID)

  sendReadReceipt = async (threadID: string, messageID: string) =>
    this.api.dm_conversation_mark_read(threadID, messageID)

  getAsset = async (key: string) => {
    const url = Buffer.from(key, 'base64').toString()
    const { body } = await this.api.authenticatedGet(url)
    return body
  }

  deleteMessage = async (threadID: string, messageID: string) => {
    const body = await this.api.dm_destroy(threadID, messageID)
    return body === undefined
  }

  changeThreadTitle = async (threadID: string, newTitle: string) => {
    const result = await this.api.dm_conversation_update_name(threadID, newTitle)
    return result === undefined
  }

  changeThreadImage = async (threadID: string, imageBuffer: Buffer, mimeType: string) => {
    const mediaID = await this.api.upload(threadID, imageBuffer, mimeType)
    if (!mediaID) return
    await this.api.dm_conversation_update_avatar(threadID, mediaID)
  }

  addParticipant = async (threadID: string, participantID: string) => {
    await this.api.dm_conversation_add_participants(threadID, [participantID])
    return true
  }

  muteThread = async (threadID: string, muted: boolean) => {
    if (muted) {
      await this.api.dm_conversation_disable_notifications(threadID)
    } else {
      await this.api.dm_conversation_enable_notifications(threadID)
    }
  }

  getLinkPreview = async (linkURL: string) => {
    const res = await this.api.cards_preview(linkURL)
    return mapMessageLink(res.card)
  }
}
