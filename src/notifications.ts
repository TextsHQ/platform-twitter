import { texts, Message, Thread, PaginationArg, User, InboxName } from '@textshq/platform-sdk'

import { mapNotification, mapTweetNotification } from './mappers'
import icons from './icons'
import { NOTIFICATIONS_THREAD_ID } from './constants'
import type TwitterAPI from './network-api'
import type PAPI from './api'

export default class Notifications {
  constructor(
    private readonly papi: InstanceType<typeof PAPI>,
    private readonly api: TwitterAPI,
  ) {}

  messageTweetMap = new Map<string, string>()

  async getMessages(pagination: PaginationArg) {
    const cursors = { Top: null, Bottom: null }
    const all = await this.api.notifications_all(pagination?.cursor)
    if (!all.globalObjects) return { items: [], hasMore: false }
    const messages: Message[] = []
    all.timeline.instructions?.forEach(instruction => {
      const [name, value] = Object.entries<any>(instruction)[0]
      switch (name) {
        case 'addEntries':
          value.entries?.forEach(entry => {
            const id = entry.entryId
            if (entry.content.operation) {
              const { cursorType, value } = entry.content.operation.cursor
              cursors[cursorType] = value
            } else if (entry.content.item) {
              const { content } = entry.content.item
              if (content.tweet) {
                messages.push(mapTweetNotification(all.globalObjects, entry, this.papi.currentUser.id_str))
                this.messageTweetMap.set(id, entry.content.item.content.tweet.id)
              } else if (content.notification) {
                const nEntry = all.globalObjects.notifications[content.notification.id]
                const tweetID = nEntry.template?.aggregateUserActionsV1?.targetObjects[0]?.tweet.id
                this.messageTweetMap.set(id, tweetID)
                const m = mapNotification(all.globalObjects, id, content.notification, this.papi.currentUser.id_str)
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
    const notifs = all.globalObjects.notifications
    if (!notifs) return { items: [], hasMore: false }
    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    messages[0].cursor = cursors.Bottom
    messages[messages.length - 1].cursor = cursors.Top
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
}
