import { promises as fs } from 'fs'
import { CookieJar } from 'tough-cookie'
import mem from 'mem'
import { randomUUID as uuid } from 'crypto'
import { texts, PlatformAPI, OnServerEventCallback, Message, LoginResult, Paginated, Thread, MessageContent, InboxName, MessageSendOptions, PaginationArg, ActivityType, ServerEventType, User, NotificationsInfo, UserID, PhoneNumber, ThreadFolderName, LoginCreds, ClientContext } from '@textshq/platform-sdk'
import { pick } from 'lodash'

import { mapThreads, mapMessages, mapEvent, mapUser, mapUserUpdate, mapMessageLink, mapMessage } from './mappers'
import TwitterAPI from './network-api'
import LivePipeline from './LivePipeline'
import { NOTIFICATIONS_THREAD_ID } from './constants'
import Notifications from './notifications'
import { TwitterError } from './errors'
import type TwitterPlatformInfo from './info'

const { Sentry } = texts

type SerializedSession = {
  cookieJarJSON?: string
  xClientUuid?: string
}

export default class Twitter implements PlatformAPI {
  private readonly api = new TwitterAPI()

  private readonly live = new LivePipeline(this.api, this.onLiveEvent.bind(this))

  currentUser: User = null

  userUpdatesCursor: string = null

  disposed = false

  onServerEvent: OnServerEventCallback

  private sendNotificationsThread = false

  onlyMentionsInNotifThread = false

  private notifications: Notifications

  private lastSeenEventIds = {
    last_seen_event_id: 0,
    trusted_last_seen_event_id: 0,
    untrusted_last_seen_event_id: 0,
  }

  constructor(readonly accountID: string) {}

  init = async (session: SerializedSession, _context: ClientContext, prefs: Record<keyof typeof TwitterPlatformInfo['prefs'], any>) => {
    this.sendNotificationsThread = prefs?.show_notifications_thread
    this.onlyMentionsInNotifThread = prefs?.show_only_mentions_in_notifications_thread

    if (!session) return

    const { cookieJarJSON, xClientUuid } = session
    this.api.setXClientUuid(xClientUuid)
    const cookieJar = CookieJar.fromJSON(cookieJarJSON)
    await this.api.setLoginState(cookieJar)
    await this.afterAuth()
  }

  private processUserUpdates = (json: any) => {
    this.userUpdatesCursor = json.user_events?.cursor
    const events = (json.user_events?.entries as any[])?.flatMap(entryObj => mapUserUpdate(entryObj, this.currentUser.id, json))
    if (events?.length > 0) this.onServerEvent?.(events)
    this.lastSeenEventIds = pick(json.user_events, ['last_seen_event_id', 'trusted_last_seen_event_id', 'untrusted_last_seen_event_id'])
  }

  private pollTimeout: NodeJS.Timeout

  private lastUserUpdatesFetch: number

  private pollUserUpdates = async () => {
    clearTimeout(this.pollTimeout)
    if (this.disposed) return
    let nextFetchTimeoutMs = 5_000
    if (this.userUpdatesCursor) {
      try {
        const { json, headers } = await this.api.dm_user_updates(this.userUpdatesCursor) || {}
        this.lastUserUpdatesFetch = Date.now()
        // texts.log(JSON.stringify(json, null, 2))
        if (json?.user_events) {
          this.processUserUpdates(json)
        } else if (json?.errors?.[0]?.code === TwitterError.RateLimitExceeded) {
          const rateLimitReset = headers['x-rate-limit-reset']
          const resetMs = (+rateLimitReset * 1000) - Date.now()
          nextFetchTimeoutMs = resetMs
          console.log('[twitter poll user updates]: rate limit exceeded, next fetch:', resetMs)
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
      texts.log('[twitter poll user updates] skipping polling bc !this.userUpdatesCursor')
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
    this.notifications?.getThread().then(thread => {
      onEvent([{
        type: ServerEventType.STATE_SYNC,
        objectIDs: {},
        objectName: 'thread',
        mutationType: 'upsert',
        entries: [thread],
      }])
    })
  }

  dispose = () => {
    this.live.dispose()
    this.disposed = true
    clearTimeout(this.pollTimeout)
  }

  reconnectRealtime = () => {
    this.live.updateSubscriptions()
    if ((Date.now() - this.lastUserUpdatesFetch) > 5_000) this.pollUserUpdates()
  }

  onThreadSelected = async (threadID: string) => {
    const toSubscribe = threadID && threadID !== NOTIFICATIONS_THREAD_ID ? [
      '/dm_update/' + threadID,
      '/dm_typing/' + threadID,
    ] : []
    this.live.setSubscriptions(toSubscribe)
  }

  login = async (creds: LoginCreds): Promise<LoginResult> => {
    const cookieJarJSON = 'cookieJarJSON' in creds && creds.cookieJarJSON
    if (!cookieJarJSON) return { type: 'error', errorMessage: 'Cookies not found' }
    await this.api.setLoginState(CookieJar.fromJSON(cookieJarJSON as any))
    this.api.setXClientUuid(uuid())
    await this.afterAuth()
    return { type: 'success' }
  }

  logout = () => this.api.account_logout()

  serializeSession = (): SerializedSession => ({
    cookieJarJSON: this.api.cookieJar.toJSON() as unknown as string,
    xClientUuid: this.api.xClientUuid,
  })

  private afterAuth = async () => {
    const ml = await this.api.account_multi_list()
    this.currentUser = await this.getUser({ username: ml.users[0].screen_name })
    if (!this.currentUser) throw new Error('current user not present')
    if (this.sendNotificationsThread) {
      this.notifications = new Notifications(this, this.api)
    }
  }

  getCurrentUser = () => this.currentUser

  searchUsers = mem(async (typed: string) => {
    const { users } = await this.api.typeahead(typed) || {}
    return (users as any[] || []).map(u => mapUser(u))
  })

  getThreads = async (folderName: ThreadFolderName, pagination: PaginationArg): Promise<Paginated<Thread>> => {
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
      items: threads,
      hasMore: timeline.status !== 'AT_END',
      oldestCursor: timeline.min_entry_id,
      newestCursor: timeline.max_entry_id,
    }
  }

  getMessages = async (threadID: string, pagination: PaginationArg): Promise<Paginated<Message>> => {
    if (threadID === NOTIFICATIONS_THREAD_ID) return this.notifications.getMessages(pagination)
    const { cursor, direction } = pagination || { cursor: null, direction: null }
    const { conversation_timeline } = await this.api.dm_conversation_thread(threadID, cursor ? { [direction === 'before' ? 'max_id' : 'min_id']: cursor } : {})
    const entries = Object.values(conversation_timeline.entries || {})
    const thread = conversation_timeline.conversations[threadID]
    const items = mapMessages(entries, thread, this.currentUser.id)
    return {
      items,
      hasMore: conversation_timeline.status !== 'AT_END',
      oldestCursor: conversation_timeline.min_entry_id,
      newestCursor: conversation_timeline.max_entry_id,
    }
  }

  getThread = async (threadID: string) => {
    if (threadID === NOTIFICATIONS_THREAD_ID) return this.notifications?.getThread()
    if (!threadID || typeof threadID !== 'string') throw Error('invalid threadID')
    const json = await this.api.dm_conversation_thread(threadID, undefined)
    if (!json) return
    const { conversation_timeline } = json
    if (!conversation_timeline) return
    // if (IS_DEV) console.log(conversation_timeline)
    return mapThreads(conversation_timeline, this.currentUser)[0][0]
  }

  getUser = async (ids: { userID: UserID } | { username: string } | { phoneNumber: PhoneNumber } | { email: string }): Promise<User> => {
    if (!('username' in ids)) return
    const { username } = ids
    const json = await this.api.userByScreenName(username)
    return {
      ...mapUser(json.data.user.result.legacy),
      id: json.data.user.result.rest_id,
    }
  }

  createThread = async (userIDs: string[], title: string, messageText: string) => {
    if (userIDs.length === 0) return null
    if (userIDs.length === 1) {
      const [userID] = userIDs
      if (userID.startsWith('notifications_')) return
      const threadID = `${this.currentUser.id}-${userID}`
      return this.getThread(threadID)
    }
    const json = await this.api.dm_new2({ text: messageText, recipientIDs: userIDs })
    const { entries } = json
    const threadID = (entries as any[]).find(e => e.conversation_create)?.conversation_create?.conversation_id
    return this.getThread(threadID)
  }

  private tweet = async (text: string, inReplyToTweetID: string) => {
    const json = await this.api.createTweet(text, inReplyToTweetID)
    this.onServerEvent([{
      type: ServerEventType.TOAST,
      toast: {
        text: 'Tweeted!',
        buttons: [{ label: 'View tweet', linkURL: `https://twitter.com/${this.currentUser.username}/status/${json.data.create_tweet.tweet_results.result.rest_id}` }],
      },
    }])
    return true
  }

  sendMessage = async (threadID: string, content: MessageContent, msgSendOptions: MessageSendOptions) => {
    const { quotedMessageID, pendingMessageID } = msgSendOptions
    if (threadID === NOTIFICATIONS_THREAD_ID) {
      if (content.text?.startsWith('/tweet ')) {
        const inReplyToTweetID = quotedMessageID ? this.notifications.messageTweetMap.get(quotedMessageID) : undefined
        return this.tweet(content.text.slice('/tweet '.length), inReplyToTweetID)
      }
      this.onServerEvent([{
        type: ServerEventType.TOAST,
        toast: { text: 'To tweet, start the message with "/tweet "' },
      }])
      return false
    }
    const fileBuffer = content.filePath ? await fs.readFile(content.filePath) : content.fileBuffer
    const mediaID = fileBuffer
      ? await this.api.upload(threadID, fileBuffer, content.mimeType)
      : undefined
    const includeLinkPreview = content.links?.length > 0 ? content.links.every(l => l.includePreview) : undefined
    const json = await this.api.dm_new2({ text: content.text, threadID, replyID: quotedMessageID, generatedMsgID: pendingMessageID, mediaID, includeLinkPreview })
    const mapped = (json.entries as any[])?.map(entry => mapMessage(entry, this.currentUser.id, undefined))
    return mapped
  }

  sendActivityIndicator = async (type: ActivityType, threadID: string) => {
    if (type === ActivityType.TYPING) await this.api.dm_conversation_typing(threadID)
    else if (type === ActivityType.ONLINE) {
      const { last_seen_event_id, trusted_last_seen_event_id, untrusted_last_seen_event_id } = this.lastSeenEventIds
      // prevent unecessary network trips
      if (last_seen_event_id === trusted_last_seen_event_id
         || last_seen_event_id === untrusted_last_seen_event_id) return

      // we can only send one of trusted or untrusted per request
      // let's select the newest one
      const lastSeenUpdate = untrusted_last_seen_event_id > trusted_last_seen_event_id
        ? { last_seen_event_id, untrusted_last_seen_event_id }
        : { last_seen_event_id, trusted_last_seen_event_id }

      texts.log('sending dm_update_last_seen_event_id', lastSeenUpdate)
      await this.api.dm_update_last_seen_event_id(lastSeenUpdate)
    }
  }

  addReaction = (threadID: string, messageID: string, reactionKey: string) =>
    (threadID === NOTIFICATIONS_THREAD_ID
      ? this.notifications.addReaction(messageID, reactionKey)
      : this.api.dm_reaction(reactionKey, threadID, messageID, 'new'))

  removeReaction = (threadID: string, messageID: string, reactionKey: string) =>
    (threadID === NOTIFICATIONS_THREAD_ID
      ? this.notifications.removeReaction(messageID, reactionKey)
      : this.api.dm_reaction(reactionKey, threadID, messageID, 'delete'))

  sendReadReceipt = (threadID: string, messageID: string, messageCursor: string) =>
    (threadID === NOTIFICATIONS_THREAD_ID
      ? this.notifications.markRead(messageCursor)
      : this.api.dm_conversation_mark_read(threadID, messageID))

  getAsset = async (_, key: string, hex?: string) => {
    if (key === 'media') {
      const url = Buffer.from(hex, 'hex').toString()
      return this.api.authenticatedGet(url)
    }
    // for backwards compat
    const url = Buffer.from(key, 'base64').toString()
    return this.api.authenticatedGet(url)
  }

  deleteMessage = async (threadID: string, messageID: string) => {
    if (threadID === NOTIFICATIONS_THREAD_ID) throw new Error('Notifications cannot be deleted from the notifications thread')
    await this.api.dm_destroy(threadID, messageID)
  }

  updateThread = async (threadID: string, updates: Partial<Thread>) => {
    if (threadID === NOTIFICATIONS_THREAD_ID) return
    if ('title' in updates) {
      await this.api.dm_conversation_update_name(threadID, updates.title)
    }
    if ('mutedUntil' in updates) {
      await (updates.mutedUntil === 'forever'
        ? this.api.dm_conversation_disable_notifications
        : this.api.dm_conversation_enable_notifications)(threadID)
    }
    if ('folderName' in updates) {
      if (updates.folderName === InboxName.NORMAL) {
        await this.api.dm_conversation_accept(threadID)
      }
    }
  }

  deleteThread = async (threadID: string) => {
    if (threadID === NOTIFICATIONS_THREAD_ID) throw new Error('To remove the notifications thread: click Prefs → your Twitter account → Show Twitter notifications as a thread')
    await this.api.dm_conversation_delete(threadID)
  }

  changeThreadImage = async (threadID: string, imageBuffer: Buffer, mimeType: string) => {
    if (threadID === NOTIFICATIONS_THREAD_ID) throw new Error('Image cannot be changed for the notifications thread')
    const mediaID = await this.api.upload(threadID, imageBuffer, mimeType)
    if (!mediaID) return
    await this.api.dm_conversation_update_avatar(threadID, mediaID)
  }

  addParticipant = async (threadID: string, participantID: string) => {
    if (threadID === NOTIFICATIONS_THREAD_ID) throw new Error('Participants cannot be added to the notifications thread')
    await this.api.dm_conversation_add_participants(threadID, [participantID])
  }

  removeParticipant = async (threadID: string, participantID: string) => {
    if (threadID === NOTIFICATIONS_THREAD_ID) throw new Error('Participants cannot be removed from the notifications thread')
    if (participantID !== this.currentUser.id) return
    await this.deleteThread(threadID)
  }

  getLinkPreview = async (linkURL: string) => {
    const res = await this.api.cards_preview(linkURL)
    if (res.result === 'CARD_FOUND') return mapMessageLink(res.card)
  }

  reportThread = async (type: 'spam', threadID: string, firstMessageID: string) => {
    if (threadID === NOTIFICATIONS_THREAD_ID) throw new Error('Notifications thread cannot be reported')
    const result = await texts.openBrowserWindow(this.accountID, {
      windowTitle: 'Report thread',
      url: 'https://twitter.com/i/safety/report_story?' + new URLSearchParams({
        client_location: encodeURIComponent('messages:thread:'),
        client_referer: encodeURIComponent('/messages/threadID'),
        client_app_id: '3033300',
        source: 'reportdmconversation',
        report_flow_id: uuid(),
        // 1270667971933794305-1324055140446441472 -> 1270667971933794305
        reported_user_id: threadID.includes('-') // single threads have a -
          ? threadID.replace(this.currentUser.id, '').replace('-', '')
          : '0',
        reported_direct_message_conversation_id: threadID,
        initiated_in_app: '1',
        lang: 'en',
      }).toString(),
      cookieJar: this.api.cookieJar.toJSON(),
    })
    const cj = CookieJar.fromJSON(result.cookieJar as any)
    await this.api.setLoginState(cj)
    return true
  }

  registerForPushNotifications = async (type: keyof NotificationsInfo, token: string) => {
    if (type !== 'web') throw Error('invalid type')
    const parsed: PushSubscriptionJSON = JSON.parse(token)
    await this.api.notifications_settings_login(parsed.endpoint, parsed.keys.p256dh, parsed.keys.auth)
  }

  unregisterForPushNotifications = async (type: keyof NotificationsInfo, token: string) => {
    if (type !== 'web') throw Error('invalid type')
    const parsed: PushSubscriptionJSON = JSON.parse(token)
    await this.api.notifications_settings_logout(parsed.endpoint, parsed.keys.p256dh, parsed.keys.auth)
  }
}
