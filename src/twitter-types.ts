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
