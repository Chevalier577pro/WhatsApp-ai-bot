/**
 * Point d'entrée unique vers Baileys, avec des solutions de repli si une
 * version exporte les fonctions différemment (ESM / CommonJS).
 */
import * as B from '@whiskeysockets/baileys'

const lib = B.default && typeof B.default === 'object' ? { ...B.default, ...B } : { ...B }

export const makeWASocket =
  typeof B.default === 'function'
    ? B.default
    : typeof B.makeWASocket === 'function'
      ? B.makeWASocket
      : typeof B.default?.default === 'function'
        ? B.default.default
        : B.default?.makeWASocket

export const proto = lib.proto
export const initAuthCreds = lib.initAuthCreds
export const fetchLatestBaileysVersion = lib.fetchLatestBaileysVersion
export const makeCacheableSignalKeyStore = lib.makeCacheableSignalKeyStore
export const generateMessageIDV2 = lib.generateMessageIDV2
export const generateMessageID = lib.generateMessageID
export const downloadMediaMessage = lib.downloadMediaMessage

export const DisconnectReason = {
  connectionClosed: 428,
  connectionLost: 408,
  connectionReplaced: 440,
  timedOut: 408,
  loggedOut: 401,
  badSession: 500,
  restartRequired: 515,
  multideviceMismatch: 411,
  forbidden: 403,
  unavailableService: 503,
  ...(lib.DisconnectReason || {}),
}

export const jidNormalizedUser =
  lib.jidNormalizedUser ||
  ((jid) => {
    if (!jid || typeof jid !== 'string' || !jid.includes('@')) return jid
    const [user, server] = jid.split('@')
    return `${user.split(':')[0]}@${server === 'c.us' ? 's.whatsapp.net' : server}`
  })

export const isJidBroadcast = lib.isJidBroadcast || ((jid) => typeof jid === 'string' && jid.endsWith('@broadcast'))
export const isJidNewsletter = lib.isJidNewsletter || ((jid) => typeof jid === 'string' && jid.endsWith('@newsletter'))

export function defaultBrowser() {
  try {
    if (lib.Browsers?.macOS) return lib.Browsers.macOS('Chrome')
  } catch {}
  return ['Mac OS', 'Chrome', '14.4.1']
}

export function newMessageId(userId) {
  try {
    if (typeof generateMessageIDV2 === 'function') return generateMessageIDV2(userId)
    if (typeof generateMessageID === 'function') return generateMessageID()
  } catch {}
  return undefined
}
