export type TwitterUser = {} & any
export type TwitterThreadParticipant = {} & any
export type TwitterThread = {} & any
export type TwitterMessage = {} & any
export type SendMessageVariables = {
  message: {
    card: null
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
  target: {
    conversation_id: string
  }
}
