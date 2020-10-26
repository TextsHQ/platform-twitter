import { orderBy, pick, maxBy, truncate } from 'lodash'
import he from 'he'
import { Message, Thread, Participant, MessageReaction, MessageSeen, ServerEvent, MessageAttachment, CurrentUser, MessageAttachmentType, MessageActionType, ServerEventType, UNKNOWN_DATE, texts, MessageLink, TextEntity } from '@textshq/platform-sdk'

import { supportedReactions, MessageType } from './constants'

export function mapParticipant(user: any, participant: any): Participant {
  if (!user) return
  return {
    id: user.id_str,
    username: user.screen_name,
    fullName: user.name,
    imgURL: user.profile_image_url_https.replace('_normal', ''),
    isVerified: user.verified,
    cannotMessage: user.is_dm_able === false,
    isAdmin: !!participant.is_admin,
  }
}

export function mapCurrentUser(user: any): CurrentUser {
  return {
    id: user.id_str,
    fullName: user.name,
    displayText: '@' + user.screen_name,
    imgURL: user.profile_image_url_https.replace('_normal', ''),
    isVerified: user.verified,
  }
}

const MAP_THREAD_TYPE = {
  ONE_TO_ONE: 'single',
  GROUP_DM: 'group',
}

export function mapThread(thread: any, users: any, currentUserTw: any): Thread {
  const participants = orderBy(
    (thread.participants as any[]).map(p => mapParticipant(users[p.user_id], p)),
    u => u.id === currentUserTw.id_str,
  )
  const mapped: Thread = {
    _original: thread,
    id: thread.conversation_id,
    isReadOnly: thread.read_only,
    imgURL: thread.avatar_image_https,
    isUnread: null,
    messages: null,
    participants: {
      hasMore: false,
      items: participants,
    },
    title: thread.name,
    timestamp: new Date(+thread.sort_timestamp || Date.now()),
    type: MAP_THREAD_TYPE[thread.type],
  }
  if (thread.notifications_disabled) {
    mapped.mutedUntil = thread.mute_expiration_time ? new Date(+thread.mute_expiration_time) : 'forever'
  }
  return mapped
}

const REACTION_MAP_TO_NORMALIZED = {
  funny: 'laugh',
  surprised: 'surprised',
  sad: 'cry',
  like: 'heart',
  excited: 'fire',
  agree: 'like',
  disagree: 'dislike',
}

export const REACTION_MAP_TO_TWITTER = {
  laugh: 'funny',
  surprised: 'surprised',
  cry: 'sad',
  heart: 'like',
  fire: 'excited',
  like: 'agree',
  dislike: 'disagree',
}

const mapReaction = ({ sender_id: participantID, reaction_key }: any) => ({
  id: participantID,
  participantID,
  reactionName: REACTION_MAP_TO_NORMALIZED[reaction_key] || reaction_key,
})

const mapReactions = (reactions: any[]) =>
  reactions.map<MessageReaction>(mapReaction)

function getSeen(threadParticipants: any[] = [], msg: any): MessageSeen {
  const result = {}
  threadParticipants.forEach(({ user_id, last_read_event_id }) => {
    if (!last_read_event_id || msg.id > last_read_event_id) return
    result[user_id] = UNKNOWN_DATE
  })
  return result
}

const getVideo = (video: any): MessageAttachment => ({
  id: video.id_str,
  type: MessageAttachmentType.VIDEO,
  srcURL: maxBy((video.video_info.variants as any[]).filter(v => v.content_type === 'video/mp4'), 'bitrate')?.url,
  size: pick(video.original_info, ['width', 'height']),
})
const getDynamicPhoto = (photo: any): MessageAttachment => ({
  id: photo.id_str,
  type: MessageAttachmentType.IMG,
  srcURL: `asset://${Buffer.from(photo.media_url_https).toString('base64')}`,
  size: pick(photo.original_info, ['width', 'height']),
})
const getPhoto = (photo: any): MessageAttachment => ({
  id: photo.id_str,
  type: MessageAttachmentType.IMG,
  srcURL: photo.media_url_https,
  size: pick(photo.original_info, ['width', 'height']),
})

export function mapMessageLink(card: any): MessageLink {
  const bv = card.binding_values
  const imgOriginal = bv?.thumbnail_image_large || bv?.thumbnail_image_original || bv?.player_image_original || bv?.event_thumbnail_original
  return {
    url: bv?.card_url?.string_value,
    title: bv?.event_title?.string_value || bv?.title?.string_value,
    summary: bv?.event_subtitle?.string_value || bv?.description?.string_value,
    img: imgOriginal?.image_value?.url,
    imgSize: { width: imgOriginal?.image_value?.width, height: imgOriginal?.image_value?.height },
  }
}

function mapEntities(entities: any) {
  if (!entities) return
  return [
    ...(entities?.urls as any[] || []).map<TextEntity>(url => (
      {
        from: url.indices[0],
        to: url.indices[1],
        replaceWith: url.expanded_url.replace(/^https?:\/\//, ''),
      }
    )),
    ...(entities?.hashtags as any[] || []).map<TextEntity>(ht => (
      {
        from: ht.indices[0],
        to: ht.indices[1],
        link: `https://twitter.com/hashtag/${ht.text}?src=hashtag_click`,
      }
    )),
    ...(entities?.symbols as any[] || []).map<TextEntity>(symbol => (
      {
        from: symbol.indices[0],
        to: symbol.indices[1],
        link: `https://twitter.com/search?q=${encodeURIComponent(symbol.text)}&src=cashtag_click`,
      }
    )),
    ...(entities?.user_mentions as any[] || []).map<TextEntity>(mention => (
      {
        from: mention.indices[0],
        to: mention.indices[1],
        mentionedUser: {
          id: mention.id_str,
        },
      }
    )),
  ]
}

export function mapMessage(m: any, currentUserID: string, threadParticipants: any): Message {
  const type = Object.keys(m)[0]
  const msg = m[type]
  const mapped: Message = {
    _original: [m, currentUserID, threadParticipants],
    id: msg.id,
    timestamp: new Date(+msg.time),
    reactions: mapReactions(msg.message_reactions || []),
    seen: getSeen(threadParticipants, msg),
    isSender: false,
    senderID: null,
    text: null,
    link: undefined,
    attachments: [],
  }
  if (msg.message_data) {
    mapped.senderID = msg.message_data.sender_id
    mapped.text = msg.message_data.text
    const entities = mapEntities(msg.message_data.entities)
    if (entities?.length > 0) {
      mapped.textAttributes = {
        entities,
        heDecode: true,
      }
    } else {
      mapped.text = he.decode(mapped.text)
    }
    const { video, photo, tweet, animated_gif, fleet, card } = msg.message_data.attachment || {}
    if (card) {
      mapped.link = mapMessageLink(card)
    }
    if (tweet) {
      mapped.tweet = {
        id: tweet.id,
        url: tweet.expanded_url,
        text: he.decode(tweet.status.full_text),
        timestamp: tweet.status.created_at,
        user: {
          name: tweet.status.user.name,
          username: tweet.status.user.screen_name,
          imgURL: tweet.status.user.profile_image_url_https,
        },
        attachments: ((tweet.status.extended_entities?.media || tweet.status.entities?.media) as any[])?.map(a => {
          if (a.type === 'video') return getVideo(a)
          if (a.type === 'animated_gif') return { ...getVideo(a), isGif: true }
          if (a.type === 'photo') return getPhoto(a)
          return null
        }).filter(Boolean),
      }
    }
    if (animated_gif) {
      mapped.attachments.push({ ...getVideo(animated_gif), isGif: true })
    }
    if (video) {
      mapped.attachments.push(getVideo(video))
    }
    if (photo) {
      mapped.attachments.push(getDynamicPhoto(photo))
    }
    if (fleet) {
      mapped.textHeading = 'Replied to fleet'
    }
  } else {
    mapped.isAction = true
    mapped.parseTemplate = true
    const participants = msg.participants as any[]
    if ([MessageType.JOIN_CONVERSATION, MessageType.PARTICIPANTS_JOIN].includes(type as MessageType)) {
      mapped.senderID = msg.sender_id
      mapped.text = `{{sender}} added ${participants.map(p => p.user_id).filter(u => u !== mapped.senderID).map(u => `{{${u}}}`).join(', ')}`
      mapped.action = {
        type: MessageActionType.THREAD_PARTICIPANTS_ADDED,
        participantIDs: participants.map(p => p.user_id),
        actorParticipantID: mapped.senderID,
      }
    } else if (type === MessageType.CONVERSATION_AVATAR_UPDATE) {
      mapped.senderID = msg.by_user_id
      mapped.text = '{{sender}} changed the group photo'
    } else if (type === MessageType.CONVERSATION_NAME_UPDATE) {
      mapped.senderID = msg.by_user_id
      mapped.text = `{{sender}} changed the group name to ${msg.conversation_name}`
      mapped.action = {
        type: MessageActionType.THREAD_TITLE_UPDATED,
        title: msg.conversation_name,
        actorParticipantID: mapped.senderID,
      }
    } else if (type === MessageType.PARTICIPANTS_LEAVE) {
      mapped.text = `${participants.map(p => `{{${p.user_id}}}`).join(', ')} left`
      mapped.action = {
        type: MessageActionType.THREAD_PARTICIPANTS_REMOVED,
        participantIDs: participants.map(p => p.user_id),
        actorParticipantID: null,
      }
    } else if (type === MessageType.TRUST_CONVERSATION) {
      if (msg.reason === 'accept') {
        mapped.text = 'You accepted the request'
        mapped.action = { type: MessageActionType.MESSAGE_REQUEST_ACCEPTED }
      } else if (msg.reason === 'follow') {
        mapped.text = 'You followed this account'
        mapped.action = { type: MessageActionType.MESSAGE_REQUEST_ACCEPTED }
      }
    } else if (type === 'conversation_create') {
      return null
    }
  }
  mapped.senderID = String(mapped.senderID)
  mapped.isSender = mapped.senderID === String(currentUserID)
  return mapped
}

function getReactionMessages(m: any, currentUserID: string) {
  const msg = Object.values(m)[0] as any
  if (!msg.message_reactions) return []
  return (msg.message_reactions as any[]).map<Message>(r => {
    const truncated = truncate(m.message_data?.text)
    const senderID = String(r.sender_id)
    const reactionName = REACTION_MAP_TO_NORMALIZED[r.reaction_key] || r.reaction_key
    return {
      _original: r,
      id: r.id,
      timestamp: new Date(+r.time),
      senderID,
      isSender: String(r.sender_id) === currentUserID,
      reactions: [],
      attachments: [],
      text: `{{sender}} reacted with ${supportedReactions[reactionName]?.render || r.reaction_key}${truncated ? `: ${truncated}` : ''}`,
      action: {
        type: MessageActionType.MESSAGE_REACTION_CREATED,
        messageID: m.id,
        participantID: senderID,
        reactionName,
      },
      parseTemplate: true,
      isAction: true,
      isHidden: true,
    }
  })
}

export const mapMessages = (messages: any[], thread: any, currentUserID: string): Message[] =>
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

export function mapThreads(json: any, currentUser: any, inboxType: string): Thread[] {
  if (!json) return []
  const { conversations, entries, users } = json
  const threads = Object.values(conversations || {})
  const groupedMessages = groupMessages(entries || [])
  return threads.map((t: any) => {
    if (t.trusted !== (inboxType === 'trusted')) return null
    const thread = mapThread(t, users, currentUser)
    const messages = mapMessages(groupedMessages[t.conversation_id] || [], thread._original, currentUser.id_str)
    const lastMessage = messages[messages.length - 1]
    return {
      ...thread,
      messages: {
        hasMore: t.status !== 'AT_END',
        items: messages,
        oldestCursor: t.min_entry_id,
      },
      isUnread: +t.last_read_event_id < +lastMessage?.id && !lastMessage?.isSender,
    }
  }).filter(Boolean)
}

export function mapEvent(event: any): ServerEvent {
  const payloadType = Object.keys(event.payload)[0]
  if (!['dm_update', 'dm_typing'].includes(payloadType)) return
  const { conversation_id: threadID, user_id: participantID } = event.payload[payloadType]
  if (payloadType === 'dm_typing') {
    return {
      type: ServerEventType.PARTICIPANT_TYPING,
      typing: true,
      threadID,
      participantID,
      durationMs: 3_000,
    }
  }
  // if (payloadType === 'dm_update') return null
}

export function mapUserUpdate(entryObj: any, currentUserID: string, json: any): ServerEvent | ServerEvent[] {
  const getMessageCreated = (): ServerEvent => {
    const message = mapMessage(entryObj, currentUserID, json.user_events.conversations[threadID]?.participants)
    return {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'created',
      objectName: 'message',
      objectID: [threadID, message.id],
      data: message,
    }
  }
  const [entryType] = Object.keys(entryObj)
  const entry = entryObj[entryType]
  const threadID = entry.conversation_id

  switch (entryType) {
    // case MessageType.CONVERSATION_READ:
    //   return {
    //     type: ServerEventType.THREAD_PROPS_UPDATED,
    //     threadID,
    //     props: { isUnread: false },
    //   }

    case MessageType.REMOVE_CONVERSATION:
      return {
        type: ServerEventType.STATE_SYNC,
        mutationType: 'deleted',
        objectID: [threadID],
        objectName: 'thread',
      }

    case MessageType.MESSAGE:
    case MessageType.PARTICIPANTS_JOIN:
    case MessageType.PARTICIPANTS_LEAVE:
    case MessageType.JOIN_CONVERSATION:
    case MessageType.CONVERSATION_AVATAR_UPDATE:
    case MessageType.CONVERSATION_NAME_UPDATE:
    case MessageType.WELCOME_MESSAGE:
      return getMessageCreated()

    case MessageType.TRUST_CONVERSATION:
      return [
        {
          type: ServerEventType.THREAD_TRUSTED,
          threadID,
        },
        getMessageCreated(),
      ]

    case MessageType.REACTION_CREATE: {
      const reaction = mapReaction(entry)
      return [{
        type: ServerEventType.STATE_SYNC,
        mutationType: 'created',
        objectName: 'message_reaction',
        objectID: [threadID, entry.message_id, reaction.id],
        data: reaction,
      }, {
        type: ServerEventType.THREAD_MESSAGES_REFRESH,
        threadID,
      }]
    }

    case MessageType.REACTION_DELETE:
      return {
        type: ServerEventType.STATE_SYNC,
        mutationType: 'deleted',
        objectName: 'message_reaction',
        objectID: [threadID, entry.message_id, String(entry.sender_id)],
      }
  }
  texts.log(entryType, entry)
  console.log('unknown twitter entry', entryType)
  return { type: ServerEventType.THREAD_MESSAGES_REFRESH, threadID }
}
