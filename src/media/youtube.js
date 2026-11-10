import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ROOT_DIR, localYtdlpPath, installYtdlp, commandVersion, findFfmpeg, runProcess, splitArgs } from './tools.js'

/**
 * Recherche YouTube, miniatures, téléchargement (yt-dlp) et conversion (ffmpeg)
 * pour les commandes .song et .video.
 */

const WEB_CLIENT_VERSION = '2.20260708.00.00'
const SEARCH_VIDEOS_ONLY = 'EgIQAfABAQ=='
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const YT_WATCH = 'https://www.youtube.com/watch?v='
const YT_IMG = 'https://i.ytimg.com/vi/'
const YT_OEMBED = 'https://www.youtube.com/oembed?format=json&url='
const ID_RE = /^[A-Za-z0-9_-]{11}$/
const JOBS_DIR = path.join(os.tmpdir(), 'wa-bot-media')
const DAY = 24 * 60 * 60_000
const DOWNLOAD_TIMEOUT = 15 * 60_000
const CONVERT_TIMEOUT = 20 * 60_000

const DEFAULTS = {
  ytdlpPath: '',
  ffmpegPath: '',
  cookies: '',
  cookiesFile: '',
  songMaxMinutes: 30,
  videoMaxMinutes: 15,
  videoMaxHeight: 480,
  maxMb: 100,
  extraArgs: '',
}

const AUDIO_MIME = {
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg; codecs=opus',
  opus: 'audio/ogg; codecs=opus',
  webm: 'audio/webm',
  aac: 'audio/aac',
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }

/** Erreur avec un message déjà lisible par l'utilisateur. */
export class MediaError extends Error {
  constructor(message, { detail } = {}) {
    super(message)
    this.name = 'MediaError'
    this.detail = detail || null
  }
}

/** File d'attente : un seul téléchargement à la fois (Render gratuit = peu de CPU/RAM). */
export class JobQueue {
  #tail = Promise.resolve()
  #count = 0

  get size() {
    return this.#count
  }

  run(fn) {
    this.#count++
    const job = this.#tail.then(() => fn())
    this.#tail = job
      .then(
        () => {},
        () => {},
      )
      .then(() => {
        this.#count--
      })
    return job
  }
}

// ─────────────────────────────── Petites fonctions utiles ───────────────────────────────

export function textOf(o) {
  if (o == null) return ''
  if (typeof o === 'string') return o
  if (typeof o.simpleText === 'string') return o.simpleText
  if (Array.isArray(o.runs)) return o.runs.map((r) => r?.text || '').join('')
  if (typeof o.content === 'string') return o.content
  return ''
}

/** « 3:45 » → 225, « 1:02:03 » → 3723 */
export function parseDuration(text) {
  const s = String(text ?? '').trim()
  if (!/^\d{1,3}(:\d{1,2}){1,2}$/.test(s)) return null
  return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0)
}

/** 225 → « 3:45 » */
export function formatSeconds(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '?'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`
}

export function formatCount(n) {
  if (!Number.isFinite(n) || n < 0) return ''
  const fmt = (v, unit) => `${v.toLocaleString('fr-FR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${unit}`
  if (n >= 1e9) return fmt(n / 1e9, 'Md')
  if (n >= 1e6) return fmt(n / 1e6, 'M')
  if (n >= 1e3) return fmt(n / 1e3, 'k')
  return String(n)
}

export function cleanChannel(name) {
  return String(name || '')
    .replace(/\s+-\s+Topic$/i, '')
    .trim()
}

export function safeFileName(name) {
  return (
    String(name || 'media')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100)
      .replace(/[. ]+$/, '') || 'media'
  )
}

/** Premier lien http(s) d'un texte. */
export function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>]+/i)
  return m ? m[0].replace(/[)\]}>.,!?»"']+$/, '') : null
}

/** Identifiant de vidéo d'un lien YouTube (watch, youtu.be, shorts, embed, live, music). */
export function parseYouTubeId(input) {
  let u
  try {
    u = new URL(String(input || '').trim())
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
  if (host === 'youtu.be') {
    const id = u.pathname.split('/')[1] || ''
    return ID_RE.test(id) ? id : null
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v')
    if (v && ID_RE.test(v)) return v
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v|e)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/)
    return m ? m[1] : null
  }
  return null
}

export function ytItem({ id, title = '', channel = '', duration = null, views = '', live = false }) {
  return {
    id,
    source: 'youtube',
    url: `${YT_WATCH}${id}`,
    title: title || '',
    channel: cleanChannel(channel),
    duration: Number.isFinite(duration) ? duration : null,
    views: views || '',
    thumbnail: `${YT_IMG}${id}/hqdefault.jpg`,
    live: !!live,
  }
}

function findAll(node, key, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 30) return out
  if (Array.isArray(node)) {
    for (const x of node) findAll(x, key, out, depth + 1)
    return out
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key && v && typeof v === 'object') out.push(v)
    else findAll(v, key, out, depth + 1)
  }
  return out
}

function fromVideoRenderer(r) {
  const id = r?.videoId
  if (!ID_RE.test(id || '')) return null
  const lengthText = textOf(r.lengthText)
  const flags = JSON.stringify([r.thumbnailOverlays || [], r.badges || []])
  const live = /"style":"(LIVE|UPCOMING)"|LIVE_NOW/.test(flags) || (!lengthText && !!r.upcomingEventData)
  return ytItem({
    id,
    title: textOf(r.title),
    channel: textOf(r.ownerText) || textOf(r.longBylineText) || textOf(r.shortBylineText),
    duration: parseDuration(lengthText),
    views: textOf(r.shortViewCountText) || textOf(r.viewCountText),
    live,
  })
}

function fromLockup(v) {
  if (v?.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null
  const id = v.contentId
  if (!ID_RE.test(id || '')) return null
  const meta = v.metadata?.lockupMetadataViewModel || {}
  const rows = meta.metadata?.contentMetadataViewModel?.metadataRows || []
  const parts = rows.flatMap((row) => (row?.metadataParts || []).map((p) => textOf(p?.text)).filter(Boolean))
  const badges = findAll(v.contentImage, 'thumbnailBadgeViewModel')
  const durationText = badges.map((b) => textOf(b.text)).find((t) => parseDuration(t))
  const live = badges.some((b) => /LIVE/.test(b.badgeStyle || ''))
  return ytItem({
    id,
    title: textOf(meta.title),
    channel: parts[0] || '',
    duration: parseDuration(durationText),
    views: parts.find((p) => /vues|views|visualizza|aufrufe/i.test(p)) || '',
    live,
  })
}

/** Résultats de recherche d'une réponse InnerTube (videoRenderer et lockupViewModel). */
export function parseSearchResults(data, limit = 10) {
  const out = []
  const seen = new Set()
  const add = (item) => {
    if (item && item.title && !seen.has(item.id)) {
      seen.add(item.id)
      out.push(item)
    }
  }
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 40 || out.length >= limit) return
    if (Array.isArray(node)) {
      for (const x of node) visit(x, depth + 1)
      return
    }
    if (node.videoRenderer) return add(fromVideoRenderer(node.videoRenderer))
    if (node.lockupViewModel) return add(fromLockup(node.lockupViewModel))
    for (const [k, v] of Object.entries(node)) {
      if (/^(adSlotRenderer|searchPyvRenderer|promoted)/.test(k)) continue // publicités
      visit(v, depth + 1)
    }
  }
  visit(data, 0)
  return out
}

/** Entrée yt-dlp (-J) → résultat. */
export function fromYtDlpEntry(e) {
  if (!e?.id) return null
  const extractor = String(e.ie_key || e.extractor_key || e.extractor || '')
  const isYt = ID_RE.test(e.id) && (!extractor || /youtube/i.test(extractor))
  const thumbs = Array.isArray(e.thumbnails) ? e.thumbnails.filter((t) => t?.url) : []
  return {
    id: String(e.id),
    source: isYt ? 'youtube' : extractor || 'web',
    url: isYt ? `${YT_WATCH}${e.id}` : e.webpage_url || e.original_url || e.url,
    title: e.title || 'Sans titre',
    channel: cleanChannel(e.channel || e.uploader || e.artist || ''),
    duration: Number.isFinite(e.duration) ? Math.round(e.duration) : null,
    views: Number.isFinite(e.view_count) ? `${formatCount(e.view_count)} vues` : '',
    thumbnail: e.thumbnail || thumbs.at(-1)?.url || (isYt ? `${YT_IMG}${e.id}/hqdefault.jpg` : null),
    live: e.live_status === 'is_live' || e.live_status === 'is_upcoming' || e.is_live === true,
  }
}

/** Premier résultat lisible et pas trop long. */
export function pickResult(results, maxSeconds) {
  const playable = (results || []).filter((r) => r && !r.live)
  return playable.find((r) => !r.duration || !maxSeconds || r.duration <= maxSeconds) || playable[0] || null
}

/** Infos utiles de « ffmpeg -i fichier » (codecs, durée, taille). */
export function parseProbe(text) {
  const t = String(text || '')
  const d = t.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/)
  const container = t.match(/Input #0, (.+?), from /)?.[1] || null
  let vcodec = null
  let acodec = null
  let width = null
  let height = null
  for (const line of t.split(/\r?\n/)) {
    if (!vcodec && /Stream #\d+:\d+.*?: Video: /.test(line) && !/attached pic/i.test(line)) {
      vcodec = line.match(/: Video: ([a-z0-9_]+)/i)?.[1]?.toLowerCase() || null
      const dim = line.match(/[\s,](\d{2,5})x(\d{2,5})(?=[\s,\]]|$)/)
      if (dim) {
        width = Number(dim[1])
        height = Number(dim[2])
      }
    }
    if (!acodec && /Stream #\d+:\d+.*?: Audio: /.test(line)) {
      acodec = line.match(/: Audio: ([a-z0-9_]+)/i)?.[1]?.toLowerCase() || null
    }
  }
  const duration = d ? Math.round(Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) : null
  return { duration, container, vcodec, acodec, width, height }
}

/** Options de format yt-dlp. */
export function formatArgs(kind, hasFfmpeg, maxHeight = 480) {
  const h = Math.max(144, Number(maxHeight) || 480)
  if (kind === 'audio') return ['-f', `ba[ext=m4a]/ba[acodec^=mp4a]/ba/b[height<=${h}]/b`]
  if (!hasFfmpeg) return ['-f', 'b[ext=mp4][vcodec^=avc]/b[ext=mp4]/b', '-S', `res:${h}`]
  return ['-f', 'bv*[vcodec^=avc]+ba[ext=m4a]/b[vcodec^=avc]/bv*+ba/b', '-S', `res:${h}`, '--merge-output-format', 'mp4']
}

export function lastErrorLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return [...lines].reverse().find((l) => /^ERROR:/i.test(l)) || lines.at(-1) || ''
}

/** Traduit une erreur yt-dlp/ffmpeg en message clair. */
export function explainError(input) {
  const text = String(input || '')
  if (/confirm your age|age.?restricted|inappropriate for some users/i.test(text)) {
    return "🔞 Vidéo soumise à une limite d'âge : il faut les cookies d'un compte YouTube adulte (voir le README)."
  }
  if (/confirm you.?re not a bot|sign in to confirm|not a robot|HTTP Error 429|Too Many Requests/i.test(text)) {
    return "🤖 YouTube bloque le serveur (« confirme que tu n'es pas un robot »). Ajoute tes cookies YouTube (variable YT_COOKIES ou fichier secret cookies.txt, voir le README) puis réessaie."
  }
  if (/private video|vidéo privée/i.test(text)) return '🔒 Cette vidéo est privée.'
  if (/members.?only|join this channel/i.test(text)) return '🔒 Vidéo réservée aux membres de la chaîne.'
  if (/not available in your country|blocked it in your country|geo.?restrict/i.test(text)) {
    return '🌍 Vidéo bloquée dans le pays du serveur.'
  }
  if (/video unavailable|has been removed|no longer available|terminated|does not exist|HTTP Error 404/i.test(text)) {
    return '🚫 Vidéo indisponible (supprimée ou introuvable).'
  }
  if (/does not pass filter|is live|live event|premieres? in/i.test(text)) {
    return '📡 Les directs, les premières et les vidéos trop longues ne sont pas pris en charge.'
  }
  if (/requested format is not available|no video formats found/i.test(text)) {
    return '🎞️ Aucun format téléchargeable pour cette vidéo. Réessaie plus tard (yt-dlp se met à jour tout seul).'
  }
  if (/HTTP Error 403|Forbidden/i.test(text)) {
    return '⛔ YouTube a refusé le téléchargement (403). Réessaie dans un moment ; si ça continue, ajoute des cookies (voir le README).'
  }
  if (/ENOSPC|No space left/i.test(text)) return '💾 Plus de place sur le disque du serveur.'
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|getaddrinfo|ENOTFOUND|Unable to download|fetch failed/i.test(text)) {
    return '🌐 Problème de connexion avec YouTube. Réessaie dans un moment.'
  }
  const line = lastErrorLine(text)
    .replace(/^ERROR:\s*/i, '')
    .replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '')
  return line ? `⚠️ ${line.slice(0, 200)}` : '⚠️ Erreur inconnue.'
}

/** Message à afficher pour n'importe quelle erreur. */
export function userMessage(err) {
  if (err instanceof MediaError) return err.message
  return explainError(err?.stderr || err?.message || String(err))
}

/** Cookies YouTube : texte Netscape brut ou encodé en base64 (pratique pour une variable d'environnement). */
export function decodeCookies(value) {
  let s = String(value || '').trim()
  if (!s) return null
  const looksLikeCookies = (x) => /\t|# ?Netscape|# ?HTTP Cookie File|youtube\.com/i.test(x)
  if (!looksLikeCookies(s)) {
    try {
      const decoded = Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8')
      if (looksLikeCookies(decoded)) s = decoded
    } catch {}
  }
  if (!s.includes('\n')) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  return looksLikeCookies(s) ? normalizeCookies(s) : null
}

/** Répare un fichier cookies.txt (tabulations remplacées par des espaces, en-tête manquant…). */
export function normalizeCookies(text) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const l = line.trim()
      if (!l || (l.startsWith('#') && !l.startsWith('#HttpOnly_')) || l.includes('\t')) return l
      const parts = l.split(/\s+/)
      return parts.length >= 7 ? [...parts.slice(0, 6), parts.slice(6).join(' ')].join('\t') : l
    })
  let out = lines.join('\n').trim()
  if (!/^# (Netscape )?HTTP Cookie File/im.test(out)) out = `# Netscape HTTP Cookie File\n${out}`
  return `${out}\n`
}

function isJpeg(buf) {
  return Buffer.isBuffer(buf) && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8
}

function parseLastJson(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i])
    } catch {}
  }
  return null
}

async function findMediaFile(dir) {
  const names = await fsp.readdir(dir).catch(() => [])
  let best = null
  for (const name of names) {
    if (!/^media\.[a-z0-9]{2,5}$/i.test(name)) continue
    const file = path.join(dir, name)
    const { size } = await fsp.stat(file).catch(() => ({ size: 0 }))
    if (size > 0 && (!best || size > best.size)) best = { file, size }
  }
  return best?.file || null
}

const toMb = (bytes) => (bytes / 1024 / 1024).toFixed(1).replace('.', ',')

// ─────────────────────────────── Service ───────────────────────────────

export class MediaService {
  constructor({ options = {}, log, fetchImpl } = {}) {
    const given = Object.fromEntries(Object.entries(options || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''))
    this.opts = { ...DEFAULTS, ...given }
    this.log = log || silentLog
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args))
    this.queue = new JobQueue()
    this.state = { ytdlp: null, ffmpeg: undefined, error: null }
    this.thumbs = new Map()
    this._ytdlp = null
    this._ffmpeg = null
    this._cookies = undefined
    this._timer = null
  }

  maxSeconds(kind) {
    return (kind === 'video' ? this.opts.videoMaxMinutes : this.opts.songMaxMinutes) * 60
  }

  /** Prépare les outils en arrière-plan (au démarrage du bot). */
  async warmup() {
    await this.cleanStale()
    if (await this.cookiesFile().catch(() => null)) this.log.info('Cookies YouTube chargés')
    const [y, f] = await Promise.allSettled([this.ytdlp(), this.ffmpeg()])
    if (y.status === 'fulfilled') this.log.info({ version: y.value.version }, 'yt-dlp prêt')
    else this.log.warn({ err: y.reason?.detail || y.reason?.message }, 'yt-dlp indisponible pour le moment')
    if (f.status !== 'fulfilled' || !f.value) this.log.warn('ffmpeg introuvable : MP3 et conversions indisponibles')
    this.scheduleUpdates()
  }

  ytdlp() {
    if (!this._ytdlp) {
      this._ytdlp = this.#resolveYtdlp().then(
        (bin) => {
          this.state.ytdlp = bin
          this.state.error = null
          return bin
        },
        (err) => {
          this._ytdlp = null
          this.state.error = err?.message || String(err)
          throw new MediaError("⚙️ yt-dlp est introuvable et n'a pas pu être téléchargé. Réessaie plus tard.", {
            detail: this.state.error,
          })
        },
      )
    }
    return this._ytdlp
  }

  async #resolveYtdlp() {
    const managed = localYtdlpPath()
    for (const candidate of [this.opts.ytdlpPath, managed, 'yt-dlp']) {
      if (!candidate) continue
      const version = await commandVersion(candidate)
      if (version && /^\d{4}\.\d{2}\.\d{2}/.test(version)) return { path: candidate, version, managed: candidate === managed }
    }
    this.log.info('yt-dlp absent : téléchargement de la dernière version…')
    const bin = await installYtdlp({ fetchImpl: this.fetch })
    return { path: bin.path, version: bin.version, managed: true }
  }

  ffmpeg() {
    if (!this._ffmpeg) {
      this._ffmpeg = findFfmpeg(this.opts.ffmpegPath).then((found) => {
        this.state.ffmpeg = found
        return found
      })
    }
    return this._ffmpeg
  }

  /** Mise à jour automatique de yt-dlp (YouTube change souvent). */
  scheduleUpdates() {
    if (this._timer) return
    const tick = () => this.queue.run(() => this.update()).catch((err) => this.log.warn({ err: err?.message }, 'Mise à jour de yt-dlp impossible'))
    this._timer = setInterval(tick, DAY)
    this._timer.unref?.()
    setTimeout(tick, 10 * 60_000).unref?.()
  }

  async update() {
    const bin = await this.ytdlp()
    if (!bin.managed) return { version: bin.version, updated: false }
    const before = bin.version
    await runProcess(bin.path, ['-U'], { timeoutMs: 300_000 })
    bin.version = (await commandVersion(bin.path)) || before
    if (bin.version !== before) this.log.info({ from: before, to: bin.version }, 'yt-dlp mis à jour')
    return { version: bin.version, updated: bin.version !== before }
  }

  statusText() {
    const y = this.state.ytdlp ? `yt-dlp ${this.state.ytdlp.version} ✅` : this.state.error ? 'yt-dlp ❌' : 'yt-dlp ⏳'
    const f = this.state.ffmpeg ? 'ffmpeg ✅' : this.state.ffmpeg === null ? 'ffmpeg ❌' : 'ffmpeg ⏳'
    const c = this._cookies ? ' • cookies YouTube ✅' : ''
    const q = this.queue.size ? ` • ${this.queue.size} en cours` : ''
    return `${y} • ${f}${c}${q}`
  }

  async cookiesFile() {
    if (this._cookies !== undefined) return this._cookies
    let text = null
    for (const file of [this.opts.cookiesFile, '/etc/secrets/cookies.txt', path.join(ROOT_DIR, 'cookies.txt')]) {
      if (!file) continue
      try {
        const content = await fsp.readFile(file, 'utf8')
        if (content.trim()) {
          text = normalizeCookies(content)
          break
        }
      } catch {}
    }
    if (!text && this.opts.cookies) text = decodeCookies(this.opts.cookies)
    if (!text) {
      if (this.opts.cookies) this.log.warn('YT_COOKIES ne ressemble pas à un fichier cookies.txt : ignoré')
      this._cookies = null
      return null
    }
    // Copie modifiable : yt-dlp réécrit le fichier de cookies.
    await fsp.mkdir(JOBS_DIR, { recursive: true })
    const file = path.join(JOBS_DIR, 'cookies.txt')
    await fsp.writeFile(file, text, { mode: 0o600 })
    this._cookies = file
    return file
  }

  async commonArgs(bin, ffmpeg) {
    const args = ['--ignore-config', '--socket-timeout', '30', '--retries', '3', '--fragment-retries', '3']
    const nodeMajor = Number(process.versions.node.split('.')[0])
    if (bin.version >= '2025.11.12' && nodeMajor >= 22) args.push('--js-runtimes', `node:${process.execPath}`)
    if (ffmpeg && path.isAbsolute(ffmpeg.path)) args.push('--ffmpeg-location', ffmpeg.path)
    const cookies = await this.cookiesFile()
    if (cookies) args.push('--cookies', cookies)
    args.push(...splitArgs(this.opts.extraArgs))
    return args
  }

  // ── Recherche ──

  /** Trouve le meilleur résultat pour un titre ou un lien. */
  async search(query, kind = 'audio') {
    const q = String(query || '').trim().slice(0, 300)
    if (!q) return null
    const url = extractUrl(q)
    if (url) return this.lookupUrl(url)
    let results = []
    try {
      results = await this.searchInnertube(q)
    } catch (err) {
      this.log.warn({ err: err?.message }, 'Recherche YouTube directe impossible, essai avec yt-dlp')
    }
    if (!results.length) results = await this.searchYtDlp(q)
    return pickResult(results, this.maxSeconds(kind))
  }

  async searchInnertube(query, limit = 10) {
    const res = await this.fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': UA,
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        'X-Youtube-Client-Name': '1',
        'X-Youtube-Client-Version': WEB_CLIENT_VERSION,
        Origin: 'https://www.youtube.com',
        Referer: 'https://www.youtube.com/',
        Cookie: 'SOCS=CAI',
      },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: WEB_CLIENT_VERSION, hl: 'fr', gl: 'FR' } },
        query,
        params: SEARCH_VIDEOS_ONLY,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return parseSearchResults(await res.json(), limit)
  }

  async searchYtDlp(query, limit = 5) {
    const bin = await this.ytdlp()
    const args = [...(await this.commonArgs(bin, null)), '--flat-playlist', '-J', '--', `ytsearch${limit}:${query}`]
    const res = await runProcess(bin.path, args, { timeoutMs: 120_000 })
    if (res.code !== 0) throw new MediaError(explainError(res.stderr), { detail: lastErrorLine(res.stderr) })
    let data
    try {
      data = JSON.parse(res.stdout)
    } catch {
      throw new MediaError('⚠️ Réponse de recherche illisible.')
    }
    return (data.entries || []).map(fromYtDlpEntry).filter(Boolean)
  }

  async lookupUrl(url) {
    const id = parseYouTubeId(url)
    if (id) {
      try {
        const hit = (await this.searchInnertube(id, 20)).find((r) => r.id === id)
        if (hit) return hit
      } catch {}
      const item = ytItem({ id })
      try {
        const res = await this.fetch(`${YT_OEMBED}${encodeURIComponent(item.url)}`, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(10_000),
        })
        if (res.ok) {
          const o = await res.json()
          item.title = o.title || ''
          item.channel = cleanChannel(o.author_name)
        }
      } catch {}
      if (!item.title) Object.assign(item, { title: 'Vidéo YouTube', placeholderTitle: true })
      return item
    }
    // Autre site (TikTok, Instagram, SoundCloud…) : yt-dlp lit les infos.
    const bin = await this.ytdlp()
    const args = [...(await this.commonArgs(bin, null)), '-J', '--no-playlist', '--flat-playlist', '--', url]
    const res = await runProcess(bin.path, args, { timeoutMs: 120_000 })
    if (res.code !== 0) throw new MediaError(explainError(res.stderr), { detail: lastErrorLine(res.stderr) })
    let info
    try {
      info = JSON.parse(res.stdout)
    } catch {
      throw new MediaError('⚠️ Infos de la vidéo illisibles.')
    }
    if (info?._type === 'playlist') info = (info.entries || []).find(Boolean) || null
    const item = fromYtDlpEntry(info)
    if (!item) return null
    if (item.source !== 'youtube') item.url = info.webpage_url || info.url || url
    return item
  }

  // ── Miniatures ──

  async thumbnail(item) {
    if (!item) return null
    const cached = this.thumbs.get(item.id)
    if (cached) return cached
    const urls =
      item.source === 'youtube'
        ? ['maxresdefault', 'hqdefault'].map((n) => `${YT_IMG}${item.id}/${n}.jpg`)
        : [item.thumbnail].filter(Boolean)
    let image = null
    for (const u of urls) {
      image = await this.fetchImage(u)
      if (image) break
    }
    if (!image) return null
    const ffmpeg = await this.ffmpeg()
    if (!isJpeg(image)) image = ffmpeg ? await this.imageToJpeg(ffmpeg, image, []) : null
    if (!image) return null
    let small = ffmpeg ? await this.imageToJpeg(ffmpeg, image, ['-vf', 'scale=160:-2', '-q:v', '7']) : null
    if (!small && item.source === 'youtube') small = await this.fetchImage(`${YT_IMG}${item.id}/default.jpg`)
    const thumb = { image, small: small && isJpeg(small) && small.length < 48_000 ? small : null }
    this.thumbs.set(item.id, thumb)
    while (this.thumbs.size > 40) this.thumbs.delete(this.thumbs.keys().next().value)
    return thumb
  }

  async fetchImage(url) {
    try {
      const res = await this.fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      return buf.length > 500 ? buf : null
    } catch {
      return null
    }
  }

  async imageToJpeg(ffmpeg, input, args) {
    try {
      const res = await runProcess(
        ffmpeg.path,
        ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', ...args, '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
        { input, timeoutMs: 30_000 },
      )
      return res.code === 0 && isJpeg(res.stdoutBuffer) ? res.stdoutBuffer : null
    } catch {
      return null
    }
  }

  // ── Téléchargement + conversion ──

  /**
   * Télécharge et convertit. format : 'mp3' | 'audio' (audio WhatsApp) | 'mp4' | 'video' (vidéo WhatsApp).
   * Renvoie { file, mimetype, fileName, size, seconds, width, height, title, thumb, cleanup }.
   */
  async prepare(item, format, { onStage } = {}) {
    const kind = format === 'mp3' || format === 'audio' ? 'audio' : 'video'
    const maxSeconds = this.maxSeconds(kind)
    if (item.duration && item.duration > maxSeconds) {
      throw new MediaError(`⏱️ Trop long : ${formatSeconds(item.duration)} (max ${Math.round(maxSeconds / 60)} min).`)
    }
    const [bin, ffmpeg] = await Promise.all([this.ytdlp(), this.ffmpeg()])
    if (format === 'mp3' && !ffmpeg) throw new MediaError('⚙️ ffmpeg est introuvable : conversion en MP3 impossible.')
    await fsp.mkdir(JOBS_DIR, { recursive: true })
    const dir = await fsp.mkdtemp(path.join(JOBS_DIR, 'job-'))
    const cleanup = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    try {
      await onStage?.('download')
      const { file, meta } = await this.download({ bin, ffmpeg, url: item.url, dir, kind, maxSeconds })
      const probe = ffmpeg ? await this.probe(ffmpeg, file) : {}
      const title = (!item.placeholderTitle && item.title) || meta.title || item.title || 'media'
      const artist = cleanChannel(item.channel || meta.artist || meta.uploader || meta.channel || '')
      const result = await this.convert({ ffmpeg, file, probe, format, dir, item, title, artist, onStage })
      const { size } = await fsp.stat(result.file)
      if (size > this.opts.maxMb * 1024 * 1024) {
        throw new MediaError(`📦 Fichier trop lourd : ${toMb(size)} Mo (max ${this.opts.maxMb} Mo).`)
      }
      const seconds = result.seconds ?? probe.duration ?? (Number.isFinite(meta.duration) ? meta.duration : null) ?? item.duration
      return {
        format,
        file: result.file,
        mimetype: result.mimetype,
        fileName: `${safeFileName(title)}${path.extname(result.file)}`,
        size,
        seconds: Number.isFinite(seconds) ? Math.round(seconds) : null,
        width: result.width ?? probe.width ?? null,
        height: result.height ?? probe.height ?? null,
        title,
        artist,
        thumb: this.thumbs.get(item.id)?.small || null,
        cleanup,
      }
    } catch (err) {
      await cleanup()
      throw err
    }
  }

  async download({ bin, ffmpeg, url, dir, kind, maxSeconds }) {
    const args = [
      ...(await this.commonArgs(bin, ffmpeg)),
      '--no-playlist',
      '--no-progress',
      '--no-mtime',
      '--concurrent-fragments',
      '4',
      '--match-filters',
      `!is_live & duration <=? ${maxSeconds}`,
      '-o',
      path.join(dir, 'media.%(ext)s'),
      '--print',
      'after_move:%(.{id,title,duration,uploader,channel,artist,ext,filepath})j',
      ...formatArgs(kind, !!ffmpeg, this.opts.videoMaxHeight),
      '--',
      url,
    ]
    const res = await runProcess(bin.path, args, { timeoutMs: DOWNLOAD_TIMEOUT })
    const output = `${res.stderr}\n${res.stdout}`
    if (res.timedOut) throw new MediaError('⌛ Le téléchargement a pris trop de temps.')
    if (/does not pass filter/i.test(output)) {
      throw new MediaError(`⏱️ Vidéo en direct ou trop longue (max ${Math.round(maxSeconds / 60)} min).`)
    }
    const meta = parseLastJson(res.stdout)
    let file = meta?.filepath && fs.existsSync(meta.filepath) ? meta.filepath : null
    if (!file && res.code === 0) file = await findMediaFile(dir)
    if (!file) {
      this.log.warn({ code: res.code, error: lastErrorLine(output) }, 'yt-dlp a échoué')
      throw new MediaError(explainError(output), { detail: lastErrorLine(output) })
    }
    return { file, meta: meta || {} }
  }

  async probe(ffmpeg, file) {
    try {
      const res = await runProcess(ffmpeg.path, ['-hide_banner', '-i', file], { timeoutMs: 60_000 })
      return parseProbe(res.stderr)
    } catch {
      return {}
    }
  }

  async ffmpegRun(ffmpeg, args) {
    const res = await runProcess(ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeoutMs: CONVERT_TIMEOUT })
    if (res.timedOut) throw new MediaError('⌛ La conversion a pris trop de temps.')
    if (res.code !== 0) {
      const detail = res.stderr.trim().split(/\r?\n/).slice(-3).join(' | ')
      if (/ENOSPC|No space left/i.test(detail)) throw new MediaError('💾 Plus de place sur le disque du serveur.')
      throw new MediaError('🎛️ La conversion a échoué.', { detail })
    }
  }

  async coverFile(item, dir) {
    try {
      const thumb = this.thumbs.get(item.id) || (await this.thumbnail(item))
      if (!thumb?.image) return null
      const file = path.join(dir, 'cover.jpg')
      await fsp.writeFile(file, thumb.image)
      return file
    } catch {
      return null
    }
  }

  async convert({ ffmpeg, file, probe, format, dir, item, title, artist, onStage }) {
    const out = (ext) => path.join(dir, `final.${ext}`)
    const ff = (args) => this.ffmpegRun(ffmpeg, args)
    const ext = path.extname(file).slice(1).toLowerCase()
    const container = probe.container || ''

    if (format === 'mp3') {
      await onStage?.('convert')
      const tags = ['-id3v2_version', '3', '-metadata', `title=${title}`]
      if (artist) tags.push('-metadata', `artist=${artist}`)
      if (item.url) tags.push('-metadata', `comment=${item.url}`)
      const audio = ['-c:a', 'libmp3lame', '-b:a', '192k']
      const cover = await this.coverFile(item, dir)
      if (cover) {
        try {
          await ff([
            '-i', file, '-i', cover,
            '-map', '0:a:0', '-map', '1:v:0',
            '-c:v', 'copy', '-disposition:v:0', 'attached_pic',
            '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)',
            ...audio, ...tags, out('mp3'),
          ])
          return { file: out('mp3'), mimetype: 'audio/mpeg' }
        } catch (err) {
          this.log.warn({ err: err?.detail || err?.message }, 'Pochette non ajoutée au MP3')
        }
      }
      await ff(['-i', file, '-map', '0:a:0', ...audio, ...tags, out('mp3')])
      return { file: out('mp3'), mimetype: 'audio/mpeg' }
    }

    if (format === 'audio') {
      if (!ffmpeg) return { file, mimetype: AUDIO_MIME[ext] || 'audio/mp4' }
      if (!probe.acodec) throw new MediaError('🔇 Aucune piste audio trouvée.')
      if (probe.acodec === 'aac' && !probe.vcodec && /mp4|m4a|mov/.test(container)) return { file, mimetype: 'audio/mp4' }
      if (probe.acodec === 'mp3' && !probe.vcodec) return { file, mimetype: 'audio/mpeg' }
      if (probe.acodec === 'aac') {
        await ff(['-i', file, '-map', '0:a:0', '-vn', '-c:a', 'copy', '-movflags', '+faststart', out('m4a')])
        return { file: out('m4a'), mimetype: 'audio/mp4' }
      }
      // Opus, Vorbis… : converti en AAC (lu partout, y compris sur iPhone)
      await onStage?.('convert')
      await ff(['-i', file, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out('m4a')])
      return { file: out('m4a'), mimetype: 'audio/mp4' }
    }

    // MP4 (fichier) ou vidéo WhatsApp : H.264 + AAC dans un MP4, lisible partout.
    if (!ffmpeg) return { file, mimetype: 'video/mp4' }
    if (!probe.vcodec) throw new MediaError('🎞️ Aucune piste vidéo trouvée.')
    const h264 = probe.vcodec === 'h264'
    const aacOrNone = !probe.acodec || probe.acodec === 'aac'
    if (h264 && aacOrNone && /mp4|mov/.test(container)) return { file, mimetype: 'video/mp4' }
    if (h264) {
      const audio = aacOrNone ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k']
      await ff(['-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', ...audio, '-movflags', '+faststart', out('mp4')])
      return { file: out('mp4'), mimetype: 'video/mp4' }
    }
    await onStage?.('convert')
    const h = Math.max(144, Number(this.opts.videoMaxHeight) || 480)
    await ff([
      '-i', file, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `scale=-2:min(${h}\\,ih)`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out('mp4'),
    ])
    const after = await this.probe(ffmpeg, out('mp4'))
    return { file: out('mp4'), mimetype: 'video/mp4', width: after.width, height: after.height, seconds: after.duration }
  }

  /** Supprime les dossiers temporaires oubliés (redémarrage pendant un téléchargement). */
  async cleanStale(maxAgeMs = 60 * 60_000) {
    const names = await fsp.readdir(JOBS_DIR).catch(() => [])
    for (const name of names) {
      if (!name.startsWith('job-')) continue
      const dir = path.join(JOBS_DIR, name)
      try {
        const st = await fsp.stat(dir)
        if (Date.now() - st.mtimeMs > maxAgeMs) await fsp.rm(dir, { recursive: true, force: true })
      } catch {}
    }
  }
}
