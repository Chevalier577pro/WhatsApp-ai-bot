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

  async presence() {}

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
const incoming = (remoteJid, text, { fromMe = false, pushName = 'Bob' } = {}) => ({
  key: { remoteJid, fromMe, id: `MSG${++seq}` },
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

await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} tests réussis`)
process.exit(failed ? 1 : 0)
