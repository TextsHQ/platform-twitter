import { orderBy, pick, maxBy, truncate } from 'lodash'
import he from 'he'
import path from 'path'
import {
  Message,
  Thread,
  Participant,
  MessageReaction,
  MessageSeen,
  ServerEvent,
  Attachment,
  AttachmentType,
  MessageActionType,
  ServerEventType,
  UNKNOWN_DATE,
  texts,
  MessageLink,
  TextEntity,
  MessageButton,
  InboxName,
  ActivityType,
  Tweet,
  MessageBehavior,
  User,
  PartialWithID,
} from '@textshq/platform-sdk'

import { supportedReactions, MessageType } from './constants'
import type { TwitterUser, TwitterThreadParticipant, TwitterThread, TwitterMessage, CallEndReason, CallType, EndAVBroadcastMessage } from './twitter-types'

const TWITTER_EPOCH = 1288834974657
function getTimestampFromSnowflake(snowflake: string) {
  if (!snowflake) return
  const int = BigInt.asUintN(64, BigInt(snowflake))
  const dateBits = Number(int >> 22n)
  return new Date(dateBits + TWITTER_EPOCH)
}

interface EntityBase {
  indices: [number, number]
}
interface Entities {
  hashtags?: (EntityBase & {
    text: string
  })[]
  symbols?: (EntityBase & {
    text: string
  })[]
  user_mentions?: (EntityBase & {
    id_str: string
    screen_name: string
  })[]
  media?: EntityBase[]
  urls?: (EntityBase & {
    url: string
    expanded_url: string
    display_url: string
  })[]
}

function mapEntities(entities: Entities, removeIndices?: [number, number][]): TextEntity[] {
  if (!entities) return
  return [
    ...(entities?.urls || []).map<TextEntity>(url => {
      const shouldRemove = url.expanded_url.startsWith('https://twitter.com/messages/media/') || removeIndices?.toString() === url.indices.toString()
      const from = Math.max(0, url.indices[0] + (shouldRemove ? -1 : 0))
      const to = url.indices[1]
      if (shouldRemove) {
        return { from, to, replaceWith: '' }
      }
      return {
        from,
        to,
        replaceWith: url.expanded_url.replace(/^https?:\/\//, ''),
        link: url.expanded_url,
      }
    }),
    ...(entities?.hashtags || []).map<TextEntity>(ht => (
      {
        from: ht.indices[0],
        to: ht.indices[1],
        link: `https://x.com/hashtag/${ht.text}?src=hashtag_click`,
      }
    )),
    ...(entities?.symbols || []).map<TextEntity>(symbol => (
      {
        from: symbol.indices[0],
        to: symbol.indices[1],
        link: `https://x.com/search?q=${encodeURIComponent(symbol.text)}&src=cashtag_click`,
      }
    )),
    ...(entities?.user_mentions || []).map<TextEntity>(mention => (
      {
        from: mention.indices[0],
        to: mention.indices[1],
        mentionedUser: {
          id: mention.id_str,
          username: mention.screen_name,
        },
      }
    )),
    ...(entities?.media || []).map<TextEntity>(mention => (
      {
        from: mention.indices[0],
        to: mention.indices[1],
        replaceWith: '',
      }
    )),
  ]
}

export function mapUser(user: TwitterUser): User {
  if (!user) return
  return {
    id: user.id_str,
    username: user.screen_name,
    fullName: user.name,
    imgURL: user.profile_image_url_https.replace('_normal', ''),
    isVerified: user.verified,
    cannotMessage: user.is_dm_able === false,
    social: {
      followers: { count: user.followers_count },
      followingUsers: { count: user.friends_count },
      website: user.entities?.url?.urls?.[0]?.expanded_url ?? user.url,
      location: user.location,
      bio: {
        text: user.description,
        attributes: {
          heDecode: true,
          entities: mapEntities(user.entities?.description),
        },
      },
      following: user.following,
      followedBy: user.followed_by,
      coverImgURL: user.profile_banner_url,
    },
  }
}
export function mapParticipant(user: TwitterUser, participant: TwitterThreadParticipant): Participant {
  if (!user) return
  return {
    ...mapUser(user),
    isAdmin: !!participant.is_admin,
  }
}

const MAP_THREAD_TYPE = {
  ONE_TO_ONE: 'single',
  GROUP_DM: 'group',
}

export function mapThread(thread: TwitterThread, users: Record<string, TwitterUser> = {}, currentUser: User): Thread {
  const twParticipants = thread.participants as TwitterUser[]
  const participants = orderBy(
    twParticipants.map(p => mapParticipant(users[p.user_id], p)).filter(Boolean),
    u => u.id === currentUser.id,
  )
  const mapped: Thread = {
    _original: JSON.stringify(thread),
    id: thread.conversation_id,
    folderName: thread.trusted ? InboxName.NORMAL : InboxName.REQUESTS,
    isReadOnly: thread.read_only,
    lastReadMessageID: thread.last_read_event_id,
    imgURL: thread.avatar_image_https,
    isUnread: null,
    messages: null,
    participants: {
      hasMore: false,
      items: participants,
    },
    title: thread.name,
    timestamp: +thread.sort_timestamp ? new Date(+thread.sort_timestamp) : undefined,
    type: MAP_THREAD_TYPE[thread.type],
  }
  if (thread.notifications_disabled) {
    mapped.mutedUntil = thread.mute_expiration_time ? new Date(+thread.mute_expiration_time) : 'forever'
  }
  return mapped
}

const REACTION_MAP_TO_NORMALIZED = {
  funny: '😂',
  surprised: '😲',
  sad: '😢',
  like: '❤️',
  excited: '🔥',
  agree: '👍',
  disagree: '👎',
}

// export const REACTION_MAP_TO_TWITTER = {
//   laugh: 'funny',
//   surprised: 'surprised',
//   cry: 'sad',
//   heart: 'like',
//   fire: 'excited',
//   like: 'agree',
//   dislike: 'disagree',
// }

const mapReaction = ({ sender_id: participantID, reaction_key, emoji_reaction }: any) => ({
  id: participantID,
  participantID,
  reactionKey: reaction_key === 'emoji' ? emoji_reaction.toLowerCase() : REACTION_MAP_TO_NORMALIZED[reaction_key] || reaction_key,
})

const mapReactions = (reactions: any[]) =>
  reactions.map<MessageReaction>(mapReaction)

function getSeen(threadParticipants: TwitterUser[], msg: TwitterMessage): MessageSeen {
  const result: { [userID: string]: Date } = {}
  threadParticipants?.forEach(({ user_id, last_read_event_id }) => {
    if (!last_read_event_id || msg.id > last_read_event_id) return
    result[user_id] = UNKNOWN_DATE
  })
  return result
}

const getVideo = (video: any): Attachment => ({
  id: video.id_str,
  type: video.audio_only ? AttachmentType.AUDIO : AttachmentType.VIDEO,
  srcURL: maxBy((video.video_info.variants as any[]).filter(v => v.content_type === 'video/mp4'), 'bitrate')?.url,
  size: pick(video.original_info, ['width', 'height']),
  isVoiceNote: video.audio_only ? true : null,
  posterImg: video.media_url_https,
})
const getDynamicPhoto = (photo: any): Attachment => ({
  id: photo.id_str,
  type: AttachmentType.IMG,
  srcURL: `asset://$accountID/media/${Buffer.from(photo.media_url_https).toString('hex')}`,
  fileName: path.basename(photo.media_url_https),
  size: pick(photo.original_info, ['width', 'height']),
})
const getPhoto = (photo: any): Attachment => ({
  id: photo.id_str,
  type: AttachmentType.IMG,
  srcURL: photo.media_url_https,
  size: pick(photo.original_info, ['width', 'height']),
})

export function mapMessageLink(card: any): MessageLink {
  const bv = card.binding_values
  const imgOriginal = bv?.thumbnail_image_large || bv?.thumbnail_image_original || bv?.player_image_original || bv?.event_thumbnail_original
  const imgWidth = imgOriginal?.image_value?.width
  const imgHeight = imgOriginal?.image_value?.height
  return {
    url: bv?.card_url?.string_value,
    title: bv?.event_title?.string_value || bv?.title?.string_value,
    summary: bv?.event_subtitle?.string_value || bv?.description?.string_value,
    img: imgOriginal?.image_value?.url,
    imgSize: imgWidth && imgHeight ? { width: imgWidth, height: imgHeight } : undefined,
  }
}

function mapTweet(tweet: any, user = tweet.user): Tweet {
  const tweetEntities = mapEntities(tweet.entities)
  const messageTweet: Tweet = {
    id: tweet.id_str,
    text: (tweet.full_text ?? tweet.text) + (tweet.card?.name.startsWith('poll') ? '\n\n[Poll]' : ''),
    timestamp: new Date(tweet.created_at),
    user: {
      name: user.name,
      username: user.screen_name,
      imgURL: user.profile_image_url_https,
      isVerified: user.verified,
    },
    attachments: ((tweet.extended_entities?.media || tweet.entities?.media) as any[])?.map(a => {
      if (a.type === 'video') return getVideo(a)
      if (a.type === 'animated_gif') return { ...getVideo(a), isGif: true }
      if (a.type === 'photo') return getPhoto(a)
      return null
    }).filter(Boolean),
  }
  if (tweetEntities?.length > 0) {
    messageTweet.textAttributes = {
      entities: tweetEntities,
      heDecode: true,
    }
  } else if (messageTweet.text) {
    messageTweet.text = he.decode(messageTweet.text)
  }
  return messageTweet
}

const getCallMessageText = (msg: EndAVBroadcastMessage): string => {
  const isAudioCall = msg.call_type === 'AUDIO_ONLY'
  const callType = isAudioCall ? 'audio call' : 'video call'

  switch (msg.end_reason) {
    case 'CANCELED':
      return `Canceled ${callType}`
    case 'MISSED':
      return `Missed ${callType}`
    case 'DECLINED':
      return `Declined ${callType}`
    case 'TIMED_OUT':
    case 'HUNG_UP':
      return `${isAudioCall ? 'Audio call' : 'Video call'} ended`
    default:
      return `${isAudioCall ? 'Audio call' : 'Video call'}`
  }
}

export function mapMessage(m: TwitterMessage, currentUserID: string, threadParticipants: TwitterUser[]): Message {
  const type = Object.keys(m)[0]
  const msg = m[type]
  const mapped: Message = {
    _original: JSON.stringify([m]),
    id: msg.id,
    timestamp: new Date(+msg.time),
    reactions: mapReactions(msg.message_reactions || []),
    seen: getSeen(threadParticipants, msg),
    isSender: false,
    senderID: null,
    text: null,
    linkedMessageID: msg.message_data?.reply_data?.id,
  }
  if (msg.affects_sort === false) {
    mapped.behavior = MessageBehavior.SILENT
  }
  if (msg.message_data) {
    mapped.senderID = msg.message_data.sender_id
    mapped.text = msg.message_data.text
    const { video, photo, tweet, animated_gif, fleet, card } = msg.message_data.attachment || {}
    const removeIndices = tweet?.indices
    const entities = mapEntities(
      msg.message_data.entities,
      mapped.text?.length === removeIndices?.[1] ? removeIndices : undefined, // hide tweet url only if no other text is present
    )
    if (entities?.length > 0) {
      mapped.textAttributes = {
        entities,
        heDecode: true,
      }
    } else if (mapped.text) {
      mapped.text = he.decode(mapped.text)
    }
    if (card) {
      mapped.links = [mapMessageLink(card)]
    }
    if (tweet) {
      mapped.tweets = [mapTweet(tweet.status)]
    }
    if (animated_gif) {
      mapped.attachments ||= []
      mapped.attachments.push({ ...getVideo(animated_gif), isGif: true })
    }
    if (video) {
      mapped.attachments ||= []
      mapped.attachments.push(getVideo(video))
    }
    if (photo) {
      mapped.attachments ||= []
      mapped.attachments.push(getDynamicPhoto(photo))
    }
    if (fleet) {
      mapped.textHeading = 'Replied to fleet'
    }
    const ctaButtons = (msg.message_data.ctas as any[])?.map<MessageButton>(cta => ({
      label: cta.label,
      linkURL: cta.url,
    }))
    const qrButtons = (msg.message_data.quick_reply?.options as any[])?.map<MessageButton>(qr => ({
      label: qr.label,
      linkURL: 'texts://fill-textarea?text=' + encodeURIComponent(qr.label),
    }))
    if (ctaButtons || qrButtons) mapped.buttons = [...(ctaButtons || []), ...(qrButtons || [])]
  } else {
    mapped.isAction = true
    mapped.parseTemplate = true
    const participants = msg.participants as any[]
    switch (type) {
      case MessageType.JOIN_CONVERSATION:
        mapped.senderID = msg.sender_id
        mapped.text = `{{sender}} added {{${currentUserID}}}`
        break
      case MessageType.PARTICIPANTS_JOIN:
        mapped.senderID = msg.sender_id
        mapped.text = `{{sender}} added ${participants.map(p => p.user_id).filter(u => u !== mapped.senderID).map(u => `{{${u}}}`).join(', ')}`
        mapped.action = {
          type: MessageActionType.THREAD_PARTICIPANTS_ADDED,
          participantIDs: participants.map(p => p.user_id),
          actorParticipantID: mapped.senderID,
        }
        break
      case MessageType.CONVERSATION_AVATAR_UPDATE:
        mapped.senderID = msg.by_user_id
        mapped.text = '{{sender}} changed the group photo'
        break
      case MessageType.CONVERSATION_NAME_UPDATE:
        mapped.senderID = msg.by_user_id
        mapped.text = `{{sender}} changed the group name to ${msg.conversation_name}`
        mapped.action = {
          type: MessageActionType.THREAD_TITLE_UPDATED,
          title: msg.conversation_name,
          actorParticipantID: mapped.senderID,
        }
        break
      case MessageType.PARTICIPANTS_LEAVE:
        mapped.text = `${participants.map(p => `{{${p.user_id}}}`).join(', ')} left`
        mapped.action = {
          type: MessageActionType.THREAD_PARTICIPANTS_REMOVED,
          participantIDs: participants.map(p => p.user_id),
          actorParticipantID: null,
        }
        break
      case MessageType.TRUST_CONVERSATION:
        mapped.senderID = currentUserID
        if (msg.reason === 'accept') {
          mapped.text = 'You accepted the request'
          mapped.action = { type: MessageActionType.MESSAGE_REQUEST_ACCEPTED }
        } else if (msg.reason === 'follow') {
          mapped.text = 'You followed this account'
          mapped.action = { type: MessageActionType.MESSAGE_REQUEST_ACCEPTED }
        }
        break
      case MessageType.END_AV_BROADCAST:
        mapped.text = getCallMessageText(msg)
        mapped.isAction = true
        break
      case MessageType.CONVERSATION_CREATE:
      case MessageType.CONVO_METADATA_UPDATE:
        return null
      default:
    }
  }
  if (mapped.senderID != null) mapped.senderID = String(mapped.senderID)
  else mapped.senderID = '$thread' // senderID is not optional. fallback to $thread
  mapped.isSender = mapped.senderID === String(currentUserID)
  return mapped
}

function getReactionMessages(m: TwitterMessage, currentUserID: string) {
  const msg = Object.values(m)[0] as any
  if (!msg.message_reactions) return []
  return (msg.message_reactions as any[]).map<Message>(reaction => {
    const truncated = truncate(m.message_data?.text)
    const senderID = String(reaction.sender_id)
    const reactionKey = reaction.reaction_key === 'emoji' ? reaction.emoji_reaction.toLowerCase() : REACTION_MAP_TO_NORMALIZED[reaction.reaction_key] || reaction.reaction_key
    const isSender = String(reaction.sender_id) === currentUserID
    return {
      _original: JSON.stringify(reaction),
      id: reaction.id,
      timestamp: new Date(+reaction.time),
      senderID,
      isSender,
      text: `${isSender ? 'You' : '{{sender}}'} reacted with ${supportedReactions[reactionKey]?.render || reactionKey}${truncated ? `: ${truncated}` : ''}`,
      action: {
        type: MessageActionType.MESSAGE_REACTION_CREATED,
        messageID: m.id,
        participantID: senderID,
        reactionKey,
      },
      parseTemplate: true,
      isAction: true,
      isHidden: true,
    }
  })
}

export const mapMessages = (messages: TwitterMessage[], thread: TwitterThread, currentUserID: string): Message[] =>
  orderBy(messages.flatMap(m => ([
    mapMessage(m, currentUserID, thread.participants),
    ...getReactionMessages(m, currentUserID),
  ])).filter(Boolean), 'timestamp')
// orderBy(messages.map(m => mapMessage(m, currentUserID, thread.participants)).filter(Boolean), 'timestamp')

function groupMessages(entries: any[]) {
  const messages = {}
  entries.forEach(m => {
    const type = Object.keys(m)[0]
    const { conversation_id: threadID } = m[type]
    if (!messages[threadID]) messages[threadID] = []
    messages[threadID].push(m)
  })
  return messages
}

export function mapThreads(json: any, currentUser: User, inboxType?: string): [Thread[], Thread[]] {
  const otherThreads: Thread[] = []
  const threads: Thread[] = []
  if (!json) return [threads, otherThreads]
  const { conversations, entries, users } = json
  const conversationValues = Object.values(conversations || {})
  const groupedMessages = groupMessages(entries || [])
  const map = (t: any) => {
    const thread = mapThread(t, users, currentUser)
    const messages = mapMessages(groupedMessages[t.conversation_id] || [], t, currentUser.id)
    const lastMessage = messages[messages.length - 1]
    return {
      ...thread,
      messages: {
        hasMore: t.status !== 'AT_END',
        items: messages,
        oldestCursor: t.min_entry_id,
      },
      isUnread: getTimestampFromSnowflake(t.last_read_event_id) < getTimestampFromSnowflake(lastMessage?.id) && !lastMessage?.isSender,
    }
  }
  conversationValues.forEach((t: any) => {
    if (inboxType && t.trusted !== (inboxType === 'trusted')) otherThreads.push(map(t))
    else threads.push(map(t))
  })
  return [threads, otherThreads]
}

export function mapEvent(event: any): ServerEvent {
  const payloadType = Object.keys(event.payload)[0]
  if (!['dm_update', 'dm_typing'].includes(payloadType)) return
  const { conversation_id: threadID, user_id: participantID } = event.payload[payloadType]
  if (payloadType === 'dm_typing') {
    return {
      type: ServerEventType.USER_ACTIVITY,
      activityType: ActivityType.TYPING,
      threadID,
      participantID,
      durationMs: 5_000,
    }
  }
  // if (payloadType === 'dm_update') return null
}

export function mapUserUpdate(entryObj: any, currentUserID: string, json: any): ServerEvent | ServerEvent[] {
  const getMessageCreated = (): ServerEvent => {
    const conv = json.user_events.conversations[threadID]
    const message = mapMessage(entryObj, currentUserID, conv?.participants)
    return {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'upsert',
      objectName: 'message',
      objectIDs: { threadID },
      entries: [message],
    }
  }
  const [entryType] = Object.keys(entryObj)
  const entry = entryObj[entryType]
  const threadID = entry.conversation_id

  switch (entryType) {
    case MessageType.CONVERSATION_READ: {
      const conv = json.user_events.conversations[threadID]
      if (getTimestampFromSnowflake(conv.last_read_event_id) >= getTimestampFromSnowflake(conv.sort_event_id)) {
        return {
          type: ServerEventType.STATE_SYNC,
          mutationType: 'update',
          objectName: 'thread',
          objectIDs: {},
          entries: [
            {
              id: threadID,
              isUnread: false,
              lastReadMessageID: conv.last_read_event_id,
            },
          ],
        }
      }
      return {
        type: ServerEventType.THREAD_MESSAGES_REFRESH,
        threadID,
      }
    }

    case MessageType.DISABLE_NOTIFICATIONS: {
      const conv = json.user_events.conversations[threadID]
      return {
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'thread',
        objectIDs: {},
        entries: [
          {
            id: threadID,
            mutedUntil: conv?.mute_expiration_time ? new Date(+conv?.mute_expiration_time) : 'forever',
          },
        ],
      }
    }

    case MessageType.ENABLE_NOTIFICATIONS: {
      return {
        type: ServerEventType.STATE_SYNC,
        mutationType: 'update',
        objectName: 'thread',
        objectIDs: {},
        entries: [
          {
            id: threadID,
            mutedUntil: undefined,
          },
        ],
      }
    }

    case MessageType.REMOVE_CONVERSATION:
      return {
        type: ServerEventType.STATE_SYNC,
        mutationType: 'delete',
        objectName: 'thread',
        objectIDs: {},
        entries: [threadID],
      }

    case MessageType.MESSAGE_DELETE:
      return (entry.messages as any[])?.map<ServerEvent>(msg => ({
        type: ServerEventType.STATE_SYNC,
        mutationType: 'delete',
        objectName: 'message',
        objectIDs: { threadID },
        entries: [msg.message_id],
      }))

    case MessageType.MESSAGE:
    case MessageType.JOIN_CONVERSATION:
    case MessageType.WELCOME_MESSAGE:
      return getMessageCreated()

    case MessageType.PARTICIPANTS_JOIN:
      return [
        {
          type: ServerEventType.STATE_SYNC,
          mutationType: 'upsert',
          objectName: 'participant',
          objectIDs: { threadID: entry.conversation_id },
          entries: (entry.participants as any[]).map<Participant>(p => mapParticipant(json.user_events.users[p.user_id], p)),
        },
        getMessageCreated(),
      ]

    case MessageType.PARTICIPANTS_LEAVE:
      return [
        {
          type: ServerEventType.STATE_SYNC,
          mutationType: 'update',
          objectName: 'participant',
          objectIDs: { threadID: entry.conversation_id },
          entries: (entry.participants as any[]).map<PartialWithID<Participant>>(p => ({
            id: p.user_id,
            hasExited: true,
          })),
        },
        getMessageCreated(),
      ]

    case MessageType.CONVERSATION_NAME_UPDATE:
      return [
        {
          type: ServerEventType.STATE_SYNC,
          mutationType: 'update',
          objectName: 'thread',
          objectIDs: {},
          entries: [{
            id: entry.conversation_id,
            title: entry.conversation_name,
          }],
        },
        getMessageCreated(),
      ]

    case MessageType.CONVERSATION_AVATAR_UPDATE:
      return [
        {
          type: ServerEventType.STATE_SYNC,
          mutationType: 'update',
          objectName: 'thread',
          objectIDs: {},
          entries: [{
            id: entry.conversation_id,
            imgURL: entry.conversation_avatar_image_https,
          }],
        },
        getMessageCreated(),
      ]

    case MessageType.TRUST_CONVERSATION:
      return [
        {
          type: ServerEventType.STATE_SYNC,
          mutationType: 'update',
          objectName: 'thread',
          objectIDs: {},
          entries: [{
            id: threadID,
            folderName: InboxName.NORMAL,
          }],
        },
        getMessageCreated(),
      ]

    case MessageType.REACTION_CREATE: {
      const reaction = mapReaction(entry)
      return [{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'upsert',
        objectName: 'message_reaction',
        objectIDs: {
          threadID,
          messageID: entry.message_id,
        },
        entries: [reaction],
      }, {
        type: ServerEventType.THREAD_MESSAGES_REFRESH,
        threadID,
      }]
    }

    case MessageType.REACTION_DELETE:
      return {
        type: ServerEventType.STATE_SYNC,
        mutationType: 'delete',
        objectName: 'message_reaction',
        objectIDs: {
          threadID,
          messageID: entry.message_id,
        },
        entries: [String(entry.sender_id)],
      }

    default:
  }
  texts.log(entryType, entry)
  texts.Sentry.captureMessage('unknown twitter entry: ' + entryType)
  return { type: ServerEventType.THREAD_MESSAGES_REFRESH, threadID }
}

type GlobalObjects = {
  tweets: Record<string, any>
  users: Record<string, any>
  notifications: Record<string, any>
}

export const mapNotificationEntities = (globalObjects: GlobalObjects, entities: any[], offset = 0) =>
  entities.map<TextEntity>(entity => {
    const { id } = entity.ref?.user || {}
    return {
      from: offset + entity.fromIndex,
      to: offset + entity.toIndex,
      mentionedUser: id ? { id, username: globalObjects.users[id]?.screen_name } : undefined,
      bold: entity.format === 'Strong' || undefined,
    }
  })
export function mapNotification(globalObjects: GlobalObjects, id: string, notification: any, currentUserID: string): Message {
  const entry = globalObjects.notifications[notification.id]
  const tweetID = entry.template?.aggregateUserActionsV1?.targetObjects[0]?.tweet.id
  const users: TwitterUser[] = entry.template?.aggregateUserActionsV1?.fromUsers.map(({ user }) => globalObjects.users[user.id]) || []
  const tweet = globalObjects.tweets?.[tweetID]
  const timestamp = new Date(+entry.timestampMs)
  const prefixText = users.length ? `${' '.repeat(users.length * 3)}\n` : ''
  const entities = mapNotificationEntities(globalObjects, entry.message.entities, prefixText.length)
  if (users.length) {
    entities.unshift(...users.map<TextEntity>((user, i) => ({
      from: i + (2 * i),
      to: i + (2 * i) + 1,
      mentionedUser: { id: user.id_str, username: user.screen_name },
      replaceWithMedia: {
        mediaType: 'img',
        srcURL: user.profile_image_url_https.replace('_normal', ''),
        rounded: true,
        size: { width: 32, height: 32 },
      },
    })))
  }
  const text = prefixText + entry.message.text
  const link = notification.url?.url
  if (link.startsWith('https://')) { // ignore relative urt links
    entities.push({
      from: prefixText.length,
      to: text.length,
      link,
    })
  }
  return {
    _original: JSON.stringify([entry, notification, tweet]),
    id,
    text,
    textAttributes: {
      entities,
    },
    timestamp,
    senderID: `notifications_${entry.icon.id.split('_')?.[0]}`,
    isSender: false,
    tweets: tweet ? [mapTweet(tweet, globalObjects.users[tweet.user_id_str])] : undefined,
    reactions: tweet?.favorited ? [{ id: currentUserID, participantID: currentUserID, reactionKey: '❤️' }] : undefined,
  }
}
export function mapTweetNotification(globalObjects: GlobalObjects, entry: any, currentUserID: string): Message {
  const timestamp = new Date(+entry.sortIndex)
  const tweet = globalObjects.tweets?.[entry.content.item.content.tweet.id]
  return {
    _original: JSON.stringify(tweet),
    id: entry.entryId,
    senderID: 'notifications_bird',
    timestamp,
    tweets: tweet ? [mapTweet(tweet, globalObjects.users[tweet.user_id_str])] : undefined,
    reactions: tweet?.favorited ? [{ id: currentUserID, participantID: currentUserID, reactionKey: '❤️' }] : undefined,
    // buttons: [
    //   { label: 'Reply', linkURL: 'texts://' },
    // ],
  }
}
