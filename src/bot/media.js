import { extractContent } from './message.js'
import { TTLCache } from '../utils/ttlCache.js'
import { MediaService, formatSeconds, userMessage } from '../media/youtube.js'

/**
 * .song et .video : miniature + choix du format, puis téléchargement en arrière-plan.
 *  .song  → 1. MP3 (fichier)  2. Audio WhatsApp
 *  .video → 1. MP4 (fichier)  2. Vidéo WhatsApp
 */

const YT_SHORT = 'https://youtu.be/'
export const WA_INLINE_MAX_BYTES = 64 * 1024 * 1024 // au-delà, l'audio/la vidéo part en fichier

export const MEDIA_KINDS = {
  audio: {
    step: 'song',
    icon: '🎵',
    options: [
      { format: 'mp3', label: '🎧 MP3 (fichier)', re: /^(1|mp3|fichier|file|doc|document)$/i },
      { format: 'audio', label: '🔊 Audio WhatsApp', re: /^(2|audio|vocal|son|wa|whatsapp|audio whatsapp)$/i },
    ],
  },
  video: {
    step: 'video',
    icon: '🎬',
    options: [
      { format: 'mp4', label: '📁 MP4 (fichier)', re: /^(1|mp4|fichier|file|doc|document)$/i },
      { format: 'video', label: '▶️ Vidéo WhatsApp', re: /^(2|vid[eé]o|wa|whatsapp|vid[eé]o whatsapp)$/i },
    ],
  },
}

const STEP_KIND = { song: 'audio', video: 'video' }
const SHORT = { mp3: 'MP3', audio: 'audio WhatsApp', mp4: 'MP4', video: 'vidéo WhatsApp' }
const DONE = { mp3: 'MP3 envoyé', audio: 'audio WhatsApp envoyé', mp4: 'MP4 envoyé', video: 'vidéo WhatsApp envoyée' }

/** « 1 », « mp3 », « 2 », « audio »… → format choisi (ou null). */
export function parseMediaChoice(kind, input) {
  const s = String(input || '')
    .trim()
    .replace(/^\*+|\*+$/g, '')
    .replace(/[.!)\s]+$/, '')
    .trim()
  return MEDIA_KINDS[kind]?.options.find((o) => o.re.test(s))?.format || null
}

/** Légende de la miniature. */
export function previewText(item, kind, { where = '' } = {}) {
  const k = MEDIA_KINDS[kind]
  const lines = []
  if (where) lines.push(where)
  lines.push(`${k.icon} *${item.title || 'Sans titre'}*`)
  if (item.channel) lines.push(`👤 ${item.channel}`)
  const facts = [item.duration ? `⏱️ ${formatSeconds(item.duration)}` : '', item.views ? `👁️ ${item.views}` : ''].filter(Boolean)
  if (facts.length) lines.push(facts.join(' • '))
  const link = item.source === 'youtube' ? YT_SHORT + item.id : item.url
  if (link) lines.push(`🔗 ${link}`)
  lines.push('', ...k.options.map((o, i) => `*${i + 1}.* ${o.label}`), '', '_Réponds *1* ou *2* (*0* pour annuler)._')
  return lines.join('\n')
}

/** Message WhatsApp à envoyer pour un fichier prêt. */
export function buildMediaMessage(job) {
  const thumb = job.thumb ? { jpegThumbnail: job.thumb } : {}
  const doc = (mimetype) => ({ document: { url: job.file }, mimetype, fileName: job.fileName, ...thumb })
  const seconds = Number.isFinite(job.seconds) && job.seconds > 0 ? { seconds: Math.round(job.seconds) } : {}
  const tooBig = job.size > WA_INLINE_MAX_BYTES
  const note = '_(trop lourd pour la lecture directe dans WhatsApp : envoyé en fichier)_'
  switch (job.format) {
    case 'mp3':
      return { content: doc('audio/mpeg') }
    case 'audio':
      if (tooBig) return { content: doc(job.mimetype), note }
      return { content: { audio: { url: job.file }, mimetype: job.mimetype, ptt: false, ...seconds } }
    case 'mp4':
      return { content: doc('video/mp4') }
    default: {
      if (tooBig) return { content: doc('video/mp4'), note }
      const dims = job.width && job.height ? { width: job.width, height: job.height } : {}
      return {
        content: { video: { url: job.file }, mimetype: 'video/mp4', caption: `🎬 *${job.title}*`, ...seconds, ...dims, ...thumb },
      }
    }
  }
}

export function createMediaCommands(bot) {
  const P = bot.prefix
  const previews = new TTLCache({ ttlMs: 30 * 60_000, max: 300 }) // miniature envoyée → résultat (réponses en citant)
  const running = new Set()
  const pendingKey = (ctx) => `public:${ctx?.chat || ''}${ctx?.isGroup ? `#${ctx?.key?.participant || ''}` : ''}`
  const send = (chat, content, options) => bot.wa.send(chat, content, options)
  const service = () => {
    if (!bot.media) bot.media = new MediaService({ options: bot.config?.media, log: bot.log })
    return bot.media
  }

  const usage = (kind) =>
    (kind === 'audio'
      ? [`🎵 *${P}song <titre ou lien>*`, `Ex. : ${P}song bababoy`, '', "Je t'envoie la miniature, puis tu choisis :", '*1.* 🎧 MP3 (fichier)', '*2.* 🔊 Audio WhatsApp']
      : [`🎬 *${P}video <titre ou lien>*`, `Ex. : ${P}video bababoy`, '', "Je t'envoie la miniature, puis tu choisis :", '*1.* 📁 MP4 (fichier)', '*2.* ▶️ Vidéo WhatsApp']
    ).join('\n')

  function quotedText(ctx) {
    const quoted = ctx?.content?.contextInfo?.quotedMessage
    if (!quoted) return ''
    try {
      return extractContent(quoted).text || ''
    } catch {
      return ''
    }
  }

  /** .song / .video : recherche + miniature + choix. */
  async function request(a, kind) {
    const query = String(a.arg || '').trim() || quotedText(a.ctx)
    if (!query) return a.say(usage(kind))
    const media = service()
    let item
    try {
      item = await media.search(query, kind)
    } catch (err) {
      bot.log.warn({ err: err?.message, detail: err?.detail }, 'Recherche musique/vidéo impossible')
      return a.say(`❌ ${userMessage(err)}`)
    }
    if (!item) return a.say(`🔎 Aucun résultat pour « ${query} ».`)
    const max = media.maxSeconds(kind)
    if (item.duration && item.duration > max) {
      return a.say(`⏱️ *${item.title}* dure ${formatSeconds(item.duration)} : c'est trop long (max ${Math.round(max / 60)} min).`)
    }
    const where = a.menuChat !== a.t.chat ? `📍 _${bot.label(a.t.chat)}_` : ''
    const caption = previewText(item, kind, { where })
    const discreet = bot.settings.get('discreet') && !a.ctx?.self
    const options = a.ctx?.msg && !where && !discreet ? { quoted: a.ctx.msg } : {}
    const thumb = await media.thumbnail(item).catch(() => null)
    let sent = null
    if (thumb?.image) {
      const content = { image: thumb.image, caption, ...(thumb.small ? { jpegThumbnail: thumb.small } : {}) }
      sent = await send(a.menuChat, content, options).catch((err) => {
        bot.log.warn({ err: err?.message }, 'Miniature non envoyée')
        return null
      })
    }
    if (!sent) sent = await send(a.menuChat, { text: caption }, options).catch(() => null)
    bot.setPending(a.pendingKey || a.menuChat, { step: MEDIA_KINDS[kind].step, target: a.t, item, kind })
    if (sent?.key?.id) previews.set(sent.key.id, { item, kind })
  }

  /** Réponse « 1 » ou « 2 » après la miniature. */
  async function choose(a, kind) {
    const format = parseMediaChoice(kind, a.arg)
    if (!format) {
      bot.setPending(a.pendingKey || a.menuChat, { ...a.pending })
      return a.say('❌ Réponds *1* ou *2* (*0* pour annuler).')
    }
    deliver(a.menuChat, a.pending.item, format)
  }

  /** Télécharge, convertit et envoie (en arrière-plan, un fichier à la fois). */
  function deliver(chat, item, format) {
    const media = service()
    const title = item.title || 'Sans titre'
    const task = (async () => {
      const ahead = media.queue.size
      const status = await send(chat, {
        text: ahead ? `⏳ *${title}* — en file d'attente (${ahead} avant).` : `⏳ *${title}* — téléchargement (${SHORT[format]})…`,
      }).catch(() => null)
      const edit = async (text) => {
        if (status?.key) await send(chat, { text, edit: status.key }).catch(() => {})
      }
      try {
        await media.queue.run(async () => {
          if (ahead) await edit(`⏳ *${title}* — téléchargement (${SHORT[format]})…`)
          const job = await media.prepare(item, format, {
            onStage: (stage) => (stage === 'convert' ? edit(`🎛️ *${title}* — conversion (${SHORT[format]})…`) : null),
          })
          try {
            await edit(`📤 *${title}* — envoi (${(job.size / 1048576).toFixed(1).replace('.', ',')} Mo)…`)
            const { content, note } = buildMediaMessage(job)
            await send(chat, content)
            await edit(`✅ *${title}* — ${DONE[format]}.${note ? `\n${note}` : ''}`)
          } finally {
            await job.cleanup()
          }
        })
      } catch (err) {
        bot.log.warn({ err: err?.message, detail: err?.detail, url: item.url, format }, 'Échec de .song/.video')
        await edit(`❌ *${title}* — échec.`)
        await send(chat, { text: `❌ *${title}* — ${userMessage(err)}` }).catch(() => {})
      }
    })()
    running.add(task)
    task.then(
      () => running.delete(task),
      () => running.delete(task),
    )
    return task
  }

  /** Réponse en citant une miniature (marche même si le choix a expiré ou si plusieurs recherches sont en cours). */
  async function handleReply(ctx) {
    const id = ctx?.content?.contextInfo?.stanzaId
    if (!id) return false
    const preview = previews.get(id)
    if (!preview) return false
    const format = parseMediaChoice(preview.kind, ctx.text)
    if (!format) return false
    for (const key of new Set([ctx.chat, pendingKey(ctx)])) {
      const pending = bot.getPending(key)
      if (pending && STEP_KIND[pending.step] && pending.item?.id === preview.item.id) bot.clearPending(key)
    }
    deliver(ctx.chat, preview.item, format)
    return true
  }

  const song = (a) => request(a, 'audio')
  const video = (a) => request(a, 'video')

  return {
    COMMANDS: { song, musique: song, music: song, chanson: song, play: song, video, 'vidéo': video, vid: video, clip: video },
    STEPS: { song: (a) => choose(a, 'audio'), video: (a) => choose(a, 'video') },
    isStep: (step) => Object.hasOwn(STEP_KIND, step || ''),
    accepts: (pending, input) => !!parseMediaChoice(STEP_KIND[pending?.step], input),
    handleReply,
    idle: () => Promise.allSettled([...running]),
    statusText: () => (bot.media ? bot.media.statusText() : 'prêt au premier usage'),
  }
}
