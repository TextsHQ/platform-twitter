import { MessageDeletionMode, Attribute, PlatformInfo } from '@textshq/platform-sdk'

import { supportedReactions } from './constants'

const info: PlatformInfo = {
  name: 'twitter',
  version: '1.0.0',
  displayName: 'X',
  icon: `
<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="16" height="16" rx="5" fill="black"/>
<path d="M8.93339 7.23432L12.5761 3H11.7129L8.54993 6.6766L6.02371 3H3.11L6.93015 8.55967L3.11 13H3.97325L7.31339 9.11739L9.98127 13H12.895L8.93318 7.23432H8.93339ZM7.75105 8.60865L7.36399 8.05503L4.28429 3.64984H5.61018L8.09554 7.20497L8.4826 7.75859L11.7133 12.3797H10.3874L7.75105 8.60886V8.60865Z" fill="white"/>
</svg>`,
  brand: {
    background: '#000',
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="none" viewBox="0 0 48 48">
    <path fill="black" d="M26.675 21.273 37.145 9h-2.482l-9.09 10.657L18.313 9H9.94l10.98 16.115-10.98 12.87h2.481l9.6-11.254 7.667 11.254h8.374L26.675 21.273Zm-3.398 3.984-1.112-1.605-8.85-12.768h3.81l7.142 10.304 1.113 1.605 9.285 13.394h-3.811l-7.576-10.93Z"/>
  </svg>`,
  },
  loginMode: 'browser',
  reactions: {
    supported: supportedReactions,
    canReactWithAllEmojis: true,
  },
  deletionMode: MessageDeletionMode.DELETE_FOR_SELF,
  autofillHostnames: ['twitter.com', 'x.com'],
  browserLogin: {
    url: 'https://x.com/login',
    authCookieName: 'auth_token',
    runJSOnNavigate: `
      // hide close button on login page on mobile
      const ss = document.createElement('style')
      ss.innerText = '[aria-label="Close"]{display:none!important}'
      document.head.appendChild(ss)

      // check webkit?.messageHandlers to detect WKWebView
      if (window.location.href.endsWith('/login') && window.webkit?.messageHandlers !== undefined) {
        const observer = new MutationObserver(() => {
            document.querySelector('[data-testid="google_sign_in_container"]')?.remove()
        })
        const container = document.documentElement || document.body
        observer.observe(container, { childList: true, subtree: true })
      }
    `,
  },
  typingDurationMs: 3000,
  attributes: new Set([
    Attribute.GROUP_THREAD_CREATION_REQUIRES_MESSAGE,
    Attribute.NO_SUPPORT_GROUP_REMOVE_PARTICIPANT,
    Attribute.SUBSCRIBE_TO_THREAD_SELECTION,
    Attribute.SUPPORTS_REQUESTS_INBOX,
    Attribute.SUPPORTS_MOVING_THREAD_TO_INBOX,
    Attribute.SUPPORTS_GROUP_IMAGE_CHANGE,
    Attribute.SUPPORTS_DELETE_THREAD,
    Attribute.SORT_MESSAGES_ON_PUSH,
    Attribute.CAN_MESSAGE_USERNAME,
    Attribute.SEARCH_ALL_USERS_FOR_GROUP_MENTIONS,
    Attribute.SUPPORTS_REPORT_THREAD,
    Attribute.SUBSCRIBE_TO_ONLINE_OFFLINE_ACTIVITY,
    Attribute.SUPPORTS_PUSH_NOTIFICATIONS,
    Attribute.CAN_FETCH_LINK_PREVIEW,
    Attribute.CAN_REMOVE_LINK_PREVIEW,
    Attribute.SUPPORTS_QUOTED_MESSAGES,
  ]),
  attachments: {
    gifMimeType: 'image/gif',
    noSupportForAudio: true,
    noSupportForFiles: true,
    supportsCaption: true,

    // https://developer.x.com/en/docs/twitter-api/v1/media/upload-media/uploading-media/media-best-practices
    maxSize: {
      // media_upload_init(media_type=image/jpeg, media_category=dm_image): File size exceeds 5242880 bytes.
      image: 5 * 1024 * 1024,
      // media_upload_init(media_type=video/mp4, media_category=dm_video): File size exceeds 536870912 bytes.
      video: 512 * 1024 * 1024,
    },
  },
  prefs: {
    show_notifications_thread: {
      label: 'Show X like/retweet/mentions notifications as a thread',
      type: 'checkbox',
      default: false,
    },
    // show_only_mentions_in_notifications_thread: {
    //   label: 'Show only mentions in Notifications thread',
    //   type: 'checkbox',
    //   default: false,
    // },
  },
  notifications: {
    web: {
      vapidKey: 'BF5oEo0xDUpgylKDTlsd8pZmxQA1leYINiY-rSscWYK_3tWAkz4VMbtf1MLE_Yyd6iII6o-e3Q9TCN5vZMzVMEs',
    },
  },
  getUserProfileLink: ({ username }) =>
    username && `https://x.com/${username}`,
}

export default info
