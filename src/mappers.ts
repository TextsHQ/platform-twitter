import { orderBy, pick, maxBy, truncate } from 'lodash'
import he from 'he'
import { Message, Thread, Participant, MessageReaction, MessageSeen, ServerEvent, MessageAttachment, CurrentUser, MessageAttachmentType, MessageActionType, ServerEventType, UNKNOWN_DATE, texts } from '@textshq/platform-sdk'

import { supportedReactions, MessageType } from './constants'

// function replaceSubstringInIndices(mainStr: string, start: number, end: number, insertStr: string) {
//   return mainStr.substring(0, start) + insertStr + mainStr.substring(end)
// }

export function mapParticipant(user: any, participant: any): Participant {
  if (!user) return
  return {
    id: user.id_str,
    username: user.screen_name,
    fullName: user.name,
    imgURL: user.profile_image_url_https.replace('_normal', ''),
    isVerified: user.verified,
    isAdmin: !!participant.is_admin,
    cannotMessage: user.is_dm_able === false,
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
  srcURL: null,
  size: pick(photo.original_info, ['width', 'height']),
  extra: photo.media_url_https,
})
const getPhoto = (photo: any): MessageAttachment => ({
  id: photo.id_str,
  type: MessageAttachmentType.IMG,
  srcURL: photo.media_url_https,
  size: pick(photo.original_info, ['width', 'height']),
})

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
    if (mapped.text) {
      (msg.message_data.entities?.urls as any[] || []).forEach(url => {
        mapped.text = mapped.text.replace(url.url, url.expanded_url)
        // mapped.text = replaceSubstringInIndices(mapped.text, url.indices[0], url.indices[1], url.expanded_url)
      })
      mapped.text = he.decode(mapped.text)
    }
    const { video, photo, tweet, animated_gif, fleet, card } = msg.message_data.attachment || {}
    if (card) {
      const bv = card.binding_values
      const imgOriginal = bv?.thumbnail_image_large || bv?.thumbnail_image_original || bv?.player_image_original || bv?.event_thumbnail_original
      mapped.link = {
        url: bv?.card_url?.string_value,
        title: bv?.event_title?.string_value || bv?.title?.string_value,
        summary: bv?.event_subtitle?.string_value || bv?.description?.string_value,
        img: imgOriginal?.image_value?.url,
        imgSize: { width: imgOriginal?.image_value?.width, height: imgOriginal?.image_value?.height },
      }
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
      mapped.isDynamicMessage = true
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
      isUnread: +t.last_read_event_id < +lastMessage?.id,
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
      durationMs: 3000,
    }
  }
  // if (payloadType === 'dm_update') return null
}

export function mapUserUpdate(entryObj: any, currentUserID: string, json: any): ServerEvent {
  const [entryType] = Object.keys(entryObj)
  const entry = entryObj[entryType]
  const threadID = entry.conversation_id
  // if (entryType === MessageType.CONVERSATION_READ) {
  //   return {
  //     type: ServerEventType.THREAD_PROPS_UPDATED,
  //     threadID,
  //     props: { isUnread: false },
  //   }
  // }
  if (entryType === MessageType.REMOVE_CONVERSATION) {
    return {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'deleted',
      objectID: [threadID],
      objectName: 'thread',
    }
  }
  if ([
    MessageType.MESSAGE,
    MessageType.TRUST_CONVERSATION,
    MessageType.PARTICIPANTS_JOIN,
    MessageType.PARTICIPANTS_LEAVE,
    MessageType.JOIN_CONVERSATION,
    MessageType.CONVERSATION_AVATAR_UPDATE,
    MessageType.CONVERSATION_NAME_UPDATE,
    MessageType.WELCOME_MESSAGE,
  ].includes(entryType as MessageType)) {
    const message = mapMessage(entryObj, currentUserID, json.user_events.conversations[threadID]?.participants)
    return {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'created',
      objectName: 'message',
      objectID: [threadID, message.id],
      data: message,
    }
  }
  if (entryType === MessageType.REACTION_CREATE) {
    const reaction = mapReaction(entry)
    return {
      type: ServerEventType.STATE_SYNC,
      mutationType: 'created',
      objectName: 'message_reaction',
      objectID: [threadID, entry.message_id, reaction.id],
      data: reaction,
    }
  }
  if (entryType === MessageType.REACTION_DELETE) {
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
