import { EventEmitter } from 'node:events'
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
import { encodeSession, hasValidSession, rememberSession, revokeSessions } from '../session.js'
import { TTLCache } from '../utils/ttlCache.js'
import { baileysLogger } from '../logger.js'
import { config } from '../config.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
 * Évènements : 'status', 'open', 'close', 'messages', 'logged-out'
 * L'appairage se fait sur le site public dédié : ce bot réutilise un SESSION_ID.
 */
export class WhatsAppManager extends EventEmitter {
  constructor({ kv, log }) {
    super()
    this.setMaxListeners(50)
    this.kv = kv
    this.log = log
    this.sock = null
    this.generation = 0
    this.status = 'idle' // idle | connecting | connected | reconnecting | logged_out | replaced | error
    this.me = null
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

  /** Démarre (ou redémarre) la connexion à partir du SESSION_ID stocké. */
  async start() {
    if (!this.hasSession()) {
      this.lastError = "Aucune session WhatsApp : génère ton SESSION_ID sur le site d'appairage puis colle-le dans la variable SESSION_ID."
      this.setStatus('error')
      return
    }
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
      this.setStatus('error')
      return
    }

    this.sock = sock
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      if (gen !== this.generation) return
      try {
        const { connection, lastDisconnect, isNewLogin } = update
        if (isNewLogin) this.justPaired = true
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

  async #onOpen(sock, gen) {
    this.retries = 0
    this.badSessionCount = 0
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
      this.lastError = "Session WhatsApp absente ou invalide : régénère un SESSION_ID sur le site d'appairage puis mets à jour la variable SESSION_ID."
      this.setStatus('error')
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
    this.connectedAt = null
    this.lastError = message
    this.kv.flush()
    this.setStatus('logged_out')
    this.emit('logged-out', message)
    this.log.warn(message)
  }

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
