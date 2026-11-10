// Test complet hors ligne de .song / .video avec les VRAIS outils (yt-dlp + ffmpeg).
// Un mini serveur local sert des fichiers audio/vidéo générés par ffmpeg : yt-dlp les télécharge,
// ffmpeg les convertit, puis le bot les « envoie » sur un faux WhatsApp.
// Usage : node test/media-e2e.js   (ignoré si yt-dlp ou ffmpeg est introuvable)
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

import { MediaService, parseProbe } from '../src/media/youtube.js'
import { commandVersion, localYtdlpPath, runProcess } from '../src/media/tools.js'
import { KVStore } from '../src/storage/kv.js'
import { Settings } from '../src/settings.js'
import { Bot } from '../src/bot/handler.js'

const silent = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child: () => silent }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const media = new MediaService({ log: silent })
const ffmpeg = await media.ffmpeg()
const hasYtdlp = (await commandVersion(localYtdlpPath())) || (await commandVersion('yt-dlp'))
if (!ffmpeg || !hasYtdlp) {
  console.log('⏭️  yt-dlp ou ffmpeg introuvable : test ignoré')
  process.exit(0)
}
const ytdlp = await media.ytdlp()
console.log(`yt-dlp ${ytdlp.version} • ${ffmpeg.version || ffmpeg.path}`)

// ── Fichiers de test ──
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-e2e-'))
async function make(name, args) {
  const res = await runProcess(ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-y', ...args, path.join(dir, name)], { timeoutMs: 120_000 })
  assert.equal(res.code, 0, `${name} : ${res.stderr}`)
}
const tone = (s, f = 440) => ['-f', 'lavfi', '-i', `sine=frequency=${f}:duration=${s}`]
const bars = (size, s) => ['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25:duration=${s}`]
await make('song.m4a', [...tone(6), '-c:a', 'aac', '-b:a', '128k'])
await make('song.webm', [...tone(6), '-c:a', 'libopus', '-b:a', '96k'])
await make('clip.mp4', [...bars('640x360', 6), ...tone(6, 660), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart'])
await make('clip.mkv', [...bars('1280x720', 4), ...tone(4, 550), '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libopus', '-shortest'])
await make('cover.png', ['-f', 'lavfi', '-i', 'testsrc=size=480x360', '-frames:v', '1'])

// ── Mini serveur local ──
const TYPES = { '.m4a': 'audio/mp4', '.webm': 'audio/webm', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.png': 'image/png' }
const server = http.createServer(async (req, res) => {
  const name = path.basename(decodeURIComponent(new URL(req.url, 'http://local').pathname))
  try {
    const buf = await fs.readFile(path.join(dir, name))
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream', 'Content-Length': buf.length })
    res.end(req.method === 'HEAD' ? undefined : buf)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port + '/'

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(true)
    console.log(`✅ ${name}`)
  } catch (err) {
    results.push(false)
    console.error(`❌ ${name}\n   ${err?.stack || err}`)
  }
}
const rawProbe = async (file) => (await runProcess(ffmpeg.path, ['-hide_banner', '-i', file], { timeoutMs: 60_000 })).stderr
const probe = async (file) => parseProbe(await rawProbe(file))
const item = (file, extra = {}) => ({
  id: file,
  source: 'generic',
  url: base + file,
  title: 'Bababoy test',
  channel: 'Bababoy - Topic',
  duration: null,
  thumbnail: base + 'cover.png',
  ...extra,
})

await check('lien direct : infos lues par yt-dlp', async () => {
  const found = await media.search(base + 'clip.mp4', 'video')
  assert.ok(found, 'résultat attendu')
  assert.notEqual(found.source, 'youtube')
  assert.ok(found.url.startsWith(base), found.url)
})

await check('miniature : PNG converti en JPEG + petite vignette', async () => {
  const thumb = await media.thumbnail(item('song.m4a'))
  assert.ok(thumb?.image?.[0] === 0xff && thumb.image[1] === 0xd8, 'JPEG attendu')
  assert.ok(thumb.small && thumb.small.length < 48_000, 'vignette attendue')
})

await check('.song → MP3 (fichier) avec pochette et tags', async () => {
  const job = await media.prepare(item('song.m4a'), 'mp3')
  try {
    assert.equal(job.mimetype, 'audio/mpeg')
    assert.equal(job.fileName, 'Bababoy test.mp3')
    const info = await rawProbe(job.file)
    assert.match(info, /Audio: mp3/)
    assert.match(info, /attached pic/, 'pochette attendue')
    assert.match(info, /title\s*:\s*Bababoy test/)
    assert.match(info, /artist\s*:\s*Bababoy\s*$/m)
    assert.ok(job.seconds >= 5 && job.seconds <= 7, String(job.seconds))
  } finally {
    await job.cleanup()
  }
  await assert.rejects(fs.stat(path.dirname(job.file)), 'dossier temporaire supprimé')
})

await check('.song → audio WhatsApp : AAC gardé tel quel', async () => {
  const job = await media.prepare(item('song.m4a'), 'audio')
  try {
    assert.equal(job.mimetype, 'audio/mp4')
    const p = await probe(job.file)
    assert.equal(p.acodec, 'aac')
    assert.equal(p.vcodec, null)
  } finally {
    await job.cleanup()
  }
})

await check('.song → audio WhatsApp depuis de l’Opus (WebM) : converti en AAC', async () => {
  const job = await media.prepare(item('song.webm'), 'audio')
  try {
    assert.equal(job.mimetype, 'audio/mp4')
    assert.match(job.file, /\.m4a$/)
    assert.equal((await probe(job.file)).acodec, 'aac')
  } finally {
    await job.cleanup()
  }
})

await check('.song depuis une vidéo : piste audio extraite', async () => {
  const job = await media.prepare(item('clip.mp4'), 'audio')
  try {
    const p = await probe(job.file)
    assert.equal(p.acodec, 'aac')
    assert.equal(p.vcodec, null, 'pas de vidéo dans un audio')
  } finally {
    await job.cleanup()
  }
})

await check('.video → MP4 (fichier) : H.264/AAC gardé tel quel', async () => {
  const job = await media.prepare(item('clip.mp4'), 'mp4')
  try {
    assert.equal(job.mimetype, 'video/mp4')
    const p = await probe(job.file)
    assert.deepEqual([p.vcodec, p.acodec], ['h264', 'aac'])
    assert.deepEqual([job.width, job.height], [640, 360])
  } finally {
    await job.cleanup()
  }
})

await check('.video → vidéo WhatsApp depuis du MPEG-4/Opus 720p : réencodé en H.264/AAC 480p', async () => {
  const job = await media.prepare(item('clip.mkv'), 'video')
  try {
    assert.match(job.file, /\.mp4$/)
    const p = await probe(job.file)
    assert.deepEqual([p.vcodec, p.acodec, p.height], ['h264', 'aac', 480])
    assert.equal(job.height, 480)
  } finally {
    await job.cleanup()
  }
})

await check('erreurs : lien introuvable → message clair, durée max respectée', async () => {
  await assert.rejects(media.prepare(item('absent.mp4'), 'mp4'), (err) => {
    assert.match(err.message, /indisponible|introuvable/i, err.message)
    return true
  })
  await assert.rejects(media.prepare(item('clip.mp4', { duration: 99_999 }), 'video'), /Trop long/)
})

// ── Bot complet sur un faux WhatsApp ──
class MiniWA extends EventEmitter {
  constructor() {
    super()
    this.me = { id: '33600000000@s.whatsapp.net', lid: '99999999@lid', number: '33600000000', name: 'Alex' }
    this.sent = []
    this.count = 0
    this.botIds = new Set()
  }

  selfJid() {
    return this.me.id
  }

  myIds() {
    return [this.me.id, this.me.lid]
  }

  isBotMessage(id) {
    return this.botIds.has(id)
  }

  async send(jid, content, options = {}) {
    const id = `BOT${++this.count}`
    this.botIds.add(id)
    const file = content?.document?.url || content?.audio?.url || content?.video?.url
    const size = file ? (await fs.stat(file)).size : 0
    const info = file ? await probe(file) : null
    this.sent.push({ jid, text: content?.text ?? content?.caption ?? '', content, options, size, info })
    return { key: { id, remoteJid: jid, fromMe: true } }
  }

  async presence() {}

  async deleteForEveryone() {}

  async groupMetadata(jid) {
    return { id: jid, subject: 'Groupe', participants: [] }
  }

  publicStatus() {
    return { status: 'connected', connected: true, me: null }
  }
}

const fakeAI = {
  client: { configured: true, listModels: async () => [] },
  reply: async () => ({ text: '' }),
  ask: async () => ({ text: '' }),
  test: async () => ({ text: '' }),
}

await check('bot complet : .song <lien> → « 1 » → MP3, puis .video <lien> → « 2 » → vidéo WhatsApp', async () => {
  const kv = await KVStore.create({ dataDir: path.join(dir, 'kv'), log: silent })
  const settings = new Settings(kv)
  const wa = new MiniWA()
  const bot = new Bot({ wa, kv, settings, ai: fakeAI, config: { prefix: '.', botName: 'Nova', ownerName: '' }, log: silent, media })
  const self = wa.me.id
  let seq = 0
  const say = async (text) => {
    const msg = { key: { remoteJid: self, fromMe: true, id: `E2E${++seq}` }, message: { conversation: text }, pushName: 'Alex', messageTimestamp: Math.floor(Date.now() / 1000) }
    await bot.onUpsert({ messages: [msg], type: 'notify' })
    await sleep(50)
  }
  const texts = (list) => JSON.stringify(list.map((s) => s.text))

  await say('.song ' + base + 'song.m4a')
  assert.match(wa.sent.at(-1).text, /MP3 \(fichier\)/, texts(wa.sent))
  assert.equal(bot.getPending(self)?.step, 'song')
  let n = wa.sent.length
  await say('1')
  await bot.commands.mediaIdle()
  const mp3 = wa.sent.slice(n).find((s) => s.content?.document)
  assert.ok(mp3, 'MP3 envoyé : ' + texts(wa.sent.slice(n)))
  assert.equal(mp3.content.mimetype, 'audio/mpeg')
  assert.equal(mp3.info.acodec, 'mp3')
  assert.ok(mp3.size > 10_000, String(mp3.size))
  assert.ok(
    wa.sent.slice(n).some((s) => s.content?.edit && /✅/.test(s.text)),
    texts(wa.sent.slice(n)),
  )

  await say('.video ' + base + 'clip.mp4')
  assert.match(wa.sent.at(-1).text, /Vidéo WhatsApp/, texts(wa.sent))
  assert.equal(bot.getPending(self)?.step, 'video')
  n = wa.sent.length
  await say('2')
  await bot.commands.mediaIdle()
  const video = wa.sent.slice(n).find((s) => s.content?.video)
  assert.ok(video, 'vidéo envoyée : ' + texts(wa.sent.slice(n)))
  assert.equal(video.info.vcodec, 'h264')
  assert.deepEqual([video.content.width, video.content.height], [640, 360])
  assert.ok(video.content.seconds >= 5, String(video.content.seconds))
  await kv.flush?.()
})

server.close()
await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} tests réussis`)
process.exit(failed ? 1 : 0)
