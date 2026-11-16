/**
 * Outils de lecture des messages WhatsApp (sans dépendance, donc testables hors ligne).
 */

export function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return null
  const at = jid.indexOf('@')
  if (at === -1) return jid
  const user = jid.slice(0, at).split(':')[0]
  let server = jid.slice(at + 1)
  if (server === 'c.us') server = 's.whatsapp.net'
  return `${user}@${server}`
}

export const isGroupJid = (jid) => typeof jid === 'string' && jid.endsWith('@g.us')
export const isPnJid = (jid) => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net')
export const isLidJid = (jid) => typeof jid === 'string' && jid.endsWith('@lid')

/** Forme canonique d'une discussion : on préfère le JID "numéro" quand un LID est présent. */
export function canonicalChat(jid, alt) {
  const a = normalizeJid(jid)
  const b = normalizeJid(alt)
  if (isLidJid(a) && isPnJid(b)) return b
  return a || b
}

/** Toutes les formes connues d'une même discussion (numéro + LID). */
export function chatIds(...jids) {
  return [...new Set(jids.map(normalizeJid).filter(Boolean))]
}

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'deviceSentMessage',
  'groupMentionedMessage',
  'botInvokeMessage',
  'lottieStickerMessage',
  'associatedChildMessage',
]

export function unwrapMessage(message) {
  let m = message
  for (let i = 0; i < 8 && m; i++) {
    const key = WRAPPERS.find((k) => m[k]?.message)
    if (!key) break
    m = m[key].message
  }
  return m || null
}

const IGNORED = new Set([
  'protocolMessage',
  'reactionMessage',
  'encReactionMessage',
  'pollUpdateMessage',
  'senderKeyDistributionMessage',
  'keepInChatMessage',
  'pinInChatMessage',
  'messageHistoryBundle',
  'stickerSyncRmrMessage',
  'placeholderMessage',
  'encEventResponseMessage',
  'requestPhoneNumberMessage',
  'call',
])

export function contentType(m) {
  if (!m || typeof m !== 'object') return null
  return Object.keys(m).find((k) => k !== 'messageContextInfo' && k !== 'senderKeyDistributionMessage' && m[k]) || null
}

const quote = (s) => (s ? ` « ${String(s).slice(0, 80)} »` : '')

/** -> { type, ignore, text, media, contextInfo } */
export function extractContent(message) {
  const m = unwrapMessage(message)
  const type = contentType(m)
  if (!type || IGNORED.has(type)) return { type, ignore: true, text: '', media: null, contextInfo: null }
  const c = m[type]
  const contextInfo = (c && typeof c === 'object' && c.contextInfo) || null
  let text = ''
  let media = null
  switch (type) {
    case 'conversation':
      text = m.conversation
      break
    case 'extendedTextMessage':
      text = c.text
      break
    case 'imageMessage':
      media = 'image'
      text = c.caption
      break
    case 'videoMessage':
      media = c.gifPlayback ? 'GIF' : 'vidéo'
      text = c.caption
      break
    case 'ptvMessage':
      media = 'vidéo ronde'
      break
    case 'audioMessage':
      media = c.ptt ? 'note vocale' : 'audio'
      break
    case 'stickerMessage':
      media = 'sticker'
      break
    case 'documentMessage':
      media = `document${quote(c.fileName)}`
      text = c.caption
      break
    case 'contactMessage':
      media = `contact${quote(c.displayName)}`
      break
    case 'contactsArrayMessage':
      media = 'contacts'
      break
    case 'locationMessage':
      media = `position${quote(c.name || c.address)}`
      break
    case 'liveLocationMessage':
      media = 'position en direct'
      break
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      media = `sondage${quote(c.name)}`
      break
    case 'eventMessage':
      media = `évènement${quote(c.name)}`
      break
    case 'buttonsResponseMessage':
      text = c.selectedDisplayText || c.selectedButtonId
      break
    case 'listResponseMessage':
      text = c.title || c.singleSelectReply?.selectedRowId
      break
    case 'templateButtonReplyMessage':
      text = c.selectedDisplayText || c.selectedId
      break
    case 'interactiveResponseMessage':
      text = c.body?.text
      break
    default:
      media = 'message non pris en charge'
  }
  text = typeof text === 'string' ? text.trim() : ''
  return { type, ignore: false, text, media, contextInfo }
}

/** Texte stocké dans la mémoire de l'IA (les médias deviennent des balises lisibles). */
export function describe({ text, media }) {
  if (media && text) return `[${media}] ${text}`
  if (media) return `[${media}]`
  return text || ''
}

/** Le message mentionne-t-il le propriétaire ou répond-il à l'un de ses messages ? */
export function targetsMe(contextInfo, text, myIds = [], myNumber = '') {
  const mine = new Set(myIds.map(normalizeJid).filter(Boolean))
  const mentioned = (contextInfo?.mentionedJid || []).map(normalizeJid)
  if (mentioned.some((j) => mine.has(j))) return true
  if (contextInfo?.participant && mine.has(normalizeJid(contextInfo.participant))) return true
  if (myNumber && typeof text === 'string' && text.includes(`@${myNumber}`)) return true
  return false
}
