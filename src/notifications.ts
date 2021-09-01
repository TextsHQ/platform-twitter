import { texts, Message, Thread, PaginationArg, User, InboxName, ServerEventType } from '@textshq/platform-sdk'

import { mapNotification, mapTweetNotification } from './mappers'
import icons from './icons'
import { NOTIFICATIONS_THREAD_ID } from './constants'
import type TwitterAPI from './network-api'
import type PAPI from './api'

export default class Notifications {
  constructor(
    private readonly papi: InstanceType<typeof PAPI>,
    private readonly api: TwitterAPI,
  ) {
    this.poll()
  }

  messageTweetMap = new Map<string, string>()

  pollCursor: string

  parseMessagesInTimeline(json: any, updatePollCursor = !this.pollCursor) {
    const cursors: { Top: string, Bottom: string } = { Top: null, Bottom: null }
    const messages: Message[] = []
    json.timeline.instructions?.forEach(instruction => {
      const [name, value] = Object.entries<any>(instruction)[0]
      switch (name) {
        case 'addEntries':
          value.entries?.forEach(entry => {
            const id = entry.entryId
            if (entry.content.operation) {
              const { cursorType, value } = entry.content.operation.cursor
              cursors[cursorType] = value
              if (updatePollCursor) this.pollCursor = cursors.Top
            } else if (entry.content.item) {
              const { content } = entry.content.item
              if (content.tweet) {
                messages.push(mapTweetNotification(json.globalObjects, entry, this.papi.currentUser.id_str))
                this.messageTweetMap.set(id, entry.content.item.content.tweet.id)
              } else if (content.notification) {
                const nEntry = json.globalObjects.notifications[content.notification.id]
                const tweetID = nEntry.template?.aggregateUserActionsV1?.targetObjects[0]?.tweet.id
                this.messageTweetMap.set(id, tweetID)
                const m = mapNotification(json.globalObjects, id, content.notification, this.papi.currentUser.id_str)
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

        case 'clearCache':
        case 'clearEntriesUnreadState':
          break

        default:
          texts.log('getNotificationMessages: unrecognized', name, value)
      }
    })
    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    if (messages.length > 0) {
      messages[0].cursor = cursors.Bottom
      messages[messages.length - 1].cursor = cursors.Top
    }
    return messages
  }

  async getMessages(pagination: PaginationArg) {
    const { json } = await this.api.notifications_all(pagination?.cursor)
    if (!json.globalObjects) return { items: [], hasMore: false }
    const messages = this.parseMessagesInTimeline(json)
    return { items: messages, hasMore: true }
  }

  async getThread() {
    const participants = Object.keys(icons).map<User>(iconName => ({
      id: iconName,
      fullName: ' ',
      imgURL: icons[iconName],
    }))
    const messages = await this.getMessages(undefined)
    const thread: Thread = {
      id: NOTIFICATIONS_THREAD_ID,
      type: 'channel',
      title: `Notifications for ${this.papi.currentUser.name}`,
      description: 'This chat has all your Twitter notifications. React to a message with ❤️ to like the tweet.',
      isReadOnly: true,
      isUnread: messages.items.some(m => m.extra.unread),
      folderName: InboxName.NORMAL,
      messages,
      participants: { items: participants, hasMore: false },
    }
    return thread
  }

  addReaction(messageID: string, reactionKey: string) {
    if (reactionKey !== 'heart') throw Error('invalid reactionKey')
    const tweetID = this.messageTweetMap.get(messageID)
    if (tweetID) return this.api.favoriteTweet(tweetID)
  }

  removeReaction(messageID: string, reactionKey: string) {
    if (reactionKey !== 'heart') throw Error('invalid reactionKey')
    const tweetID = this.messageTweetMap.get(messageID)
    if (tweetID) return this.api.unfavoriteTweet(tweetID)
  }

  private pollTimeout: NodeJS.Timeout

  poll = async () => {
    clearTimeout(this.pollTimeout)
    if (this.papi.disposed) return
    let nextFetchTimeoutMs = 30_000
    if (this.papi.userUpdatesCursor) {
      try {
        const { json, headers } = await this.api.notifications_all(this.pollCursor) || {}
        // texts.log(JSON.stringify(json, null, 2))
        if (json) {
          const messages = this.parseMessagesInTimeline(json, true)
          texts.log('[twitter poll notifications]', messages.length, 'new messages')
          if (messages.length > 0) {
            this.papi.onServerEvent([{
              type: ServerEventType.STATE_SYNC,
              mutationType: 'upsert',
              objectName: 'message',
              objectIDs: { threadID: NOTIFICATIONS_THREAD_ID },
              entries: messages,
            }])
          }
        } else if (json?.errors[0]?.code === 88) { // RateLimitExceeded
          const rateLimitReset = headers['x-rate-limit-reset']
          const resetMs = (+rateLimitReset * 1000) - Date.now()
          nextFetchTimeoutMs = resetMs
          console.log('[twitter poll notifications] rate limit exceeded, next fetch:', resetMs)
        } else {
          console.log('[twitter poll notifications] json is falsey')
          nextFetchTimeoutMs = 60_000
        }
      } catch (err) {
        nextFetchTimeoutMs = 60_000
        const isOfflineError = err.name === 'RequestError' && (err.code === 'ENETDOWN' || err.code === 'EADDRNOTAVAIL')
        if (!isOfflineError) {
          console.error('tw error', err)
          texts.Sentry.captureException(err)
        }
      }
    } else {
      texts.log('[twitter poll notifications] skipping polling bc !this.userUpdatesCursor')
    }
    this.pollTimeout = setTimeout(this.poll, nextFetchTimeoutMs)
  }

  markRead = (cursor: string) =>
    this.api.notifications_all_last_seen_cursor(cursor)
}
