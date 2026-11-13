import { EventEmitter } from 'node:events'
import QRCode from 'qrcode'
import {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  defaultBrowser,
  isJidBroadcast,
  isJidNewsletter,
  newMessageId,
  downloadMediaMessage,
} from './baileys.js'
import { useKVAuthState } from '../storage/authState.js'
import { encodeSession, decodeSession, hasValidSession, rememberSession, revokeSessions } from '../session.js'
import { TTLCache } from '../utils/ttlCache.js'
import { normalizePhone } from '../utils/phone.js'
import { baileysLogger } from '../logger.js'
import { config } from '../config.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const PAIRING_TTL_MS = 3 * 60_000

function statusCodeOf(error) {
  return (
    error?.output?.statusCode ??
    error?.output?.payload?.statusCode ??
    error?.data?.statusCode ??
    error?.statusCode ??
    error?.status
  )
}

/**
 * Gère la connexion WhatsApp : appairage (code ou QR), reconnexions, déconnexion, SESSION_ID.
 * Évènements : 'status', 'open', 'close', 'messages', 'logged-out', 'pairing-code', 'pairing-error', 'qr'
 */
export class WhatsAppManager extends EventEmitter {
  constructor({ kv, log }) {
    super()
    this.setMaxListeners(50)
    this.kv = kv
    this.log = log
    this.sock = null
    this.generation = 0
    this.status = 'idle' // idle | connecting | waiting_pair | waiting_qr | connected | reconnecting | logged_out | replaced | error
    this.me = null
    this.pairing = null
    this.qrDataUrl = null
    this.lastError = null
    this.retries = 0
    this.replacedCount = 0
    this.badSessionCount = 0
    this.reconnectTimer = null
    this.justPaired = false
    this.version = null
    this.connectedAt = null
    this.msgRetryCounterCache = new TTLCache({ ttlMs: 10 * 60_000, max: 10_000 })
    this.groupCache = new TTLCache({ ttlMs: 10 * 60_000, max: 1000 })
    this.sentMessages = new TTLCache({ ttlMs: 60 * 60_000, max: 5000 })
  }

  get connected() {
    return this.status === 'connected' && !!this.sock
  }

  get creds() {
    return this.kv.get('auth:creds')
  }

  hasSession() {
    return hasValidSession(this.creds)
  }

  setStatus(status) {
    this.status = status
    this.emit('status', this.publicStatus())
  }

  publicStatus() {
    return {
      status: this.status,
      connected: this.connected,
      me: this.me ? { number: this.me.number, name: this.me.name } : null,
      pairing:
        this.pairing && this.status === 'waiting_pair'
          ? { code: this.pairing.code, phone: this.pairing.phone, expiresAt: this.pairing.expiresAt }
          : null,
      qr: this.status === 'waiting_qr' ? this.qrDataUrl : null,
      lastError: this.lastError,
      hasSession: this.hasSession(),
      connectedAt: this.connectedAt,
      storage: this.kv.kind,
    }
  }

  async #ensureVersion() {
    if (this.version || typeof fetchLatestBaileysVersion !== 'function') return
    try {
      const res = await Promise.race([fetchLatestBaileysVersion(), sleep(8000).then(() => null)])
      if (res?.version) this.version = res.version
    } catch {
      // on garde la version intégrée à Baileys
    }
  }

  #closeSocket() {
    const sock = this.sock
    this.sock = null
    if (!sock) return
    try {
      sock.ev?.removeAllListeners?.()
    } catch {}
    try {
      sock.end?.(undefined)
    } catch {}
    try {
      sock.ws?.close?.()
    } catch {}
  }

  /** Démarre (ou redémarre) la connexion. pairPhone = numéro pour obtenir un code d'appairage. */
  async start({ pairPhone = null } = {}) {
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const gen = ++this.generation
    this.#closeSocket()
    this.setStatus('connecting')
    await this.#ensureVersion()
    if (gen !== this.generation) return

    const { state, saveCreds } = useKVAuthState(this.kv)
    let sock
    try {
      sock = makeWASocket({
        ...(this.version ? { version: this.version } : {}),
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
        logger: baileysLogger,
        browser: defaultBrowser(),
        markOnlineOnConnect: false, // garde les notifications sur ton téléphone
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false, // économise la mémoire (Render gratuit = 512 Mo)
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        keepAliveIntervalMs: 25_000,
        msgRetryCounterCache: this.msgRetryCounterCache,
        cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
        getMessage: async (key) => {
          const msg = this.sentMessages.get(key?.id)
          return msg && typeof msg === 'object' ? msg : undefined
        },
        shouldIgnoreJid: (jid) => isJidBroadcast(jid) || isJidNewsletter(jid),
      })
    } catch (err) {
      this.lastError = `Impossible de créer la connexion : ${err?.message || err}`
      this.log.error({ err: err?.message }, this.lastError)
      this.emit('pairing-error', new Error(this.lastError))
      if (pairPhone || !this.hasSession()) this.setStatus('idle')
      else this.#scheduleReconnect()
      return
    }

    this.sock = sock
    let pairingRequested = false

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      if (gen !== this.generation) return
      try {
        const { connection, lastDisconnect, qr, isNewLogin } = update
        if (isNewLogin) this.justPaired = true
        if (qr) {
          if (pairPhone) {
            if (!pairingRequested) {
              pairingRequested = true
              await this.#requestCode(sock, gen, pairPhone)
            }
          } else {
            this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 }).catch(() => null)
            if (gen !== this.generation) return
            this.setStatus('waiting_qr')
            this.emit('qr', this.qrDataUrl)
          }
        }
        if (connection === 'open') await this.#onOpen(sock, gen)
        if (connection === 'close') this.#onClose(sock, lastDisconnect)
      } catch (err) {
        this.log.error({ err: err?.message }, 'Erreur dans connection.update')
      }
    })

    sock.ev.on('messages.upsert', (event) => {
      if (gen === this.generation) this.emit('messages', event)
    })

    sock.ev.on('groups.update', (updates) => {
      for (const u of updates || []) if (u?.id) this.groupCache.del(u.id)
    })

    sock.ev.on('group-participants.update', (event) => {
      if (event?.id) this.groupCache.del(event.id)
    })
  }

  async #requestCode(sock, gen, phone) {
    try {
      const raw = await sock.requestPairingCode(phone)
      if (gen !== this.generation) return
      const code = String(raw || '')
        .replace(/[^A-Z0-9]/gi, '')
        .toUpperCase()
      if (!code) throw new Error('code vide')
      const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code
      this.pairing = { phone, code: pretty, expiresAt: Date.now() + PAIRING_TTL_MS }
      this.lastError = null
      this.setStatus('waiting_pair')
      this.emit('pairing-code', pretty)
      this.log.info({ phone: `${phone.slice(0, 4)}…` }, "Code d'appairage généré")
    } catch (err) {
      this.lastError = `Impossible d'obtenir le code d'appairage : ${err?.message || err}`
      this.log.error(this.lastError)
      this.emit('pairing-error', new Error(this.lastError))
      this.stop()
      this.setStatus('idle')
    }
  }

  async #onOpen(sock, gen) {
    this.retries = 0
    this.badSessionCount = 0
    this.pairing = null
    this.qrDataUrl = null
    this.lastError = null
    this.connectedAt = Date.now()
    const user = sock.user || {}
    const id = jidNormalizedUser(user.id)
    this.me = {
      id,
      lid: user.lid ? jidNormalizedUser(user.lid) : null,
      number: (id || '').split('@')[0],
      name: user.name || user.verifiedName || user.notify || '',
    }
    const sessionId = encodeSession(sock.authState?.creds || this.creds)
    rememberSession(this.kv, sessionId)
    await this.kv.flush()
    if (gen !== this.generation) return
    this.setStatus('connected')
    this.log.info({ number: `${this.me.number.slice(0, 4)}…` }, 'WhatsApp connecté ✅')
    setTimeout(() => {
      if (gen === this.generation && this.connected) this.replacedCount = 0
    }, 60_000).unref?.()
    const firstLogin = this.justPaired
    this.justPaired = false
    this.emit('open', { firstLogin, sessionId })
  }

  #onClose(sock, lastDisconnect) {
    if (this.sock === sock) this.sock = null
    const code = statusCodeOf(lastDisconnect?.error)
    const reason = lastDisconnect?.error?.message || 'inconnue'
    this.log.warn({ code, reason }, 'Connexion WhatsApp fermée')
    this.emit('close', { code, reason })
    const R = DisconnectReason

    if (code === R.loggedOut || code === R.forbidden || code === R.multideviceMismatch) {
      this.#handleLoggedOut(
        code === R.forbidden
          ? 'WhatsApp a refusé la connexion (403). Reconnecte le bot depuis le site.'
          : 'Session déconnectée (depuis le téléphone ou expirée). Reconnecte le bot depuis le site.',
      )
      return
    }

    if (!this.hasSession()) {
      // L'appairage n'a pas été terminé (code/QR expiré, coupure réseau...)
      this.pairing = null
      this.qrDataUrl = null
      this.lastError = "Le code (ou le QR) a expiré ou la connexion a été coupée avant la fin de l'appairage. Recommence."
      this.emit('pairing-error', new Error(this.lastError))
      this.setStatus('idle')
      return
    }

    if (code === R.connectionReplaced) {
      this.replacedCount++
      if (this.replacedCount >= 3) {
        this.lastError =
          'Session ouverte ailleurs : une autre instance du bot utilise ce SESSION_ID (ex : en local et sur Render en même temps). Arrête l\'autre puis redémarre ce service.'
        this.log.error(this.lastError)
        this.setStatus('replaced')
        return
      }
      this.#scheduleReconnect(10_000)
      return
    }

    if (code === R.restartRequired) {
      this.#scheduleReconnect(500)
      return
    }

    if (code === R.badSession) {
      this.badSessionCount++
      if (this.badSessionCount >= 6) {
        this.lastError = 'Session corrompue (erreur 500 répétée). Déconnecte puis reconnecte le bot depuis le site.'
        this.log.error(this.lastError)
        this.setStatus('error')
        return
      }
    }

    this.#scheduleReconnect()
  }

  #scheduleReconnect(delay) {
    clearTimeout(this.reconnectTimer)
    const wait = delay ?? Math.min(60_000, 2000 * 2 ** Math.min(this.retries, 5))
    this.retries++
    this.setStatus('reconnecting')
    this.log.info({ inMs: wait }, 'Reconnexion programmée')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.start().catch((err) => {
        this.log.error({ err: err?.message }, 'Échec de reconnexion')
        this.#scheduleReconnect()
      })
    }, wait)
  }

  #handleLoggedOut(message) {
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.generation++
    this.#closeSocket()
    this.kv.deletePrefix('auth:')
    revokeSessions(this.kv, config.sessionId)
    this.me = null
    this.pairing = null
    this.qrDataUrl = null
    this.connectedAt = null
    this.lastError = message
    this.kv.flush()
    this.setStatus('logged_out')
    this.emit('logged-out', message)
    this.log.warn(message)
  }

  #resetAuth() {
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.generation++
    this.#closeSocket()
    this.kv.deletePrefix('auth:')
    this.kv.del('meta:sessionId')
    this.me = null
    this.pairing = null
    this.qrDataUrl = null
    this.lastError = null
    this.justPaired = false
  }

  #waitFor(okEvent, errEvent, timeoutMs, timeoutMessage) {
    return new Promise((resolve, reject) => {
      let timer = null
      const cleanup = () => {
        clearTimeout(timer)
        this.off(okEvent, onOk)
        this.off(errEvent, onErr)
      }
      const onOk = (value) => {
        cleanup()
        resolve(value)
      }
      const onErr = (err) => {
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
      timer = setTimeout(() => {
        cleanup()
        reject(new Error(timeoutMessage))
      }, timeoutMs)
      this.on(okEvent, onOk)
      this.on(errEvent, onErr)
    })
  }

  #abortPairing() {
    if (!this.connected && this.status !== 'waiting_pair' && this.status !== 'waiting_qr') {
      this.stop()
      this.setStatus('idle')
    }
  }

  /** Demande un code d'appairage pour ce numéro (renvoie "ABCD-EFGH"). */
  async requestPairing(rawPhone) {
    const phone = normalizePhone(rawPhone)
    if (this.connected) throw new Error("Le bot est déjà connecté. Déconnecte-le d'abord pour changer de compte.")
    this.#resetAuth()
    const result = this.#waitFor('pairing-code', 'pairing-error', 45_000, "WhatsApp n'a pas répondu à temps. Réessaie dans quelques secondes.")
    this.start({ pairPhone: phone }).catch((err) => this.emit('pairing-error', err))
    try {
      return await result
    } catch (err) {
      this.#abortPairing()
      throw err
    }
  }

  /** Connexion par QR code (renvoie une image data:URL). */
  async requestQr() {
    if (this.connected) throw new Error("Le bot est déjà connecté. Déconnecte-le d'abord pour changer de compte.")
    this.#resetAuth()
    const result = this.#waitFor('qr', 'pairing-error', 45_000, "WhatsApp n'a pas répondu à temps. Réessaie dans quelques secondes.")
    this.start().catch((err) => this.emit('pairing-error', err))
    try {
      return await result
    } catch (err) {
      this.#abortPairing()
      throw err
    }
  }

  /** Importe un SESSION_ID (depuis le site) puis se connecte. */
  async importSession(sessionId) {
    const creds = decodeSession(sessionId)
    if (!hasValidSession(creds)) throw new Error('Ce SESSION_ID ne correspond pas à un appareil appairé.')
    this.#resetAuth()
    this.kv.set('auth:creds', creds)
    rememberSession(this.kv, sessionId)
    await this.kv.flush()
    await this.start()
  }

  /** SESSION_ID à jour (à copier dans la variable SESSION_ID de Render). */
  exportSession() {
    const creds = this.creds
    if (!hasValidSession(creds)) return null
    const sessionId = encodeSession(creds)
    rememberSession(this.kv, sessionId)
    return sessionId
  }

  async logout() {
    const sock = this.sock
    this.generation++ // on ignore l'évènement de fermeture déclenché par logout()
    if (sock) {
      try {
        await Promise.race([sock.logout(), sleep(8000)])
      } catch {}
    }
    this.#handleLoggedOut('Bot déconnecté depuis le site.')
  }

  /** Arrête la connexion sans déconnecter l'appareil (redémarrage, arrêt du service...). */
  stop() {
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.generation++
    this.#closeSocket()
  }

  async send(jid, content, options = {}) {
    const sock = this.sock
    if (!sock || !this.connected) throw new Error('WhatsApp non connecté')
    const messageId = options.messageId || newMessageId(sock.user?.id)
    if (messageId) this.sentMessages.set(messageId, true) // marqué AVANT l'envoi : jamais traité comme un message de toi
    const msg = await sock.sendMessage(jid, content, messageId ? { ...options, messageId } : options)
    if (msg?.key?.id) this.sentMessages.set(msg.key.id, msg.message || true)
    return msg
  }

  isBotMessage(id) {
    return !!id && this.sentMessages.get(id) !== undefined
  }

  /** Réaction à un message (texte vide = retire la réaction). */
  async react(jid, key, text) {
    const sock = this.sock
    if (!sock || !this.connected || !key?.id) return false
    try {
      const msg = await sock.sendMessage(jid, { react: { text: text || '', key } })
      if (msg?.key?.id) this.sentMessages.set(msg.key.id, msg.message || true)
      return true
    } catch (err) {
      this.log.debug?.({ err: err?.message }, 'Réaction impossible')
      return false
    }
  }

  /** Contenu (Buffer) d'un message média reçu, ex : une image à montrer à l'IA. */
  async downloadMedia(msg) {
    const sock = this.sock
    if (!sock) throw new Error('WhatsApp non connecté')
    if (typeof downloadMediaMessage !== 'function') throw new Error('téléchargement des médias indisponible (version de Baileys)')
    return downloadMediaMessage(msg, 'buffer', {}, { logger: baileysLogger, reuploadRequest: (m) => sock.updateMediaMessage(m) })
  }

  async presence(jid, type) {
    try {
      await this.sock?.sendPresenceUpdate(type, jid)
    } catch {}
  }

  async deleteForEveryone(jid, key) {
    try {
      await this.send(jid, { delete: key })
    } catch {}
  }

  async groupMetadata(jid) {
    const cached = this.groupCache.get(jid)
    if (cached) return cached
    if (!this.sock) return null
    try {
      const meta = await this.sock.groupMetadata(jid)
      if (meta) this.groupCache.set(jid, meta)
      return meta
    } catch {
      return null
    }
  }

  async pnForLid(lid) {
    try {
      const pn = await this.sock?.signalRepository?.lidMapping?.getPNForLID?.(lid)
      return pn ? jidNormalizedUser(pn) : null
    } catch {
      return null
    }
  }

  selfJid() {
    return this.me?.id || null
  }

  myIds() {
    return [this.me?.id, this.me?.lid].filter(Boolean)
  }
}
