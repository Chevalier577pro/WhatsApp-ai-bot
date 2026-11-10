import {
  canonicalChat,
  chatIds,
  describe,
  extractContent,
  isGroupJid,
  isLidJid,
  isPnJid,
  normalizeJid,
  targetsMe,
} from './message.js'
import { Memory } from './memory.js'
import { jidToNumber } from '../utils/phone.js'
import { createCommands } from './commands.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const FRESH_MS = 10 * 60_000 // on ne répond pas aux vieux messages reçus pendant une coupure
const PENDING_MS = 5 * 60_000

function timestampMs(t) {
  if (t == null) return Date.now()
  const sec = typeof t === 'number' ? t : typeof t?.toNumber === 'function' ? t.toNumber() : Number(t)
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : Date.now()
}

/**
 * Logique du bot : lit les messages, gère les commandes (toi uniquement) et les réponses de l'IA.
 */
export class Bot {
  constructor({ wa, kv, settings, ai, config, log, media }) {
    this.wa = wa
    this.kv = kv
    this.settings = settings
    this.ai = ai
    this.config = config
    this.log = log
    this.prefix = config.prefix || '.'
    this.memory = new Memory(kv, () => settings.get('memory'))
    this.timers = new Map() // discussion -> minuteur avant réponse
    this.busy = new Set() // discussions où l'IA est en train d'écrire
    this.again = new Map() // discussions à relancer après la réponse en cours
    this.lastIncoming = new Map() // dernier message reçu (pour le citer en groupe)
    this.pending = new Map() // réponses attendues par le menu
    this.errorNotified = new Map()
    this.startedAt = Date.now()
    this.media = media || null // .song / .video (créé au premier usage s'il n'est pas fourni)
    this.commands = createCommands(this)
  }

  attach() {
    this.wa.on('messages', (event) => {
      this.onUpsert(event).catch((err) => this.log.error({ err: err?.message }, 'Erreur messages.upsert'))
    })
    this.wa.on('open', (info) => {
      this.onOpen(info).catch((err) => this.log.error({ err: err?.message }, 'Erreur à la connexion'))
    })
  }

  ownerName() {
    return this.settings.get('ownerName') || this.wa.me?.name || ''
  }

  isSelf(ids) {
    const mine = this.wa.myIds()
    return ids.some((id) => mine.includes(normalizeJid(id)))
  }

  // ---------- noms & alias (LID <-> numéro) ----------

  learnAlias(a, b) {
    const x = normalizeJid(a)
    const y = normalizeJid(b)
    const pair = isLidJid(x) && isPnJid(y) ? [x, y] : isLidJid(y) && isPnJid(x) ? [y, x] : null
    if (!pair) return
    const aliases = this.kv.get('aliases', {})
    if (aliases[pair[0]] === pair[1]) return
    aliases[pair[0]] = pair[1]
    const keys = Object.keys(aliases)
    if (keys.length > 1000) delete aliases[keys[0]]
    this.kv.set('aliases', aliases)
  }

  resolveAlias(id) {
    return (isLidJid(id) && this.kv.get('aliases', {})[id]) || id
  }

  setLabel(chat, name) {
    if (!chat || !name) return
    const labels = this.kv.get('labels', {})
    const value = String(name).slice(0, 60)
    if (labels[chat] === value) return
    labels[chat] = value
    const keys = Object.keys(labels)
    if (keys.length > 500) delete labels[keys[0]]
    this.kv.set('labels', labels)
  }

  label(chat) {
    if (!chat) return '?'
    if (this.isSelf([chat])) return 'Toi-même'
    const id = this.resolveAlias(chat)
    const labels = this.kv.get('labels', {})
    if (labels[id]) return labels[id]
    if (isGroupJid(id)) return 'Groupe'
    return jidToNumber(id)
  }

  activeModes(ids) {
    const out = []
    if (this.settings.isActive('meai', ids)) out.push('meai')
    if (this.settings.isActive('ai', ids)) out.push('ai')
    return out
  }

  activeList() {
    const { ai, meai, aai } = this.settings.activeChats()
    const dedupe = (ids) => [...new Set(ids.map((id) => this.resolveAlias(id)))]
    return { ai: dedupe(ai), meai: dedupe(meai), aai: dedupe(aai) }
  }

  /** L'IA peut-elle répondre ? .aai (te répondre aussi à toi) exige .ai ou .meai actif dans la discussion. */
  canReply(ids, mode) {
    const modes = this.activeModes(ids)
    if (mode === 'aai') return modes.length > 0 && this.settings.isActive('aai', ids)
    return modes.includes(mode)
  }

  // ---------- menu : réponses attendues ----------

  setPending(chat, state) {
    this.pending.set(chat, { ...state, expires: Date.now() + PENDING_MS })
  }

  getPending(chat) {
    const p = this.pending.get(chat)
    if (!p) return null
    if (p.expires < Date.now()) {
      this.pending.delete(chat)
      return null
    }
    return p
  }

  clearPending(chat) {
    this.pending.delete(chat)
  }

  /** Où envoyer les réponses aux commandes : ta discussion perso si le mode discret est actif. */
  replyChat(ctx) {
    const self = this.wa.selfJid()
    return this.settings.get('discreet') && !ctx.self && self ? self : ctx.chat
  }

  async reply(ctx, text, { here = false } = {}) {
    const target = here ? ctx.chat : this.replyChat(ctx)
    const redirected = target !== ctx.chat
    const body = redirected ? `📍 _${this.label(ctx.chat)}_\n${text}` : text
    const discreet = this.settings.get('discreet') && !ctx.self
    const options = !redirected && !discreet && ctx.msg ? { quoted: ctx.msg } : {}
    return this.wa.send(target, { text: body }, options).catch((err) => this.log.warn({ err: err?.message }, 'Envoi impossible'))
  }

  // ---------- réception ----------

  async onOpen({ firstLogin, sessionId } = {}) {
    if (!firstLogin || !sessionId) return
    const self = this.wa.selfJid()
    if (!self) return
    await sleep(3000)
    const name = this.settings.get('botName')
    const intro = [
      `✅ *${name} est connecté à ton WhatsApp !*`,
      '',
      'Le message suivant contient ton *SESSION_ID*. Garde-le secret : il donne accès à ton compte.',
      '👉 Colle-le dans la variable *SESSION_ID* de ton service Render pour que le bot se reconnecte tout seul après chaque redémarrage.',
      '',
      `Tape *${this.prefix}help* ici pour voir toutes les commandes (ou *${this.prefix}menu* pour le menu numéroté).`,
    ].join('\n')
    await this.wa.send(self, { text: intro }).catch(() => {})
    await this.wa.send(self, { text: sessionId }).catch(() => {})
  }

  async onUpsert({ messages, type } = {}) {
    if (type !== 'notify') return
    for (const msg of messages || []) {
      try {
        await this.onMessage(msg)
      } catch (err) {
        this.log.error({ err: err?.message, stack: err?.stack }, 'Erreur de traitement du message')
      }
    }
  }

  async onMessage(msg) {
    const key = msg?.key
    const remote = key?.remoteJid
    if (!remote || !msg.message) return
    if (remote === 'status@broadcast' || remote.endsWith('@broadcast') || remote.endsWith('@newsletter')) return
    if (this.wa.isBotMessage(key.id)) return // message envoyé par le bot lui-même
    const content = extractContent(msg.message)
    if (content.ignore) return

    this.learnAlias(remote, key.remoteJidAlt)
    const chat = this.resolveAlias(canonicalChat(remote, key.remoteJidAlt))
    const ids = chatIds(remote, key.remoteJidAlt, chat)
    const ctx = {
      msg,
      key,
      chat,
      ids,
      content,
      text: content.text,
      isGroup: isGroupJid(chat),
      self: this.isSelf(ids),
      fromMe: !!key.fromMe,
      fresh: Date.now() - timestampMs(msg.messageTimestamp) < FRESH_MS,
    }
    if (ctx.fromMe) await this.onOwnerMessage(ctx)
    else await this.onIncoming(ctx)
  }

  /** Message tapé par toi (depuis ton téléphone ou un autre appareil). */
  async onOwnerMessage(ctx) {
    const { text, chat } = ctx
    const p = this.prefix
    // Réponse « 1 » / « 2 » en citant une miniature de .song / .video
    if (text && !text.startsWith(p) && ctx.content?.contextInfo?.stanzaId && (await this.commands.handleReply?.(ctx))) return
    const pending = this.getPending(chat)
    if (pending && text && !text.startsWith(p)) {
      if (await this.commands.handlePending(ctx, pending)) return
    }
    if (text && text.startsWith(p) && text.length > p.length) {
      if (await this.commands.run(ctx)) return
    }
    const modes = this.activeModes(ctx.ids)
    if (!modes.length) return
    this.memory.add(chat, { r: 'me', text: describe(ctx.content) })
    // Dans ta discussion perso (« Moi ») avec .ai actif : tu discutes en privé avec ton IA
    if (ctx.self && modes.includes('ai') && text && ctx.fresh) return this.schedule(ctx, 'ai', 0)
    this.cancel(chat) // tu as répondu toi-même : on annule la réponse automatique prévue
    // .aai : l'IA te répond aussi à toi, dans cette discussion (privée ou groupe)
    if (!ctx.self && text && ctx.fresh && this.canReply(ctx.ids, 'aai')) this.schedule(ctx, 'aai')
  }

  /** Message reçu d'un contact ou d'un groupe. */
  async onIncoming(ctx) {
    const { chat, msg, key, content, isGroup } = ctx
    // .song / .video : accessibles à tout le monde, même sans IA active
    if (content.text) {
      const p = this.prefix
      if (!content.text.startsWith(p) && ctx.content?.contextInfo?.stanzaId && (await this.commands.handleReply?.(ctx))) return
      if (!content.text.startsWith(p)) {
        const pendingKey = this.commands.publicPendingKey(ctx)
        const pending = this.getPending(pendingKey)
        if (pending && (await this.commands.handlePublicPending(ctx, pending, pendingKey))) return
      }
      if (content.text.startsWith(p) && content.text.length > p.length && (await this.commands.runPublic(ctx))) return
    }
    const modes = this.activeModes(ctx.ids)
    if (!modes.length) return
    const mode = modes.includes('meai') ? 'meai' : 'ai'
    if (isGroup) this.learnAlias(key.participant, key.participantAlt)
    const sender = isGroup ? canonicalChat(key.participant, key.participantAlt) : chat
    const name = msg.pushName || (sender ? jidToNumber(sender) : 'Contact')
    if (!isGroup && msg.pushName) this.setLabel(chat, msg.pushName)
    this.memory.add(chat, { r: 'them', name, text: describe(content) })
    this.lastIncoming.set(chat, msg)
    if (!content.text || !ctx.fresh) return // média sans texte : gardé en mémoire, pas de réponse
    if (
      isGroup &&
      this.settings.get('groupMode') === 'mention' &&
      !targetsMe(content.contextInfo, content.text, this.wa.myIds(), this.wa.me?.number)
    ) {
      return
    }
    this.schedule(ctx, mode)
  }

  // ---------- réponses de l'IA ----------

  schedule(ctx, mode, delaySec = this.settings.get('replyDelay')) {
    const { chat } = ctx
    clearTimeout(this.timers.get(chat))
    const ms = Math.max(0, Math.min(120, Number(delaySec) || 0)) * 1000
    this.timers.set(
      chat,
      setTimeout(() => {
        this.timers.delete(chat)
        this.respond(ctx, mode).catch((err) => this.log.error({ err: err?.message }, 'Erreur de réponse IA'))
      }, ms),
    )
  }

  cancel(chat) {
    clearTimeout(this.timers.get(chat))
    this.timers.delete(chat)
    this.again.delete(chat)
  }

  cancelAll() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.again.clear()
  }

  async chatInfo(ctx) {
    if (ctx.isGroup) {
      const meta = await this.wa.groupMetadata(ctx.chat)
      if (meta?.subject) this.setLabel(ctx.chat, meta.subject)
      return { isGroup: true, name: meta?.subject || this.label(ctx.chat) }
    }
    if (ctx.self) return { isGroup: false, self: true, name: this.ownerName() || 'toi' }
    return { isGroup: false, name: this.label(ctx.chat) }
  }

  async respond(ctx, mode) {
    const { chat } = ctx
    if (this.busy.has(chat)) {
      this.again.set(chat, { ctx, mode })
      return
    }
    if (!this.wa.connected || !this.canReply(ctx.ids, mode)) return
    const history = this.memory.get(chat)
    const last = history[history.length - 1]
    // On répond au dernier message : celui de l'interlocuteur, ou le tien (discussion « Moi » ou .aai)
    const toOwner = ctx.self || mode === 'aai'
    if (!last || last.r !== (toOwner ? 'me' : 'them')) return
    this.busy.add(chat)
    try {
      await this.wa.presence(chat, 'composing')
      const info = await this.chatInfo(ctx)
      const res = await this.ai.reply({ mode, history, chat: info, ownerName: this.ownerName() })
      const newer = this.memory.get(chat).filter((e) => e.ts > last.ts)
      if (!ctx.self && newer.some((e) => e.r === 'me')) return // tu as écrit entre-temps
      if (!this.canReply(ctx.ids, mode)) return // mode désactivé entre-temps
      let text = res.text
      if (mode === 'meai') await sleep(Math.min(4000, 500 + text.length * 25)) // temps de frappe réaliste
      if (mode !== 'meai' && this.settings.get('signature')) text += `\n\n_— ${this.settings.get('botName')} 🤖_`
      // .aai : l'IA cite ton message pour montrer qu'elle te répond à toi
      const quoted = mode === 'aai' ? ctx.msg : ctx.isGroup ? this.lastIncoming.get(chat) : undefined
      await this.wa.send(chat, { text }, quoted ? { quoted } : {})
      this.memory.addAfter(chat, { r: 'bot', mode, text: res.text }, last.ts)
    } catch (err) {
      await this.notifyError(err, ctx)
    } finally {
      this.busy.delete(chat)
      await this.wa.presence(chat, 'paused')
      const next = this.again.get(chat)
      if (next) {
        this.again.delete(chat)
        this.schedule(next.ctx, next.mode, 0)
      }
    }
  }

  /** Les erreurs sont envoyées dans TA discussion perso, jamais à ton interlocuteur. */
  async notifyError(err, ctx) {
    const message = err?.message || String(err)
    this.log.warn({ err: message }, 'Réponse IA impossible')
    const key = message.slice(0, 80)
    if (Date.now() - (this.errorNotified.get(key) || 0) < 10 * 60_000) return
    this.errorNotified.set(key, Date.now())
    const self = this.wa.selfJid()
    if (!self) return
    await this.wa.send(self, { text: `⚠️ *Réponse IA impossible* (${this.label(ctx.chat)})\n${message}` }).catch(() => {})
  }
}
