import { Reaction } from '@textshq/platform-sdk'

export const supportedReactions: Record<string, Reaction> = {
  heart: { title: 'Heart', render: '❤️' },
  like: { title: 'Like', render: '👍' },
  dislike: { title: 'Dislike', render: '👎' },
  laugh: { title: 'Laugh', render: '😂' },
  surprised: { title: 'Surprised', render: '😲' },
  cry: { title: 'Cry', render: '😢' },
  fire: { title: 'Lit', render: '🔥' },
  mask: { title: 'Mask', render: '😷' },
}

export enum MessageType {
  CONVERSATION_AVATAR_UPDATE = 'conversation_avatar_update',
  CONVERSATION_NAME_UPDATE = 'conversation_name_update',
  CONVERSATION_PROFILE_INFO_HEADER = 'conversation_profile_info_header',
  CONVERSATION_READ = 'conversation_read',
  DISABLE_NOTIFICATIONS = 'disable_notifications',
  ENABLE_NOTIFICATIONS = 'enable_notifications',
  JOIN_CONVERSATION = 'join_conversation',
  MARK_ALL_AS_READ = 'mark_all_as_read',
  MENTION_NOTIFICATIONS_UPDATE = 'mention_notifications_setting_update',
  MESSAGE = 'message',
  MESSAGE_DELETE = 'message_delete',
  MESSAGE_MARK_AS_NOT_SPAM = 'message_unmark_as_spam',
  MESSAGE_MARK_AS_SPAM = 'message_mark_as_spam',
  PARTICIPANTS_JOIN = 'participants_join',
  PARTICIPANTS_LEAVE = 'participants_leave',
  REACTION_CREATE = 'reaction_create',
  REACTION_DELETE = 'reaction_delete',
  READ_ONLY_INDICATOR = 'read_only_indicator',
  REMOVE_CONVERSATION = 'remove_conversation',
  TRUST_CONVERSATION = 'trust_conversation',
  TYPING_INDICATOR = 'typing_indicator',
  WELCOME_MESSAGE = 'welcome_message_create',
}
