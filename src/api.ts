import path from 'path'
import fsSync, { promises as fs } from 'fs'
import { CookieJar } from 'tough-cookie'
import mem from 'mem'
import { texts, PlatformAPI, OnServerEventCallback, Message, LoginResult, Paginated, Thread, MessageContent, InboxName, ReAuthError, MessageSendOptions, PaginationArg, ActivityType, ServerEventType, User, AccountInfo } from '@textshq/platform-sdk'

import { mapThreads, mapMessage, mapMessages, mapEvent, REACTION_MAP_TO_TWITTER, mapParticipant, mapCurrentUser, mapUserUpdate, mapMessageLink, mapNotification, mapTweetNotification } from './mappers'
import TwitterAPI from './network-api'
import LivePipeline from './LivePipeline'
import { NOTIFICATIONS_THREAD_ID } from './constants'
import icons from './icons'

const { IS_DEV, Sentry } = texts

export default class Twitter implements PlatformAPI {
  private readonly api = new TwitterAPI()

  private readonly live = new LivePipeline(this.api, this.onLiveEvent.bind(this))

  private currentUser = null

  private userUpdatesCursor = null

  private disposed = false

  private onServerEvent: OnServerEventCallback

  private sendNotificationsThread = true

  init = async (cookieJarJSON: string, { dataDirPath }: AccountInfo) => {
    if (!cookieJarJSON) return
    this.sendNotificationsThread = fsSync.existsSync(path.join(dataDirPath, '../twitter-notif-thread')) // todo change
    const cookieJar = CookieJar.fromJSON(cookieJarJSON)
    await this.api.setLoginState(cookieJar)
    await this.afterAuth()
    if (!this.currentUser?.id_str) throw new ReAuthError() // todo improve
  }

  private processUserUpdates = (json: any) => {
    this.userUpdatesCursor = json.user_events?.cursor
    const events = (json.user_events?.entries as any[])?.flatMap(entryObj => mapUserUpdate(entryObj, this.currentUser.id_str, json))
    if (events?.length > 0) this.onServerEvent?.(events)
    // const { last_seen_event_id, trusted_last_seen_event_id, untrusted_last_seen_event_id } = json.user_events
    // this.api.dm_update_last_seen_event_id({ last_seen_event_id, trusted_last_seen_event_id, untrusted_last_seen_event_id: undefined }).then(console.log)
  }

  private pollTimeout: NodeJS.Timeout

  private pollUserUpdates = async () => {
    clearTimeout(this.pollTimeout)
    if (this.disposed) return
    let nextFetchTimeoutMs = 8_000
    if (this.userUpdatesCursor) {
      try {
        const { json, headers } = await this.api.dm_user_updates(this.userUpdatesCursor) || {}
        // if (IS_DEV) console.log(JSON.stringify(json, null, 2))
        if (json?.user_events) {
          this.processUserUpdates(json)
        } else if (json?.errors[0]?.code === 88) {
          const rateLimitReset = headers['x-rate-limit-reset']
          const resetMs = (+rateLimitReset * 1000) - Date.now()
          nextFetchTimeoutMs = resetMs
          console.log('twitter poll user updates: rate limit exceeded, next fetch:', resetMs)
        } else {
          nextFetchTimeoutMs = 60_000
        }
      } catch (err) {
        nextFetchTimeoutMs = 60_000
        const isOfflineError = err.name === 'RequestError' && (err.code === 'ENETDOWN' || err.code === 'EADDRNOTAVAIL')
        if (!isOfflineError) {
          console.error('tw error', err)
          Sentry.captureException(err)
        }
      }
    } else {
      texts.log('skipping polling bc !this.userUpdatesCursor')
    }
    this.pollTimeout = setTimeout(this.pollUserUpdates, nextFetchTimeoutMs)
  }

  private onLiveEvent(json: any) {
    const mapped = mapEvent(json)
    if (mapped) this.onServerEvent?.([mapped])
    else this.pollUserUpdates()
  }

  subscribeToEvents = (onEvent: OnServerEventCallback): void => {
    this.onServerEvent = onEvent
    this.live.setup()
    this.pollUserUpdates()
  }

  dispose = () => {
    this.live.dispose()
    this.disposed = true
    clearTimeout(this.pollTimeout)
  }

  onThreadSelected = async (threadID: string) => {
    const toSubscribe = threadID ? [
      '/dm_update/' + threadID,
      '/dm_typing/' + threadID,
    ] : []
    this.live.setSubscriptions(toSubscribe)
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

  private async getNotificationMessages(pagination: PaginationArg) {
    const cursors = { Top: null, Bottom: null }
    const all = await this.api.notifications_all(pagination?.cursor)
    if (!all.globalObjects) return { items: [], hasMore: false }
    const messages: Message[] = []
    all.timeline.instructions?.forEach(instruction => {
      const [name, value] = Object.entries<any>(instruction)[0]
      switch (name) {
        case 'addEntries':
          value.entries?.forEach(entry => {
            if (entry.content.operation) {
              const { cursorType, value } = entry.content.operation.cursor
              cursors[cursorType] = value
            } else if (entry.content.item) {
              const { content } = entry.content.item
              if (content.tweet) {
                messages.push(mapTweetNotification(all.globalObjects, entry))
              } else if (content.notification) {
                const m = mapNotification(all.globalObjects, entry.entryId, content.notification.id)
                messages.push(m)
              }
            }
          })
          break

        case 'removeEntries':
          value.entryIds?.forEach(id => {
            const index = messages.findIndex(m => m.id === id)
            if (index > -1) messages.splice(index, 1)
          })
          break

        case 'markEntriesUnreadGreaterThanSortIndex': {
          const unreadFrom = new Date(+value.sortIndex)
          messages.forEach(m => {
            m.extra = { unread: m.timestamp > unreadFrom }
          })
          break
        }

        default:
          texts.log('getNotificationMessages: unrecognized', name, value)
      }
    })
    const notifs = all.globalObjects.notifications
    if (!notifs) return { items: [], hasMore: false }
    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    messages[0].cursor = cursors.Bottom
    messages[messages.length - 1].cursor = cursors.Top
    return { items: messages, hasMore: true }
  }

  private getNotificationsThread = async () => {
    const participants = Object.keys(icons).map<User>(iconName => ({
      id: iconName,
      fullName: ' ',
      imgURL: icons[iconName],
    }))
    const messages = await this.getNotificationMessages(undefined)
    const thread: Thread = {
      id: 'notifications',
      type: 'channel',
      title: `Notifications for ${this.currentUser.name}`,
      isReadOnly: true,
      isUnread: messages.items.some(m => m.extra.unread),
      messages,
      participants: { items: participants, hasMore: false },
    }
    return thread
  }

  getThreads = async (folderName: InboxName, pagination: PaginationArg): Promise<Paginated<Thread>> => {
    const { cursor, direction } = pagination || { cursor: null, direction: null }
    const inboxType = {
      [InboxName.NORMAL]: 'trusted',
      [InboxName.REQUESTS]: 'untrusted',
    }[folderName]
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
    const [threads, otherThreads] = mapThreads(json, this.currentUser, inboxType)
    if (otherThreads?.length > 0) {
      this.onServerEvent?.([{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'upsert',
        objectName: 'thread',
        objectIDs: {},
        entries: otherThreads,
      }])
    }
    return {
      items: cursor || !this.sendNotificationsThread ? threads : [await this.getNotificationsThread(), ...threads],
      hasMore: timeline.status !== 'AT_END',
      oldestCursor: timeline.min_entry_id,
      newestCursor: timeline.max_entry_id,
    }
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    if (threadID === NOTIFICATIONS_THREAD_ID) return this.getNotificationMessages(pagination)
    const { cursor, direction } = pagination || { cursor: null, direction: null }
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

  getThread = async (threadID: string) => {
    if (threadID === NOTIFICATIONS_THREAD_ID) return this.getNotificationsThread()
    const { conversation_timeline } = await this.api.dm_conversation_thread(threadID, undefined)
    if (!conversation_timeline) return
    // if (IS_DEV) console.log(conversation_timeline)
    return mapThreads(conversation_timeline, this.currentUser)[0][0]
  }

  createThread = async (userIDs: string[]) => {
    if (userIDs.length === 0) return null
    if (userIDs.length === 1) {
      const [userID] = userIDs
      const threadID = `${this.currentUser.id_str}-${userID}`
      return this.getThread(threadID)
    }
    // const json = await this.api.dm_conversation(userIDs)
    // return mapThreads(conversation_timeline, this.currentUser)[0]
  }

  sendMessage = async (threadID: string, content: MessageContent, msgSendOptions: MessageSendOptions) => {
    if (content.fileBuffer) {
      return this.sendFileFromBuffer(threadID, content.text, content.fileBuffer, content.mimeType, msgSendOptions)
    }
    if (content.filePath) {
      const buffer = await fs.readFile(content.filePath)
      return this.sendFileFromBuffer(threadID, content.text, buffer, content.mimeType, msgSendOptions)
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

  private sendFileFromBuffer = async (threadID: string, text: string, fileBuffer: Buffer, mimeType: string, { pendingMessageID }: MessageSendOptions) => {
    const mediaID = await this.api.upload(threadID, fileBuffer, mimeType)
    if (!mediaID) return
    const { entries, errors } = await this.api.dm_new(text || '', threadID, pendingMessageID, mediaID)
    if (IS_DEV) console.log(entries, errors)
    if (errors) {
      throw new Error((errors as any[]).map(err => err.message).join(', '))
    }
    const mapped = (entries as any[])?.map(entry => mapMessage(entry, this.currentUser.id_str, undefined))
    return mapped
  }

  sendActivityIndicator = async (type: ActivityType, threadID: string) => {
    if (type === ActivityType.TYPING) await this.api.dm_conversation_typing(threadID)
  }

  private readonly handleJSONErrors = (json: any) => {
    if (json?.errors) throw Error(json.errors.map(e => `${e.code}: ${e.message}`).join(', '))
  }

  addReaction = (threadID: string, messageID: string, reactionKey: string) =>
    this.api.dm_reaction_new(REACTION_MAP_TO_TWITTER[reactionKey], threadID, messageID).then(this.handleJSONErrors)

  removeReaction = (threadID: string, messageID: string, reactionKey: string) =>
    this.api.dm_reaction_delete(REACTION_MAP_TO_TWITTER[reactionKey], threadID, messageID).then(this.handleJSONErrors)

  sendReadReceipt = (threadID: string, messageID: string, messageCursor: string) =>
    (threadID === NOTIFICATIONS_THREAD_ID
      ? this.api.notifications_all_last_seen_cursor(messageCursor)
      : this.api.dm_conversation_mark_read(threadID, messageID))

  getAsset = async (key: string, hex?: string) => {
    if (key === 'media') {
      const url = Buffer.from(hex, 'hex').toString()
      return this.api.authenticatedGet(url)
    }
    // for backwards compat
    const url = Buffer.from(key, 'base64').toString()
    return this.api.authenticatedGet(url)
  }

  deleteMessage = (threadID: string, messageID: string) =>
    this.api.dm_destroy(threadID, messageID).then(this.handleJSONErrors)

  updateThread = async (threadID: string, updates: Partial<Thread>) => {
    if ('title' in updates) {
      const result = await this.api.dm_conversation_update_name(threadID, updates.title)
      return result === undefined
    }
    if ('mutedUntil' in updates) {
      const result = await (updates.mutedUntil === 'forever'
        ? this.api.dm_conversation_disable_notifications(threadID)
        : this.api.dm_conversation_enable_notifications(threadID))
      return result === undefined
    }
  }

  deleteThread = async (threadID: string) => {
    await this.api.dm_conversation_delete(threadID)
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

  removeParticipant = async (threadID: string, participantID: string) => {
    if (participantID !== this.currentUser.id_str) return
    await this.deleteThread(threadID)
    return true
  }

  getLinkPreview = async (linkURL: string) => {
    const res = await this.api.cards_preview(linkURL)
    return mapMessageLink(res.card)
  }
}
