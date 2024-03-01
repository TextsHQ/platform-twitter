export type TwitterUser = {} & any
export type TwitterThreadParticipant = {} & any
export type TwitterThread = {} & any
export type TwitterMessage = {} & any

type SendMessageTargetType = { conversation_id: string } | { participant_ids: string[] }
export type SendMessageVariables = {
  message: {
    card?: {
      uri: 'tombstone://card'
      text: string
    }
    media?: {
      id: string
      text: string
    }
    text?: {
      text: string
    }
    tweet: {
      tweet_id: string
      text: string
    }
  }
  requestId: string
  target: SendMessageTargetType
}

export type CallType = 'AUDIO_ONLY' | 'VIDEO'

export type CallEndReason = 'MISSED' | 'CANCELED' | 'DECLINED' | 'HUNG_UP' | 'TIMED_OUT'

export type EndAVBroadcastMessage = {
  id: string
  time: string
  conversation_id: string
  is_caller: boolean
  started_at_ms: string
  ended_at_ms: string
  end_reason: CallEndReason
  call_type: CallType
}
