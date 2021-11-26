import { MessageDeletionMode, Attribute, PlatformInfo } from '@textshq/platform-sdk'

import { supportedReactions } from './constants'

const info: PlatformInfo = {
  name: 'twitter',
  version: '1.0.0',
  displayName: 'Twitter',
  icon: `
<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="16" height="16" rx="5" fill="#1DA1F2"/>
<path d="M13.3164 5.02645C12.9242 5.20027 12.5028 5.31771 12.0598 5.3708C12.5117 5.10021 12.8584 4.67084 13.0219 4.15972C12.5991 4.41058 12.1307 4.59285 11.6323 4.69057C11.233 4.26589 10.6646 4 10.0351 4C8.82683 4 7.84688 4.97995 7.84688 6.18914C7.84688 6.36014 7.86661 6.52644 7.90325 6.6871C6.08382 6.5955 4.47203 5.72407 3.39249 4.40025C3.20458 4.72439 3.09653 5.10021 3.09653 5.50045C3.09653 6.25961 3.48316 6.92997 4.0699 7.32223C3.711 7.31049 3.3737 7.21231 3.07868 7.04836V7.07654C3.07868 8.13682 3.83267 9.0214 4.83423 9.22247C4.65007 9.27226 4.457 9.29857 4.25781 9.29857C4.11688 9.29857 3.97924 9.28542 3.84582 9.26005C4.1244 10.1291 4.93241 10.7624 5.89027 10.7793C5.14099 11.3665 4.19721 11.7165 3.17217 11.7165C2.99553 11.7165 2.82125 11.7062 2.64978 11.686C3.61845 12.3075 4.76846 12.6692 6.00396 12.6692C10.0299 12.6692 12.2308 9.33474 12.2308 6.44282C12.2308 6.34886 12.2285 6.25397 12.2242 6.16002C12.6517 5.85091 13.0228 5.46616 13.3155 5.02786L13.3164 5.02645Z" fill="white"/>
</svg>`,
  loginMode: 'browser',
  reactions: {
    supported: supportedReactions,
  },
  deletionMode: MessageDeletionMode.DELETE_FOR_SELF,
  browserLogin: {
    loginURL: 'https://twitter.com/login',
    authCookieName: 'auth_token',
  },
  typingDurationMs: 3000,
  attributes: new Set([
    Attribute.GROUP_THREAD_CREATION_REQUIRES_MESSAGE,
    Attribute.NO_SUPPORT_GROUP_REMOVE_PARTICIPANT,
    Attribute.SUBSCRIBE_TO_THREAD_SELECTION,
    Attribute.SUPPORTS_REQUESTS_INBOX,
    Attribute.SUPPORTS_GROUP_IMAGE_CHANGE,
    Attribute.SUPPORTS_DELETE_THREAD,
    Attribute.SORT_MESSAGES_ON_PUSH,
    Attribute.CAN_MESSAGE_USERNAME,
    Attribute.SEARCH_ALL_USERS_FOR_GROUP_MENTIONS,
    Attribute.SUPPORTS_REPORT_THREAD,
  ]),
  attachments: {
    gifMimeType: 'image/gif',
    noSupportForAudio: true,
    noSupportForFiles: true,
    supportsCaption: true,
  },
  prefs: {
    show_notifications_thread: {
      label: 'Show Twitter notifications as a thread',
      type: 'checkbox',
      default: false,
    },
  },
  getUserProfileLink: ({ username }) =>
    username && `https://twitter.com/${username}`,
}

export default info
