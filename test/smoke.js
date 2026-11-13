// Tests hors ligne : aucune connexion WhatsApp ni appel réseau réel (npm test).
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { EventEmitter } from 'node:events'

import { serialize, deserialize } from '../src/storage/bufferJson.js'
import { encodeSession, decodeSession, hasValidSession, SESSION_PREFIX } from '../src/session.js'
import { KVStore } from '../src/storage/kv.js'
import { Settings, DEFAULT_SETTINGS } from '../src/settings.js'
import { TTLCache } from '../src/utils/ttlCache.js'
import { normalizePhone, jidToNumber, maskNumber } from '../src/utils/phone.js'
import { extractContent, targetsMe, canonicalChat, isGroupJid } from '../src/bot/message.js'
import { Memory } from '../src/bot/memory.js'
import { cleanOutput, NvidiaClient } from '../src/ai/nvidia.js'
import { AIEngine, cleanReply } from '../src/ai/engine.js'
import { Bot } from '../src/bot/handler.js'
import { parseSwitch, formatDuration } from '../src/bot/commands.js'
import { createWebServer } from '../src/web/server.js'
import {
  JobQueue,
  decodeCookies,
  explainError,
  extractUrl,
  formatSeconds,
  normalizeCookies,
  parseDuration,
  parseProbe,
  parseSearchResults,
  parseYouTubeId,
  pickResult,
  safeFileName,
} from '../src/media/youtube.js'
import { WA_INLINE_MAX_BYTES, buildMediaMessage, parseMediaChoice, previewText } from '../src/bot/media.js'
import { extractFiles, cleanFileName, mimeFor } from '../src/ai/files.js'
import { splitReply, buildMessages } from '../src/ai/engine.js'
import { fitImage, INLINE_MAX_B64 } from '../src/media/image.js'
import { findFfmpeg, runProcess } from '../src/media/tools.js'
import { AIError } from '../src/ai/nvidia.js'

const silent = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child: () => silent }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wabot-test-'))
const newKv = (name) => KVStore.create({ dataDir: path.join(tmp, name), log: silent })
const results = []

async function test(name, fn) {
  try {
    await fn()
    results.push(true)
    console.log(`✅ ${name}`)
  } catch (err) {
    results.push(false)
    console.error(`❌ ${name}\n   ${err?.stack || err}`)
  }
}

await test('bufferJson : aller-retour des Buffer', () => {
  const out = deserialize(serialize({ a: Buffer.from('salut'), b: [1, 2] }))
  assert.equal(Buffer.from(out.a).toString(), 'salut')
  assert.deepEqual(out.b, [1, 2])
})

await test('SESSION_ID : encodage, décodage et refus des valeurs invalides', () => {
  const pair = () => ({ private: Buffer.alloc(32, 7), public: Buffer.alloc(32, 9) })
  const creds = {
    noiseKey: pair(),
    signedIdentityKey: pair(),
    signedPreKey: { keyPair: pair(), keyId: 1 },
    registered: true,
    me: { id: '33612345678:4@s.whatsapp.net' },
  }
  const id = encodeSession(creds)
  assert.ok(id.startsWith(SESSION_PREFIX))
  const back = decodeSession(id)
  assert.equal(back.me.id, creds.me.id)
  assert.equal(Buffer.from(back.noiseKey.private).toString('hex'), creds.noiseKey.private.toString('hex'))
  assert.ok(hasValidSession(back))
  assert.equal(hasValidSession({ ...back, registered: false, account: undefined }), false)
  assert.throws(() => decodeSession('WAI~pas-une-session'), /SESSION_ID invalide/)
  assert.throws(() => decodeSession(''), /SESSION_ID vide/)
})

await test('Stockage fichier : écriture puis relecture après redémarrage', async () => {
  const kv = await newKv('kv')
  assert.equal(kv.kind, 'file')
  kv.set('x', { n: 1, buf: Buffer.from('ok') })
  assert.equal(kv.get('x').n, 1)
  assert.equal(kv.get('absent', 'défaut'), 'défaut')
  await kv.flush()
  await kv.close()
  const kv2 = await newKv('kv')
  assert.equal(kv2.get('x').n, 1)
  assert.equal(Buffer.from(kv2.get('x').buf).toString(), 'ok')
  kv2.set('x', null)
  assert.equal(kv2.has('x'), false)
  await kv2.close()
})

await test('Réglages : valeurs par défaut, modification, modes par discussion', async () => {
  const kv = await newKv('settings')
  const s = new Settings(kv)
  assert.equal(s.get('memory'), DEFAULT_SETTINGS().memory)
  assert.equal(s.get('memory'), 500)
  assert.equal(s.get('maxTokens'), 0, 'tokens illimités par défaut')
  s.set('temperature', 1.2)
  assert.equal(s.get('temperature'), 1.2)
  const ids = ['33611111111@s.whatsapp.net', '123456@lid']
  assert.equal(s.isActive('ai', ids), false)
  s.setActive('ai', ids, true)
  assert.ok(s.isActive('ai', ids))
  s.setActive('ai', ids, false)
  assert.equal(s.isActive('ai', ids), false)
  await kv.close()
})

await test('Réglages : les anciennes valeurs par défaut passent aux nouvelles', async () => {
  const kv = await newKv('settings-migrate')
  kv.set('settings', {
    model: 'nvidia/nemotron-3-ultra-550b-a55b',
    maxTokens: 1024,
    memory: 20,
    temperature: 1.1,
  })
  const s = new Settings(kv)
  assert.equal(s.get('model'), DEFAULT_SETTINGS().model)
  assert.equal(s.get('maxTokens'), 0)
  assert.equal(s.get('memory'), 500)
  assert.equal(s.get('temperature'), 1.1, 'les réglages choisis sont conservés')
  await kv.close()
})

await test('Numéros de téléphone', () => {
  assert.equal(normalizePhone('+33 6 12 34 56 78'), '33612345678')
  assert.equal(normalizePhone('0033612345678'), '33612345678')
  assert.throws(() => normalizePhone('0612345678'), /indicatif/)
  assert.equal(jidToNumber('33612345678:3@s.whatsapp.net'), '+33612345678')
  assert.equal(maskNumber('33612345678'), '+336••••••78')
})

await test('Cache avec expiration', async () => {
  const c = new TTLCache({ ttlMs: 30, max: 2 })
  c.set('a', 1)
  c.set('b', 2)
  c.set('c', 3)
  assert.equal(c.has('a'), false)
  assert.equal(c.get('c'), 3)
  await sleep(45)
  assert.equal(c.get('c'), undefined)
})

await test('Analyse des messages', () => {
  const c = extractContent({ conversation: 'Salut !' })
  assert.equal(c.text, 'Salut !')
  assert.ok(!c.ignore)
  const me = '33600000000@s.whatsapp.net'
  const e = extractContent({ extendedTextMessage: { text: 'Coucou @33600000000', contextInfo: { mentionedJid: [me] } } })
  assert.equal(e.text, 'Coucou @33600000000')
  assert.ok(targetsMe(e.contextInfo, e.text, [me], '33600000000'))
  assert.ok(!targetsMe(undefined, 'Bonjour tout le monde', [me], '33600000000'))
  assert.ok(isGroupJid('123-456@g.us'))
  assert.equal(canonicalChat('111@lid', '33611111111@s.whatsapp.net'), '33611111111@s.whatsapp.net')
})

await test('Mémoire : limite et réponse rangée au bon endroit', async () => {
  const kv = await newKv('memory')
  const small = new Memory(kv, () => 3)
  for (const text of ['1', '2', '3', '4']) small.add('a@s.whatsapp.net', { r: 'them', text, name: 'Bob' })
  assert.deepEqual(small.get('a@s.whatsapp.net').map((e) => e.t), ['2', '3', '4'])
  const mem = new Memory(kv, () => 10)
  mem.add('b@s.whatsapp.net', { r: 'them', text: 'question' })
  const question = mem.last('b@s.whatsapp.net')
  await sleep(5)
  mem.add('b@s.whatsapp.net', { r: 'them', text: 'relance' })
  mem.addAfter('b@s.whatsapp.net', { r: 'bot', text: 'réponse' }, question.ts)
  assert.deepEqual(
    mem.get('b@s.whatsapp.net').map((e) => `${e.r}:${e.t}`),
    ['them:question', 'bot:réponse', 'them:relance'],
  )
  await kv.close()
})

await test('Client NVIDIA (réseau simulé)', async () => {
  assert.equal(cleanOutput('<think>je réfléchis</think>\nBonjour').trim(), 'Bonjour')
  let sent
  const fetchImpl = async (url, opts = {}) => {
    sent = { url: String(url), body: JSON.parse(opts.body), auth: new Headers(opts.headers).get('authorization') }
    const data = { model: 'nvidia/test', choices: [{ message: { role: 'assistant', content: 'Salut toi !' }, finish_reason: 'stop' }], usage: { total_tokens: 12 } }
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = new NvidiaClient({ apiKey: 'nvapi-test', baseUrl: 'https://exemple.invalid/v1', log: silent, fetchImpl })
  assert.ok(client.configured)
  const res = await client.chat({ model: 'nvidia/test', messages: [{ role: 'user', content: 'Salut' }] })
  assert.equal(res.text, 'Salut toi !')
  assert.equal(sent.body.model, 'nvidia/test')
  assert.match(sent.url, /\/chat\/completions$/)
  assert.equal(sent.auth, 'Bearer nvapi-test')
})

await test('Moteur IA : prompt système et nettoyage de la réponse', async () => {
  const kv = await newKv('engine')
  const settings = new Settings(kv)
  let seen
  const client = {
    configured: true,
    chat: async (args) => {
      seen = args
      return { text: `${settings.get('botName')}: **Coucou** toi`, model: args.model }
    },
  }
  const engine = new AIEngine({ client, settings, timeZone: 'Europe/Paris' })
  const mem = new Memory(kv)
  mem.add('bob@s.whatsapp.net', { r: 'them', text: 'Salut !', name: 'Bob' })
  const history = mem.get('bob@s.whatsapp.net')
  const res = await engine.reply({ mode: 'ai', history, chat: { isGroup: false, name: 'Bob' }, ownerName: 'Alex' })
  assert.equal(seen.messages[0].role, 'system')
  assert.ok(seen.messages.some((m) => m.role === 'user' && String(m.content).includes('Salut')))
  assert.equal(res.text, '*Coucou* toi')
  assert.equal(cleanReply('[Alex]: ok', ['Alex']), 'ok')
  await kv.close()
})

await test("Moteur IA : mode .aai (l'IA te répond à toi)", async () => {
  const kv = await newKv('engine-aai')
  const settings = new Settings(kv)
  let seen
  const client = {
    configured: true,
    chat: async (args) => {
      seen = args
      return { text: '[Nova] Salut Alex !', model: args.model }
    },
  }
  const engine = new AIEngine({ client, settings, timeZone: 'Europe/Paris' })
  const mem = new Memory(kv)
  const chat = 'bob@s.whatsapp.net'
  mem.add(chat, { r: 'them', text: 'Tu viens ce soir ?', name: 'Bob' })
  mem.add(chat, { r: 'bot', mode: 'meai', text: 'Je te redis ça !' })
  mem.add(chat, { r: 'me', text: 'Salut' })
  assert.equal(mem.get(chat)[1].m, 'meai')
  const res = await engine.reply({ mode: 'aai', history: mem.get(chat), chat: { isGroup: false, name: 'Bob' }, ownerName: 'Alex' })
  assert.equal(res.text, 'Salut Alex !')
  assert.match(seen.messages[0].content, /lui répondre à lui aussi/)
  const users = seen.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')
  assert.ok(users.includes('[Bob] Tu viens ce soir ?'), users)
  assert.ok(users.includes('[Alex] Je te redis ça !'), 'une réponse .meai compte comme un message de toi')
  assert.ok(users.includes('[Alex] Salut'), users)
  assert.equal(seen.messages.at(-1).role, 'user')
  await kv.close()
})

await test('Commandes : interrupteurs et durées', () => {
  assert.equal(parseSwitch('on'), true)
  assert.equal(parseSwitch('off'), false)
  assert.equal(typeof formatDuration(3_725_000), 'string')
})

// ---------- intégration : bot complet avec un faux WhatsApp et une fausse IA ----------

class FakeWA extends EventEmitter {
  constructor() {
    super()
    this.me = { id: '33600000000@s.whatsapp.net', lid: '99999999@lid', number: '33600000000', name: 'Alex' }
    this.connected = true
    this.status = 'connected'
    this.pairing = null
    this.sent = []
    this.deleted = []
    this.reactions = []
    this.botIds = new Set()
    this.count = 0
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
    this.sent.push({ jid, text: content?.text ?? '', content, options })
    return { key: { id, remoteJid: jid, fromMe: true } }
  }

  async react(jid, key, text) {
    this.reactions.push({ jid, key, text })
    return true
  }

  async presence() {}

  async downloadMedia() {
    this.downloads = (this.downloads || 0) + 1
    return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
  }

  async deleteForEveryone(jid, key) {
    this.deleted.push({ jid, key })
  }

  async groupMetadata(jid) {
    return { id: jid, subject: 'Groupe test', participants: [] }
  }

  exportSession() {
    return 'WAI~test'
  }

  hasSession() {
    return this.connected
  }

  publicStatus() {
    return {
      status: this.status,
      connected: this.connected,
      me: this.connected ? { number: this.me.number, name: this.me.name } : null,
      pairing: this.pairing,
      qr: null,
      lastError: null,
      hasSession: this.connected,
      connectedAt: null,
      storage: 'file',
    }
  }
}

const fakeAI = {
  calls: [],
  client: { configured: true, listModels: async () => Array.from({ length: 20 }, (_, i) => `org/modele-${String(i + 1).padStart(2, '0')}`) },
  async reply(args) {
    this.calls.push(args)
    return { text: 'Réponse IA', model: 'org/modele-01' }
  },
  async ask(question) {
    return { text: `Réponse à : ${question}`, ms: 5 }
  },
  async test() {
    return { text: 'Je fonctionne !', ms: 5, model: 'org/modele-01' }
  },
}

let seq = 0
const incoming = (remoteJid, text, { fromMe = false, pushName = 'Bob', participant } = {}) => ({
  key: { remoteJid, fromMe, id: `MSG${++seq}`, ...(participant ? { participant } : {}) },
  message: { conversation: text },
  pushName,
  messageTimestamp: Math.floor(Date.now() / 1000),
})

await test('Bot : commandes du propriétaire, menu et réponses IA', async () => {
  const kv = await newKv('bot')
  const settings = new Settings(kv)
  settings.set('replyDelay', 0)
  const wa = new FakeWA()
  const bot = new Bot({ wa, kv, settings, ai: fakeAI, config: { prefix: '.', botName: 'Nova', ownerName: '' }, log: silent })
  bot.attach()
  const friend = '33611111111@s.whatsapp.net'
  const self = wa.me.id
  const up = async (msg, wait = 40) => {
    await bot.onUpsert({ messages: [msg], type: 'notify' })
    await sleep(wait)
  }
  const sentSince = (n, jid) => wa.sent.slice(n).filter((s) => s.jid === jid)

  // .ai dans la discussion d'un ami (mode discret par défaut)
  await up(incoming(friend, '.ai', { fromMe: true }))
  assert.equal(wa.deleted.length, 1, 'la commande doit être supprimée (mode discret)')
  assert.equal(wa.sent.at(-1).jid, self, 'la confirmation doit arriver dans « Moi »')
  assert.ok(settings.isActive('ai', [friend]))

  // l'ami écrit : l'assistant répond
  let n = wa.sent.length
  await up(incoming(friend, 'Salut, ça va ?'), 200)
  assert.deepEqual(sentSince(n, friend).map((s) => s.text), ['Réponse IA'])
  assert.equal(fakeAI.calls.at(-1).mode, 'ai')

  // un contact ne peut pas utiliser les commandes
  await up(incoming(friend, '.stopall'), 200)
  assert.ok(settings.isActive('ai', [friend]), 'un contact ne doit pas pouvoir couper le bot')

  // .stop coupe l'IA dans la discussion
  await up(incoming(friend, '.stop', { fromMe: true }))
  assert.equal(settings.isActive('ai', [friend]), false)

  // menu dans « Moi » : 1 = IA privée
  await up(incoming(self, '.menu', { fromMe: true }))
  assert.match(wa.sent.at(-1).text, /Tester l'IA/)
  await up(incoming(self, '1', { fromMe: true }))
  assert.ok(settings.isActive('ai', [self]))
  n = wa.sent.length
  await up(incoming(self, 'Raconte-moi une blague', { fromMe: true }), 200)
  assert.ok(sentSince(n, self).some((s) => s.text.startsWith('Réponse IA')), "l'IA privée doit répondre")

  // .meai : refusé dans « Moi », accepté avec l'ami
  await up(incoming(self, '.meai', { fromMe: true }))
  assert.equal(settings.isActive('meai', [self]), false)
  await up(incoming(friend, '.meai', { fromMe: true }))
  assert.ok(settings.isActive('meai', [friend]))

  // .meai répond à ta place après un temps de frappe réaliste
  n = wa.sent.length
  await up(incoming(friend, 'Tu fais quoi ce soir ?'), 1300)
  assert.deepEqual(sentSince(n, friend).map((s) => s.text), ['Réponse IA'])
  assert.equal(fakeAI.calls.at(-1).mode, 'meai')

  // si tu réponds toi-même avant le délai, l'IA se tait
  settings.set('replyDelay', 1)
  n = wa.sent.length
  await up(incoming(friend, 'On se voit demain ?'))
  await up(incoming(friend, 'Oui carrément !', { fromMe: true }), 1500)
  assert.equal(sentSince(n, friend).length, 0)

  // liste des modèles paginée (15 par page)
  await up(incoming(self, '.models', { fromMe: true }))
  const page = wa.sent.at(-1).text
  assert.match(page, /page 1\/2/)
  assert.ok(page.includes('org/modele-15') && !page.includes('org/modele-16'))

  await kv.close()
})

await test("Bot : .aai (l'IA te répond aussi) et .help sans menu", async () => {
  const kv = await newKv('bot-aai')
  const settings = new Settings(kv)
  settings.set('replyDelay', 0)
  const wa = new FakeWA()
  const bot = new Bot({ wa, kv, settings, ai: fakeAI, config: { prefix: '.', botName: 'Nova', ownerName: '' }, log: silent })
  const friend = '33622222222@s.whatsapp.net'
  const group = '120363000000000001@g.us'
  const self = wa.me.id
  const up = async (msg, wait = 40) => {
    await bot.onUpsert({ messages: [msg], type: 'notify' })
    await sleep(wait)
  }
  const sentSince = (n, jid) => wa.sent.slice(n).filter((s) => s.jid === jid)

  // .help : la liste des commandes avec leurs explications, sans menu
  await up(incoming(self, '.help', { fromMe: true }))
  const help = wa.sent.at(-1).text
  assert.ok(help.includes('.aai') && help.includes('.meai'), help)
  assert.doesNotMatch(help, /Réponds avec un numéro/)
  assert.equal(bot.getPending(self), null, '.help ne doit pas ouvrir le menu')

  // .aai refusé tant que .ai ou .meai n'est pas actif
  await up(incoming(friend, '.aai', { fromMe: true }))
  assert.equal(settings.isActive('aai', [friend]), false)
  assert.match(wa.sent.at(-1).text, /Active d'abord/)

  // .ai seul : tes propres messages ne déclenchent pas l'IA
  await up(incoming(friend, '.ai', { fromMe: true }))
  let n = wa.sent.length
  await up(incoming(friend, 'Salut !', { fromMe: true }), 150)
  assert.equal(sentSince(n, friend).length, 0)

  // .ai + .aai : l'IA te répond dans la même discussion, en citant ton message
  await up(incoming(friend, '.aai', { fromMe: true }))
  assert.ok(settings.isActive('aai', [friend]))
  n = wa.sent.length
  const mine = incoming(friend, 'Salut !', { fromMe: true })
  await up(mine, 150)
  const replies = sentSince(n, friend)
  assert.deepEqual(replies.map((s) => s.text), ['Réponse IA'])
  assert.equal(replies[0].options.quoted?.key?.id, mine.key.id)
  assert.equal(fakeAI.calls.at(-1).mode, 'aai')

  // la réponse envoyée par le bot ne relance pas l'IA (pas de boucle)
  n = wa.sent.length
  const echo = incoming(friend, 'Réponse IA', { fromMe: true })
  echo.key.id = [...wa.botIds].at(-1)
  await up(echo, 150)
  assert.equal(sentSince(n, friend).length, 0)

  // ton ami écrit : l'assistant lui répond toujours
  n = wa.sent.length
  await up(incoming(friend, 'Et toi ?'), 150)
  assert.equal(sentSince(n, friend).length, 1)
  assert.equal(fakeAI.calls.at(-1).mode, 'ai')

  // .stop coupe aussi .aai
  await up(incoming(friend, '.stop', { fromMe: true }))
  assert.equal(settings.isActive('aai', [friend]), false)

  // pareil dans un groupe, avec .meai
  await up(incoming(group, '.meai', { fromMe: true }))
  await up(incoming(group, '.aai', { fromMe: true }))
  assert.ok(settings.isActive('aai', [group]))
  n = wa.sent.length
  await up(incoming(group, 'Coucou le groupe', { fromMe: true }), 150)
  assert.deepEqual(sentSince(n, group).map((s) => s.text), ['Réponse IA'])
  assert.equal(fakeAI.calls.at(-1).mode, 'aai')

  // inutile dans « Moi »
  await up(incoming(self, '.aai', { fromMe: true }))
  assert.equal(settings.isActive('aai', [self]), false)

  await kv.close()
})

// ---------- fichiers, images et tokens illimités ----------

await test("Fichiers de l'IA : extraction, noms sûrs, blocs coupés", () => {
  const raw = 'Voici ta page :\n```html\n<file name="../site/index.html">\n```html\n<h1>**Salut**</h1>\n# titre\n```\n</file>\n```\nEt les notes <fichier nom="notes">\nligne 1'
  const { text, files } = extractFiles(raw)
  assert.equal(text, 'Voici ta page :\n\nEt les notes')
  assert.equal(files.length, 2)
  assert.equal(files[0].name, 'index.html')
  assert.equal(files[0].mimetype, 'text/html')
  assert.equal(files[0].content.toString(), '<h1>**Salut**</h1>\n# titre', 'le contenu du fichier reste intact')
  assert.equal(files[0].truncated, false)
  assert.equal(files[1].name, 'notes.txt')
  assert.equal(files[1].content.toString(), 'ligne 1')
  assert.equal(files[1].truncated, true, 'bloc non refermé = fichier peut-être incomplet')
  assert.deepEqual(extractFiles('Pas de fichier ici').files, [])
  assert.equal(cleanFileName('a:b?.CSV'), 'ab.CSV')
  assert.equal(mimeFor('data.csv'), 'text/csv')
  assert.equal(mimeFor('inconnu.xyz'), 'text/plain')
})

await test('Longues réponses : découpées en plusieurs messages, sans rien perdre', () => {
  const para = 'mot '.repeat(400).trim()
  const long = Array.from({ length: 6 }, () => para).join('\n\n')
  const parts = splitReply(long)
  assert.ok(parts.length > 1)
  assert.ok(parts.every((p) => p.length <= 4000))
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '))
  assert.deepEqual(splitReply('court'), ['court'])
  assert.deepEqual(splitReply(''), [])
})

await test('Client NVIDIA : tokens illimités = pas de max_tokens envoyé', async () => {
  const bodies = []
  const fetchImpl = async (url, opts = {}) => {
    bodies.push(JSON.parse(opts.body))
    const data = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const client = new NvidiaClient({ apiKey: 'nvapi-test', baseUrl: 'https://exemple.invalid/v1', log: silent, fetchImpl })
  await client.chat({ model: 'org/m', messages: [{ role: 'user', content: 'a' }], maxTokens: 512 })
  await client.chat({ model: 'org/m', messages: [{ role: 'user', content: 'a' }], maxTokens: 0 })
  assert.equal(bodies[0].max_tokens, 512)
  assert.equal('max_tokens' in bodies[1], false)
})

await test('Moteur IA : fichiers dans la réponse et description des images', async () => {
  const kv = await newKv('engine-files')
  const settings = new Settings(kv)
  const calls = []
  let answer = '<file name="page.html">\n<b>**gras**</b>\n</file>\nVoilà **ta** page'
  const client = {
    configured: true,
    chat: async (args) => {
      calls.push(args)
      if (args.model === settings.get('visionModel')) throw new AIError('Modèle introuvable', { status: 404 })
      return { text: answer, model: args.model }
    },
  }
  const engine = new AIEngine({ client, settings, timeZone: 'Europe/Paris' })
  const history = [{ r: 'them', t: 'Fais-moi une page', ts: 1, n: 'Bob' }]
  const res = await engine.reply({ mode: 'ai', history, chat: { isGroup: false, name: 'Bob' }, ownerName: 'Alex' })
  assert.equal(res.text, 'Voilà *ta* page')
  assert.equal(res.files[0].content.toString(), '<b>**gras**</b>')
  assert.match(calls[0].messages[0].content, /<file name=/)
  await engine.reply({ mode: 'meai', history, chat: { isGroup: false, name: 'Bob' }, ownerName: 'Alex' })
  assert.doesNotMatch(calls[1].messages[0].content, /<file name=/, 'pas de fichiers envoyés à ta place')
  assert.match(calls[1].messages[0].content, /\[image : description\]/)

  answer = 'Un chat roux sur un canapé.'
  const seen = await engine.describeImage({ image: Buffer.from('img'), mimetype: 'image/png', caption: "C'est quoi ?" })
  assert.equal(seen.text, 'Un chat roux sur un canapé.')
  const [first, second] = calls.slice(2)
  assert.equal(first.model, settings.get('visionModel'))
  assert.equal(second.model, 'meta/llama-3.2-90b-vision-instruct', 'modèle de secours si le premier est introuvable')
  const parts = second.messages[0].content
  assert.match(parts[0].text, /C'est quoi \?/)
  assert.equal(parts[1].image_url.url, `data:image/png;base64,${Buffer.from('img').toString('base64')}`)
  await kv.close()
})

await test('Images : réduites sous la limite NVIDIA (ffmpeg)', async () => {
  const small = Buffer.from([0xff, 0xd8, 1, 2])
  assert.equal((await fitImage(small, 'image/jpeg')).image, small)
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) return console.log('   (ffmpeg absent : réduction non testée)')
  const big = await runProcess(
    ffmpeg.path,
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=2400x1800,geq=random(1)*255:128:128', '-frames:v', '1', '-q:v', '2', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
    { timeoutMs: 60_000 },
  )
  assert.ok(big.stdoutBuffer.length * 4 / 3 > INLINE_MAX_B64, 'image de test assez lourde')
  const out = await fitImage(big.stdoutBuffer, 'image/jpeg', ffmpeg)
  assert.equal(out.mimetype, 'image/jpeg')
  assert.ok(out.image.length < big.stdoutBuffer.length)
  assert.ok(Math.ceil(out.image.length / 3) * 4 <= INLINE_MAX_B64, `${out.image.length} octets`)
})

await test("Bot : l'IA voit les images, envoie des fichiers, tokens illimités", async () => {
  const kv = await newKv('bot-vision')
  const settings = new Settings(kv)
  settings.set('replyDelay', 0)
  const wa = new FakeWA()
  const file = { name: 'page.html', mimetype: 'text/html', content: Buffer.from('<h1>Salut</h1>'), truncated: false }
  const ai = {
    calls: [],
    looked: [],
    client: fakeAI.client,
    async describeImage(args) {
      this.looked.push(args)
      return { text: 'Un chat roux dort sur un canapé bleu.' }
    },
    async reply(args) {
      this.calls.push(args)
      return { text: 'Voici ta page !', files: [file] }
    },
    async ask() {
      return { text: '', files: [file] }
    },
    async test() {
      return { text: 'ok', ms: 1 }
    },
  }
  const bot = new Bot({ wa, kv, settings, ai, config: { prefix: '.', botName: 'Nova', ownerName: '' }, log: silent })
  const friend = '33633333333@s.whatsapp.net'
  const self = wa.me.id
  const up = async (msg, wait = 60) => {
    await bot.onUpsert({ messages: [msg], type: 'notify' })
    await sleep(wait)
  }
  const photo = (remoteJid, caption = '', { fromMe = false } = {}) => ({
    key: { remoteJid, fromMe, id: `IMG${++seq}` },
    message: { imageMessage: { mimetype: 'image/jpeg', url: 'https://exemple.invalid/img', ...(caption ? { caption } : {}) } },
    pushName: 'Bob',
    messageTimestamp: Math.floor(Date.now() / 1000),
  })
  await up(incoming(friend, '.ai', { fromMe: true }))

  // une photo sans légende : l'IA la regarde puis répond
  let n = wa.sent.length
  await up(photo(friend), 200)
  assert.equal(ai.looked.length, 1)
  assert.equal(ai.looked[0].mimetype, 'image/jpeg')
  assert.ok(ai.calls.at(-1).history.some((e) => e.t === '[image : Un chat roux dort sur un canapé bleu.]'))
  const out = wa.sent.slice(n).filter((s) => s.jid === friend)
  assert.deepEqual(wa.reactions.map((r) => r.text), ['⚙️', ''], 'engrenage pendant la réponse, retiré ensuite')
  assert.equal(out[0].text, 'Voici ta page !')
  assert.equal(out[1].content.fileName, 'page.html')
  assert.equal(out[1].content.mimetype, 'text/html')
  assert.equal(out[1].content.document.toString(), '<h1>Salut</h1>')
  const mem = bot.memory.get(friend)
  assert.ok(!mem.some((e) => e.i), "l'image n'est regardée qu'une fois")
  assert.deepEqual(mem.at(-1).f, [{ n: 'page.html', c: '<h1>Salut</h1>' }], "le contenu du fichier est gardé pour l'IA")

  // message suivant : pas de nouveau téléchargement
  await up(incoming(friend, 'Tu peux la modifier ?'), 200)
  assert.equal(wa.downloads, 1)

  // dans « Moi », une photo avec légende déclenche ton IA privée
  await up(incoming(self, '.ai', { fromMe: true }))
  n = ai.calls.length
  await up(photo(self, 'Tu vois quoi ?', { fromMe: true }), 200)
  assert.equal(ai.calls.length, n + 1)
  assert.equal(ai.looked.at(-1).caption, 'Tu vois quoi ?')

  // .vision off : l'image reste « [image] », pas de réponse à une photo seule
  await up(incoming(self, '.vision off', { fromMe: true }))
  assert.equal(settings.get('vision'), false)
  n = ai.calls.length
  await up(photo(friend), 200)
  assert.equal(ai.calls.length, n)
  assert.equal(wa.downloads, 2)

  // .ask : un fichier seul est bien envoyé
  n = wa.sent.length
  await up(incoming(friend, '.ask fais un fichier', { fromMe: true }))
  assert.ok(wa.sent.slice(n).some((s) => s.content?.fileName === 'page.html'))

  // .tokens illimite / 0 / nombre / valeur invalide, et le menu
  await up(incoming(self, '.tokens illimité', { fromMe: true }))
  assert.equal(settings.get('maxTokens'), 0)
  assert.match(wa.sent.at(-1).text, /illimitée/)
  await up(incoming(self, '.tokens 2048', { fromMe: true }))
  assert.equal(settings.get('maxTokens'), 2048)
  await up(incoming(self, '.tokens 10', { fromMe: true }))
  assert.equal(settings.get('maxTokens'), 2048)
  await up(incoming(self, '.menu', { fromMe: true }))
  await up(incoming(self, '15', { fromMe: true }))
  await up(incoming(self, '0', { fromMe: true }))
  assert.equal(settings.get('maxTokens'), 0, 'dans le menu, 0 = illimité')
  await up(incoming(self, '.reglages', { fromMe: true }))
  assert.match(wa.sent.at(-1).text, /Longueur max : illimitée/)
  await kv.close()
})

await test("Fichiers : chaque demande envoie un vrai fichier (l'IA ne recopie plus « fichier envoyé »)", async () => {
  const kv = await newKv('bot-files-again')
  const settings = new Settings(kv)
  settings.set('replyDelay', 0)
  const wa = new FakeWA()
  // Comme le vrai modèle : il imite sa réponse précédente, sinon il écrit le fichier
  let version = 0
  const client = {
    configured: true,
    listModels: async () => [],
    chat: async ({ messages }) => {
      const prev = messages.filter((m) => m.role === 'assistant').at(-1)
      version++
      return { text: prev ? prev.content.replace(/version \d+/, `version ${version}`) : 'Voilà !\n<file name="notes.txt">\nversion 1\n</file>' }
    },
  }
  const ai = new AIEngine({ client, settings, timeZone: 'Europe/Paris' })
  const bot = new Bot({ wa, kv, settings, ai, config: { prefix: '.', botName: 'Nova', ownerName: '' }, log: silent })
  const friend = '33644444444@s.whatsapp.net'
  const up = async (msg, wait = 80) => {
    await bot.onUpsert({ messages: [msg], type: 'notify' })
    await sleep(wait)
  }
  await up(incoming(friend, '.ai', { fromMe: true }))
  await up(incoming(friend, 'Envoie-moi un txt'))
  await up(incoming(friend, 'Un autre stp'))
  await up(incoming(friend, 'Et encore un'))
  const docs = wa.sent.filter((s) => s.jid === friend && s.content?.document)
  assert.deepEqual(
    docs.map((d) => d.content.document.toString()),
    ['version 1', 'version 2', 'version 3'],
  )
  assert.ok(!wa.sent.some((s) => s.text.includes('📎')))
  await kv.close()
})

await test('Fichiers : fichier annoncé mais pas écrit → nouvelle tentative, sinon mention retirée', async () => {
  const kv = await newKv('engine-fake-file')
  const settings = new Settings(kv)
  let calls = []
  let answers = []
  const client = {
    configured: true,
    chat: async ({ messages }) => {
      calls.push(messages)
      return { text: answers[Math.min(calls.length, answers.length) - 1] }
    },
  }
  const engine = new AIEngine({ client, settings, timeZone: 'Europe/Paris' })
  const ask = async (list) => {
    calls = []
    answers = list
    return engine.ask('fais-moi un txt')
  }

  let r = await ask(['Voilà ! [📎 fichier envoyé : a.txt]', 'Voilà !\n<file name="a.txt">\nok\n</file>'])
  assert.equal(r.files[0].name, 'a.txt')
  assert.equal(r.text, 'Voilà !')
  assert.equal(calls[1].at(-2).role, 'assistant')
  assert.match(calls[1].at(-1).content, /aucune balise <file>/)

  r = await ask(['Voilà ! [📎 fichier envoyé : a.txt]'])
  assert.equal(calls.length, 2, 'une seule nouvelle tentative')
  assert.deepEqual([r.text, r.files.length], ['Voilà !', 0], 'la fausse mention est retirée')
  r = await ask(['[📎 fichier envoyé : a.txt]'])
  assert.match(r.text, /pas réussi à créer le fichier/)

  r = await ask(['Je ne peux pas, désolé.'])
  assert.equal(calls.length, 1, 'réponse normale : pas de 2e appel')
  r = await ask(["C'est fait, je t'ai envoyé le fichier !", 'Le voici :\n<file name="b.txt">\nok\n</file>'])
  assert.equal(r.files[0].name, 'b.txt')

  // nom sans guillemets accepté ; vieilles mentions retirées de l'historique
  assert.equal(extractFiles('<file name=c.csv>\na;b\n</file>').files[0].name, 'c.csv')
  const msgs = buildMessages({
    mode: 'ai',
    settings: settings.all(),
    history: [
      { r: 'them', t: 'un txt stp', ts: 1 },
      { r: 'bot', m: 'ai', t: 'Voilà !\n[📎 fichier envoyé : a.txt]', ts: 2 },
      { r: 'bot', m: 'ai', t: '', f: [{ n: 'b.txt', c: 'contenu' }], ts: 3 },
      { r: 'them', t: 'encore', ts: 4 },
    ],
    chat: { isGroup: false, name: 'Bob' },
    timeZone: 'Europe/Paris',
  })
  const assistant = msgs.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n')
  assert.ok(!assistant.includes('📎'), assistant)
  assert.equal(assistant, 'Voilà !\n<file name="b.txt">\ncontenu\n</file>')
  await kv.close()
})

await test('Bot : .help par thème, .help <commande>, menu détaillé qui reste ouvert', async () => {
  const kv = await newKv('bot-help')
  const settings = new Settings(kv)
  const wa = new FakeWA()
  const bot = new Bot({ wa, kv, settings, ai: fakeAI, config: { prefix: '.', botName: 'Nova', ownerName: '' }, log: silent })
  const self = wa.me.id
  const up = async (text, wait = 30) => {
    await bot.onUpsert({ messages: [incoming(self, text, { fromMe: true })], type: 'notify' })
    await sleep(wait)
  }
  const last = () => wa.sent.at(-1).text
  const { HELP, COMMANDS } = bot.commands

  // chaque entrée de l'aide est une vraie commande, et chaque commande a son aide
  for (const h of HELP) assert.ok(Object.hasOwn(COMMANDS, h.cmd), h.cmd)
  const documented = new Set(HELP.map((h) => COMMANDS[h.cmd]))
  for (const [name, fn] of Object.entries(COMMANDS)) assert.ok(documented.has(fn), `.${name} n'a pas d'aide`)

  await up('.help')
  let txt = last()
  assert.match(txt, /\*🧠 Modèle & capacités\*/)
  assert.match(txt, /\*\.tokens\* <64-8192 ou illimite> — longueur max des réponses/)
  assert.match(txt, /help <commande>/)
  assert.ok(txt.length <= 4000, `aide en un seul message (${txt.length} caractères)`)
  await up('.help .tokens')
  assert.match(last(), /📖 \*\.tokens\*/)
  assert.match(last(), /\*Exemples\*\n- \.tokens 2048\n- \.tokens illimite/)
  await up('.help .memoire')
  assert.match(last(), /📖 \*\.memoire\* <2-500>/)
  await up('.help ia')
  assert.match(last(), /📖 \*\.ai\* \[on\/off\]/)
  assert.match(last(), /Autres noms : \.ia/)
  await up('.help musique')
  assert.match(last(), /📖 \*\.song\*/)
  await up('.help tok')
  assert.match(last(), /Tu cherches peut-être \*\.tokens\*/)

  // menu : sections, valeurs actuelles, et il reste ouvert entre deux choix
  await up('.menu')
  txt = last()
  assert.match(txt, /\*🧠 Intelligence\*/)
  assert.match(txt, /Longueur max — _illimitée ♾️_/)
  assert.match(txt, /Vision des images — ✅/)
  assert.match(txt, /Me répondre aussi — ⛔/)
  const num = (label) => String(txt.match(new RegExp(`\\*(\\d+)\\.\\* \\S+ ${label}`))[1])
  await up(num('Mode réflexion'))
  assert.equal(settings.get('reasoning'), true)
  await up(num('Mode réflexion'))
  assert.equal(settings.get('reasoning'), false, 'le menu est resté ouvert')
  await up(num('Délai avant réponse'))
  await up('7')
  assert.equal(settings.get('replyDelay'), 7)
  await up(num('Vision des images'))
  await up('2')
  assert.equal(settings.get('vision'), false)
  await up(num('Personnalité'))
  await up('0')
  assert.match(last(), /Annulé. Le menu est toujours ouvert/)
  await up('menu')
  assert.match(last(), /Vision des images — ⛔/)
  assert.match(last(), /Délai avant réponse — _7 s_/)
  await up('0')
  assert.match(last(), /Menu fermé/)
  const n = wa.sent.length
  await up('12')
  assert.equal(wa.sent.length, n, 'menu fermé : « 12 » est un message normal')
  await kv.close()
})

// ---------- site d'appairage ----------

await test("Site : statut, mot de passe et appairage par code", async () => {
  const wa = new FakeWA()
  wa.connected = false
  wa.status = 'idle'
  wa.requestPairing = async (phone) => {
    const number = normalizePhone(phone)
    wa.status = 'waiting_pair'
    wa.pairing = { code: 'ABCD-EFGH', phone: number, expiresAt: Date.now() + 180_000 }
    return 'ABCD-EFGH'
  }
  const server = createWebServer({ wa, config: { adminPassword: 'secret', botName: 'Nova', port: 0 }, log: silent, settings: null })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { status: res.status, json, text }
  }
  try {
    assert.equal((await call('/health')).status, 200)
    const st = await call('/api/status')
    assert.equal(st.json.needsPassword, true)
    assert.equal(st.json.connected, false)
    assert.equal((await call('/api/pair', { method: 'POST', body: { phone: '33612345678' } })).status, 401)
    assert.equal((await call('/api/login', { method: 'POST', body: { password: 'faux' } })).status, 401)
    assert.equal((await call('/api/login', { method: 'POST', body: { password: 'secret' } })).status, 200)
    const pair = await call('/api/pair', {
      method: 'POST',
      body: { phone: '+33 6 12 34 56 78' },
      headers: { 'x-admin-password': encodeURIComponent('secret') },
    })
    assert.equal(pair.status, 200, pair.text)
    assert.equal(pair.json.code, 'ABCD-EFGH')
    assert.ok(pair.json.token)
    const withToken = await call('/api/status', { headers: { 'x-pair-token': pair.json.token } })
    assert.equal(withToken.json.pairing?.code, 'ABCD-EFGH')
    const withoutToken = await call('/api/status')
    assert.ok(!withoutToken.json.pairing, 'le code ne doit pas être visible sans jeton')
    const home = await call('/')
    assert.equal(home.status, 200)
    assert.match(home.text, /<html/i)
  } finally {
    server.closeAllConnections?.()
    server.close()
  }
})

await test('Site : catalogue des commandes, fichiers statiques et infos du tableau de bord', async () => {
  const kv = await newKv('site-assets')
  const settings = new Settings(kv)
  const wa = new FakeWA()
  const bot = new Bot({ wa, kv, settings, ai: fakeAI, config: { prefix: '.', botName: 'Nova', ownerName: '' }, log: silent })
  const config = { adminPassword: '', botName: 'Nova', port: 0, prefix: '!', nvidiaApiKey: 'nvapi-test', nvidiaModel: 'org/modele' }
  const server = createWebServer({ wa, config, log: silent, settings, commands: bot.commands })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const cat = await (await fetch(base + '/api/commands')).json()
    assert.equal(cat.prefix, '!')
    assert.equal(cat.commands.length, bot.commands.HELP.length)
    assert.deepEqual(cat.categories.map((c) => c.id), bot.commands.HELP_CATS.map(([id]) => id))
    const help = cat.commands.find((c) => c.cmd === 'help')
    assert.ok(help.aliases.includes('aide'), 'les autres noms sont listés')
    assert.ok(cat.commands.every((c) => c.short && bot.commands.HELP_CATS.some(([id]) => id === c.cat)))

    const st = await (await fetch(base + '/api/status')).json()
    assert.equal(st.aiConfigured, true)
    assert.equal(typeof st.uptime, 'number')
    assert.ok(st.model)

    for (const [file, type] of [['style.css', /text\/css/], ['app.js', /javascript/], ['scene.js', /javascript/], ['favicon.svg', /svg/]]) {
      const res = await fetch(`${base}/assets/${file}`)
      assert.equal(res.status, 200, file)
      assert.match(res.headers.get('content-type'), type, file)
      assert.ok((await res.text()).length > 50, file)
    }
    for (const bad of ['/assets/..%2Fserver.js', '/assets/%2e%2e%2fserver.js', '/assets/nope.js', '/assets/index.html', '/assets/']) {
      assert.equal((await fetch(base + bad)).status, 404, bad)
    }
    const html = await (await fetch(base + '/')).text()
    for (const ref of html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)/g)) {
      assert.equal((await fetch(base + ref[1])).status, 200, `${ref[1]} référencé par la page`)
    }
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'identifiants uniques dans la page')
  } finally {
    server.closeAllConnections?.()
    server.close()
    await kv.close()
  }
})

// ───────────── .song / .video ─────────────

await test('Musique/vidéo : liens YouTube, durées, noms de fichiers', () => {
  const id = 'dQw4w9WgXcQ'
  const links = [
    'https://www.youtube.com/watch?v=' + id + '&t=42',
    'https://youtu.be/' + id + '?si=abc',
    'https://m.youtube.com/shorts/' + id,
    'https://music.youtube.com/watch?v=' + id + '&list=RD',
    'https://www.youtube.com/embed/' + id,
    'https://www.youtube.com/live/' + id,
  ]
  for (const link of links) assert.equal(parseYouTubeId(link), id, link)
  assert.equal(parseYouTubeId('https://example.com/watch?v=' + id), null)
  assert.equal(parseYouTubeId('bababoy'), null)
  assert.equal(extractUrl('écoute ça : https://youtu.be/' + id + ').'), 'https://youtu.be/' + id)
  assert.equal(extractUrl('bababoy'), null)
  assert.equal(parseDuration('3:45'), 225)
  assert.equal(parseDuration('1:02:03'), 3723)
  assert.equal(parseDuration('EN DIRECT'), null)
  assert.equal(formatSeconds(225), '3:45')
  assert.equal(formatSeconds(3723), '1:02:03')
  assert.equal(safeFileName('AC/DC: Back <In> Black?'), 'AC DC Back In Black')
  assert.equal(safeFileName('   '), 'media')
})

await test('Musique/vidéo : résultats YouTube lus correctement (pubs et directs ignorés)', () => {
  const video = (videoId, title, extra = {}) => ({ videoRenderer: { videoId, title: { runs: [{ text: title }] }, ...extra } })
  const lockup = {
    lockupViewModel: {
      contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
      contentId: 'lmnopqrstuv',
      metadata: {
        lockupMetadataViewModel: {
          title: { content: 'Bababoy (Live session)' },
          metadata: {
            contentMetadataViewModel: {
              metadataRows: [
                { metadataParts: [{ text: { content: 'Bababoy' } }] },
                { metadataParts: [{ text: { content: '50 k vues' } }, { text: { content: 'il y a 2 ans' } }] },
              ],
            },
          },
        },
      },
      contentImage: {
        thumbnailViewModel: {
          overlays: [
            { thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: '4:05', badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT' } }] } },
          ],
        },
      },
    },
  }
  const data = {
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    { adSlotRenderer: { content: video('AAAAAAAAAAA', 'Publicité') } },
                    video('LIVELIVE001', 'Bababoy en direct', { badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }] }),
                    video('abcdefghijk', 'Bababoy (Clip officiel)', {
                      ownerText: { runs: [{ text: 'Bababoy - Topic' }] },
                      lengthText: { simpleText: '3:45' },
                      shortViewCountText: { simpleText: '1,2 M de vues' },
                    }),
                    lockup,
                  ],
                },
              },
            ],
          },
        },
      },
    },
  }
  const results = parseSearchResults(data)
  assert.deepEqual(
    results.map((r) => r.id),
    ['LIVELIVE001', 'abcdefghijk', 'lmnopqrstuv'],
  )
  assert.equal(results[0].live, true)
  const [, song, other] = results
  assert.equal(song.title, 'Bababoy (Clip officiel)')
  assert.equal(song.channel, 'Bababoy')
  assert.equal(song.duration, 225)
  assert.equal(song.views, '1,2 M de vues')
  assert.equal(song.url, 'https://www.youtube.com/watch?v=abcdefghijk')
  assert.equal(other.title, 'Bababoy (Live session)')
  assert.equal(other.duration, 245)
  assert.equal(other.views, '50 k vues')
  assert.equal(other.live, false)
  assert.equal(pickResult(results, 1800).id, 'abcdefghijk', 'le direct est ignoré')
  assert.equal(pickResult([{ ...song, duration: 4000 }, other], 1800).id, 'lmnopqrstuv', 'trop long : résultat suivant')
})

await test("Musique/vidéo : cookies, analyse ffmpeg et messages d'erreur", () => {
  const line = '.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc'
  const raw = `# Netscape HTTP Cookie File\n${line}\n`
  assert.equal(decodeCookies(raw), raw)
  assert.equal(decodeCookies(Buffer.from(raw).toString('base64')), raw, 'base64 accepté')
  assert.equal(decodeCookies(raw.replace(/\n/g, '\\n')), raw, '\\n littéraux acceptés')
  assert.equal(decodeCookies('n importe quoi'), null)
  assert.equal(normalizeCookies('.youtube.com TRUE / TRUE 1999999999 SID abc'), raw, 'espaces → tabulations + en-tête')
  const probe = parseProbe(
    [
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'media.mp4':",
      '  Duration: 00:03:45.52, start: 0.000000, bitrate: 1200 kb/s',
      '  Stream #0:0[0x1](und): Video: h264 (Main) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 854x480 [SAR 1:1 DAR 427:240], 1000 kb/s, 25 fps',
      '  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)',
    ].join('\n'),
  )
  assert.deepEqual(probe, { duration: 226, container: 'mov,mp4,m4a,3gp,3g2,mj2', vcodec: 'h264', acodec: 'aac', width: 854, height: 480 })
  const cover = parseProbe('  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz\n  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 480x360, 90k tbr (attached pic)')
  assert.equal(cover.acodec, 'mp3')
  assert.equal(cover.vcodec, null, "la pochette n'est pas une vidéo")
  assert.match(explainError("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies"), /YT_COOKIES/)
  assert.match(explainError('ERROR: [youtube] abc: Sign in to confirm your age'), /âge/)
  assert.match(explainError('ERROR: [youtube] abc: Video unavailable. This video has been removed'), /indisponible/)
  assert.match(explainError("ERROR: [youtube] abc: Private video. Sign in if you've been granted access"), /privée/)
  assert.match(explainError('ERROR: [generic] Requested format is not available'), /format/)
})

await test('Musique/vidéo : choix 1/2, légende de la miniature et message WhatsApp', () => {
  assert.equal(parseMediaChoice('audio', '1'), 'mp3')
  assert.equal(parseMediaChoice('audio', ' 2 '), 'audio')
  assert.equal(parseMediaChoice('audio', 'MP3'), 'mp3')
  assert.equal(parseMediaChoice('audio', 'audio whatsapp'), 'audio')
  assert.equal(parseMediaChoice('video', '1'), 'mp4')
  assert.equal(parseMediaChoice('video', '2.'), 'video')
  assert.equal(parseMediaChoice('video', 'Vidéo'), 'video')
  assert.equal(parseMediaChoice('video', '3'), null)
  assert.equal(parseMediaChoice('audio', 'salut'), null)
  const item = { id: 'abcdefghijk', source: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Bababoy', channel: 'Bababoy', duration: 225, views: '1 M de vues' }
  const audioCaption = previewText(item, 'audio')
  assert.match(audioCaption, /🎵 \*Bababoy\*/)
  assert.match(audioCaption, /⏱️ 3:45/)
  assert.match(audioCaption, /youtu\.be\/abcdefghijk/)
  assert.match(audioCaption, /\*1\.\* 🎧 MP3 \(fichier\)\n\*2\.\* 🔊 Audio WhatsApp/)
  assert.match(previewText(item, 'video'), /\*1\.\* 📁 MP4 \(fichier\)\n\*2\.\* ▶️ Vidéo WhatsApp/)
  const job = { file: '/tmp/x', fileName: 'Bababoy.mp3', mimetype: 'audio/mpeg', size: 1000, seconds: 225, width: 854, height: 480, title: 'Bababoy', thumb: null }
  const mp3 = buildMediaMessage({ ...job, format: 'mp3' }).content
  assert.deepEqual([mp3.document.url, mp3.mimetype, mp3.fileName], ['/tmp/x', 'audio/mpeg', 'Bababoy.mp3'])
  const voice = buildMediaMessage({ ...job, format: 'audio', mimetype: 'audio/mp4' }).content
  assert.deepEqual([voice.audio.url, voice.mimetype, voice.ptt, voice.seconds], ['/tmp/x', 'audio/mp4', false, 225])
  const mp4 = buildMediaMessage({ ...job, format: 'mp4', fileName: 'Bababoy.mp4' }).content
  assert.deepEqual([mp4.document.url, mp4.mimetype], ['/tmp/x', 'video/mp4'])
  const vid = buildMediaMessage({ ...job, format: 'video', mimetype: 'video/mp4' }).content
  assert.deepEqual([vid.video.url, vid.mimetype, vid.width, vid.height], ['/tmp/x', 'video/mp4', 854, 480])
  const big = buildMediaMessage({ ...job, format: 'video', size: WA_INLINE_MAX_BYTES + 1 })
  assert.ok(big.content.document && big.note, 'trop lourd : envoyé en fichier')
})

class FakeMedia {
  constructor() {
    this.queue = new JobQueue()
    this.searches = []
    this.prepared = []
    this.cleaned = 0
  }

  maxSeconds(kind) {
    return kind === 'video' ? 900 : 1800
  }

  async search(query, kind) {
    this.searches.push({ query, kind })
    const id = 'abcdefghijk'
    return { id, source: 'youtube', url: 'https://www.youtube.com/watch?v=' + id, title: 'Bababoy', channel: 'Bababoy', duration: 225, views: '1 M de vues', live: false }
  }

  async thumbnail() {
    return { image: Buffer.from('fake-jpeg'), small: Buffer.from('fake-small') }
  }

  async prepare(item, format, { onStage } = {}) {
    await onStage?.('download')
    await onStage?.('convert')
    this.prepared.push(format)
    const ext = { mp3: 'mp3', audio: 'm4a', mp4: 'mp4', video: 'mp4' }[format]
    const mimetype = { mp3: 'audio/mpeg', audio: 'audio/mp4', mp4: 'video/mp4', video: 'video/mp4' }[format]
    return {
      format,
      file: `/tmp/fake.${ext}`,
      mimetype,
      fileName: `${item.title}.${ext}`,
      size: 2048,
      seconds: 225,
      width: 854,
      height: 480,
      title: item.title,
      thumb: null,
      cleanup: async () => {
        this.cleaned++
      },
    }
  }

  statusText() {
    return 'yt-dlp test ✅'
  }
}

await test('Bot : .song bababoy → miniature, « 1 » = MP3 (fichier), « 2 » = audio WhatsApp', async () => {
  const kv = await newKv('bot-song')
  const settings = new Settings(kv)
  const wa = new FakeWA()
  const media = new FakeMedia()
  const bot = new Bot({ wa, kv, settings, ai: fakeAI, config: { prefix: '.', botName: 'Nova', ownerName: '' }, log: silent, media })
  const self = wa.me.id
  const up = async (msg, wait = 40) => {
    await bot.onUpsert({ messages: [msg], type: 'notify' })
    await sleep(wait)
  }

  // .song tout seul : mode d'emploi
  await up(incoming(self, '.song', { fromMe: true }))
  assert.match(wa.sent.at(-1).text, /\.song <titre ou lien>/)

  // .song bababoy : miniature + 2 choix
  await up(incoming(self, '.song bababoy', { fromMe: true }))
  assert.deepEqual(media.searches.at(-1), { query: 'bababoy', kind: 'audio' })
  const preview = wa.sent.at(-1)
  assert.equal(preview.jid, self)
  assert.ok(Buffer.isBuffer(preview.content.image), 'la miniature doit être envoyée en image')
  assert.match(preview.content.caption, /Bababoy/)
  assert.match(preview.content.caption, /\*1\.\* 🎧 MP3 \(fichier\)/)
  assert.match(preview.content.caption, /\*2\.\* 🔊 Audio WhatsApp/)
  assert.equal(bot.getPending(self)?.step, 'song')

  // « 1 » → MP3 envoyé en fichier
  let n = wa.sent.length
  await up(incoming(self, '1', { fromMe: true }))
  await bot.commands.mediaIdle()
  const mp3 = wa.sent.slice(n).find((s) => s.content?.document)
  assert.ok(mp3, 'le MP3 doit être envoyé en fichier')
  assert.equal(mp3.content.mimetype, 'audio/mpeg')
  assert.equal(mp3.content.fileName, 'Bababoy.mp3')
  assert.ok(
    wa.sent.slice(n).some((s) => s.content?.edit && /✅/.test(s.text)),
    'le message de suivi doit passer à ✅',
  )
  assert.equal(bot.getPending(self), null)
  assert.deepEqual(media.prepared, ['mp3'])

  // .song puis « 2 » → audio WhatsApp (lecteur audio, pas une note vocale)
  await up(incoming(self, '.song bababoy', { fromMe: true }))
  n = wa.sent.length
  await up(incoming(self, '2', { fromMe: true }))
  await bot.commands.mediaIdle()
  const audio = wa.sent.slice(n).find((s) => s.content?.audio)
  assert.ok(audio, "l'audio WhatsApp doit être envoyé")
  assert.equal(audio.content.ptt, false)
  assert.equal(audio.content.mimetype, 'audio/mp4')

  // mauvais choix : on redemande ; « 0 » annule
  await up(incoming(self, '.song bababoy', { fromMe: true }))
  await up(incoming(self, '3', { fromMe: true }))
  assert.match(wa.sent.at(-1).text, /Réponds \*1\* ou \*2\*/)
  assert.equal(bot.getPending(self)?.step, 'song')
  await up(incoming(self, '0', { fromMe: true }))
  assert.match(wa.sent.at(-1).text, /Annulé/)
  assert.deepEqual(media.prepared, ['mp3', 'audio'])
  assert.equal(media.cleaned, 2, 'les fichiers temporaires sont supprimés')

  // .help et .statut mentionnent la fonction
  await up(incoming(self, '.help', { fromMe: true }))
  assert.match(wa.sent.at(-1).text, /\.song\*? <titre ou lien>[\s\S]*\.video\*? <titre ou lien>/)
  await up(incoming(self, '.statut', { fromMe: true }))
  assert.match(wa.sent.at(-1).text, /Musique\/vidéo : yt-dlp test/)
})

await test('Bot : .video en mode discret, message normal, réponse en citant la miniature', async () => {
  const kv = await newKv('bot-video')
  const settings = new Settings(kv)
  const wa = new FakeWA()
  const media = new FakeMedia()
  const bot = new Bot({ wa, kv, settings, ai: fakeAI, config: { prefix: '.', botName: 'Nova', ownerName: '' }, log: silent, media })
  const self = wa.me.id
  const friend = '33633333333@s.whatsapp.net'
  const up = async (msg, wait = 40) => {
    await bot.onUpsert({ messages: [msg], type: 'notify' })
    await sleep(wait)
  }
  const quoteReply = (text, stanzaId, quotedMessage) => ({
    key: { remoteJid: self, fromMe: true, id: `MSG${++seq}` },
    message: { extendedTextMessage: { text, contextInfo: { stanzaId, participant: self, quotedMessage } } },
    pushName: 'Alex',
    messageTimestamp: Math.floor(Date.now() / 1000),
  })

  // .video dans la discussion d'un ami : commande effacée, miniature envoyée dans « Moi »
  await up(incoming(friend, '.video bababoy', { fromMe: true }))
  assert.equal(wa.deleted.length, 1)
  assert.deepEqual(media.searches.at(-1), { query: 'bababoy', kind: 'video' })
  const preview = wa.sent.at(-1)
  const previewId = `BOT${wa.count}`
  assert.equal(preview.jid, self)
  assert.match(preview.content.caption, /📍/)
  assert.match(preview.content.caption, /\*1\.\* 📁 MP4 \(fichier\)/)
  assert.match(preview.content.caption, /\*2\.\* ▶️ Vidéo WhatsApp/)
  assert.equal(bot.getPending(self)?.step, 'video')

  // un message normal ferme le choix sans rien télécharger
  await up(incoming(self, 'salut', { fromMe: true }))
  assert.equal(bot.getPending(self), null)
  assert.equal(media.prepared.length, 0)

  // « 2 » en citant la miniature : marche même après la fermeture du choix
  let n = wa.sent.length
  await up(quoteReply('2', previewId, { imageMessage: { caption: preview.content.caption } }))
  await bot.commands.mediaIdle()
  const video = wa.sent.slice(n).find((s) => s.content?.video)
  assert.ok(video, 'la vidéo WhatsApp doit être envoyée')
  assert.equal(video.jid, self)
  assert.equal(video.content.mimetype, 'video/mp4')
  assert.deepEqual([video.content.width, video.content.height], [854, 480])
  assert.deepEqual(media.prepared, ['video'])

  // .video en citant un message : le texte cité sert de recherche
  await up(quoteReply('.video', 'AUTRE1', { conversation: 'bababoy remix' }))
  assert.deepEqual(media.searches.at(-1), { query: 'bababoy remix', kind: 'video' })

  // « 1 » → MP4 envoyé en fichier
  n = wa.sent.length
  await up(incoming(self, '1', { fromMe: true }))
  await bot.commands.mediaIdle()
  const mp4 = wa.sent.slice(n).find((s) => s.content?.document)
  assert.ok(mp4, 'le MP4 doit être envoyé en fichier')
  assert.equal(mp4.content.mimetype, 'video/mp4')
  assert.equal(mp4.content.fileName, 'Bababoy.mp4')
})

await test('Bot : .song et .video accessibles à tout le monde, pas seulement au propriétaire', async () => {
  const kv = await newKv('bot-public-media')
  const settings = new Settings(kv)
  const wa = new FakeWA()
  const media = new FakeMedia()
  const bot = new Bot({ wa, kv, settings, ai: fakeAI, config: { prefix: '.', botName: 'Nova', ownerName: '' }, log: silent, media })
  const friend = '33644444444@s.whatsapp.net'
  const group = '120363000000000002@g.us'
  const alice = '33655555555@s.whatsapp.net'
  const bob = '33666666666@s.whatsapp.net'
  const up = async (msg, wait = 40) => {
    await bot.onUpsert({ messages: [msg], type: 'notify' })
    await sleep(wait)
  }

  // Un contact peut utiliser .song (sans IA active)
  await up(incoming(friend, '.song bababoy'))
  assert.deepEqual(media.searches.at(-1), { query: 'bababoy', kind: 'audio' })
  const preview = wa.sent.at(-1)
  assert.equal(preview.jid, friend, 'la miniature doit aller au contact, pas au propriétaire')
  assert.match(preview.content.caption, /Bababoy/)
  const friendKey = `public:${friend}`
  assert.equal(bot.getPending(friendKey)?.step, 'song')

  // « 1 » → MP3 envoyé au contact
  let n = wa.sent.length
  await up(incoming(friend, '1'))
  await bot.commands.mediaIdle()
  const mp3 = wa.sent.slice(n).find((s) => s.jid === friend && s.content?.document)
  assert.ok(mp3, 'le MP3 doit être envoyé au contact')
  assert.equal(mp3.content.mimetype, 'audio/mpeg')
  assert.equal(bot.getPending(friendKey), null)

  // En groupe, la miniature et le fichier vont au groupe, et chaque membre a son propre choix
  await up(incoming(group, '.video clip', { participant: alice }))
  assert.deepEqual(media.searches.at(-1), { query: 'clip', kind: 'video' })
  assert.equal(wa.sent.at(-1).jid, group)
  const aliceKey = `public:${group}#${alice}`
  assert.equal(bot.getPending(aliceKey)?.step, 'video')
  await up(incoming(group, '.song autre', { participant: bob }))
  const bobKey = `public:${group}#${bob}`
  assert.equal(bot.getPending(bobKey)?.step, 'song')
  assert.equal(bot.getPending(aliceKey)?.step, 'video', 'le choix d’Alice ne doit pas être écrasé par Bob')

  // Alice répond « 1 » : son MP4 part dans le groupe
  n = wa.sent.length
  await up(incoming(group, '1', { participant: alice }))
  await bot.commands.mediaIdle()
  const mp4 = wa.sent.slice(n).find((s) => s.jid === group && s.content?.document)
  assert.ok(mp4, 'le MP4 doit être envoyé dans le groupe')
  assert.equal(mp4.content.mimetype, 'video/mp4')
  assert.equal(bot.getPending(aliceKey), null)
  assert.equal(bot.getPending(bobKey)?.step, 'song', 'le choix de Bob reste intact')

  await kv.close()
})

await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} tests réussis`)
process.exit(failed ? 1 : 0)
