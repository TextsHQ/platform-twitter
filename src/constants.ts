import type { SupportedReaction } from '@textshq/platform-sdk'

export const supportedReactions: Record<string, SupportedReaction> = {
  '❤️': { title: '❤️', render: '❤️' },
  '👍': { title: '👍', render: '👍' },
  '👎': { title: '👎', render: '👎' },
  '😂': { title: '😂', render: '😂' },
  '😲': { title: '😲', render: '😲' },
  '😢': { title: '😢', render: '😢' },
  '🔥': { title: '🔥', render: '🔥' },
  angry: { title: 'Angry', render: '😠', disabled: true },
  mask: { title: 'Mask', render: '😷', disabled: true },
}

export const enum MessageType {
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
  END_AV_BROADCAST = 'end_av_broadcast',
}

export const enum CallType {
  AUDIO_ONLY = 'AUDIO_ONLY',
  VIDEO = 'VIDEO',
}

export const enum CallEndReason {
  MISSED = 'MISSED',
  CANCELED = 'CANCELED',
  DECLINED = 'DECLINED',
  HUNG_UP = 'HUNG_UP',
  TIMED_OUT = 'TIMED_OUT',
}

export const NOTIFICATIONS_THREAD_ID = 'notifications'
