import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { serialize, deserialize } from './bufferJson.js'

/**
 * Stockage fichier : un seul JSON, écrit de façon atomique (fichier temporaire + rename).
 * Attention : sur Render (offre gratuite), le disque est effacé à chaque redémarrage.
 */
class FileBackend {
  constructor(dir) {
    this.kind = 'file'
    this.delay = 1000
    this.dir = dir
    this.file = path.join(dir, 'store.json')
    this.cache = new Map() // clé -> valeur déjà sérialisée (JSON)
  }

  async loadAll() {
    await fsp.mkdir(this.dir, { recursive: true })
    if (!fs.existsSync(this.file)) return []
    const raw = await fsp.readFile(this.file, 'utf8')
    if (!raw.trim()) return []
    let obj
    try {
      obj = JSON.parse(raw)
    } catch {
      const backup = path.join(this.dir, `store.corrupt-${Date.now()}.json`)
      await fsp.rename(this.file, backup).catch(() => {})
      return []
    }
    const entries = []
    for (const [key, value] of Object.entries(obj)) {
      const text = JSON.stringify(value)
      this.cache.set(key, text)
      entries.push([key, text])
    }
    return entries
  }

  async write(changes) {
    for (const [key, text] of changes) {
      if (text === null) this.cache.delete(key)
      else this.cache.set(key, text)
    }
    const parts = []
    for (const [key, text] of this.cache) parts.push(`${JSON.stringify(key)}:${text}`)
    const tmp = `${this.file}.${process.pid}.tmp`
    await fsp.mkdir(this.dir, { recursive: true })
    await fsp.writeFile(tmp, `{${parts.join(',')}}`)
    await fsp.rename(tmp, this.file)
  }

  async close() {}
}

/** Stockage MongoDB (ex : MongoDB Atlas gratuit) : la session survit aux redéploiements. */
class MongoBackend {
  constructor(uri, dbName) {
    this.kind = 'mongodb'
    this.delay = 300
    this.uri = uri
    this.dbName = dbName
    this.client = null
    this.col = null
  }

  async loadAll() {
    let MongoClient
    try {
      ;({ MongoClient } = await import('mongodb'))
    } catch {
      throw new Error('Le paquet "mongodb" est introuvable : lance "npm install".')
    }
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 20000 })
    await this.client.connect()
    this.col = this.client.db(this.dbName).collection('kv')
    const docs = await this.col.find({}, { projection: { _id: 1, v: 1 } }).toArray()
    return docs.filter((d) => typeof d.v === 'string').map((d) => [String(d._id), d.v])
  }

  async write(changes) {
    const ops = changes.map(([key, text]) =>
      text === null
        ? { deleteOne: { filter: { _id: key } } }
        : { replaceOne: { filter: { _id: key }, replacement: { v: text }, upsert: true } },
    )
    if (ops.length) await this.col.bulkWrite(ops, { ordered: false })
  }

  async close() {
    await this.client?.close().catch(() => {})
  }
}

/**
 * Petit stockage clé/valeur : lecture synchrone depuis la mémoire,
 * écriture différée et groupée vers le fichier ou MongoDB.
 */
export class KVStore {
  constructor(backend, log = console) {
    this.backend = backend
    this.log = log
    this.map = new Map()
    this.dirty = new Set()
    this.timer = null
    this.chain = Promise.resolve()
  }

  static async create({ mongoUri, mongoDb, dataDir, log } = {}) {
    const backend = mongoUri ? new MongoBackend(mongoUri, mongoDb || 'whatsapp_ai_bot') : new FileBackend(dataDir || './data')
    const kv = new KVStore(backend, log)
    await kv.load()
    return kv
  }

  get kind() {
    return this.backend.kind
  }

  async load() {
    const entries = await this.backend.loadAll()
    for (const [key, text] of entries) {
      try {
        this.map.set(key, deserialize(text))
      } catch {
        this.log.warn?.({ key }, 'Entrée de stockage illisible ignorée')
      }
    }
  }

  get(key, fallback = undefined) {
    return this.map.has(key) ? this.map.get(key) : fallback
  }

  has(key) {
    return this.map.has(key)
  }

  set(key, value) {
    if (value === undefined || value === null) return this.del(key)
    this.map.set(key, value)
    this.touch(key)
  }

  del(key) {
    if (this.map.delete(key)) this.touch(key)
  }

  keys(prefix = '') {
    const out = []
    for (const key of this.map.keys()) if (key.startsWith(prefix)) out.push(key)
    return out
  }

  deletePrefix(prefix) {
    for (const key of this.keys(prefix)) this.del(key)
  }

  touch(key) {
    this.dirty.add(key)
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, this.backend.delay)
    }
  }

  /** Force l'écriture immédiate de toutes les modifications en attente. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.chain = this.chain
      .then(() => this.#flushNow())
      .catch((err) => this.log.error?.({ err: err?.message }, 'Échec de sauvegarde du stockage'))
    return this.chain
  }

  async #flushNow() {
    if (!this.dirty.size) return
    const keys = [...this.dirty]
    this.dirty.clear()
    const changes = []
    for (const key of keys) {
      if (!this.map.has(key)) {
        changes.push([key, null])
        continue
      }
      try {
        changes.push([key, serialize(this.map.get(key))])
      } catch (err) {
        this.log.warn?.({ key, err: err?.message }, 'Valeur non sérialisable ignorée')
      }
    }
    try {
      await this.backend.write(changes)
    } catch (err) {
      for (const key of keys) this.dirty.add(key)
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.flush()
        }, 5000)
      }
      throw err
    }
  }

  async close() {
    await this.flush()
    await this.backend.close()
  }
}
