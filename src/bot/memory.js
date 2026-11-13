/**
 * Mémoire des conversations (persistée dans le KVStore sous "mem:<discussion>").
 * rôles : 'them' = l'interlocuteur | 'me' = toi (message tapé à la main) | 'bot' = réponse de l'IA
 * m (réponses 'bot' uniquement) : mode utilisé ('ai', 'meai' ou 'aai')
 */
import { fileForMemory } from '../ai/files.js'

const MAX_TEXT = 2000

export class Memory {
  constructor(kv, getLimit = () => 20) {
    this.kv = kv
    this.getLimit = getLimit
  }

  #key(chat) {
    return `mem:${chat}`
  }

  #limit() {
    return Math.max(2, Math.min(500, Number(this.getLimit()) || 500))
  }

  get(chat) {
    return this.kv.get(this.#key(chat), [])
  }

  add(chat, entry) {
    this.addAfter(chat, entry, null)
  }

  /**
   * Ajoute une entrée juste après le dernier message daté de afterTs (ou à la fin).
   * Sert à ranger la réponse de l'IA avant les messages arrivés pendant qu'elle réfléchissait.
   */
  addAfter(chat, entry, afterTs) {
    if (!chat || (!entry?.text && !entry?.files?.length)) return
    const list = [...this.get(chat)]
    let index = list.length
    if (afterTs) {
      const next = list.findIndex((e) => e.ts > afterTs)
      if (next !== -1) index = next
    }
    const ts = index < list.length ? afterTs + 1 : Date.now()
    const item = { r: entry.r, t: String(entry.text || '').slice(0, MAX_TEXT), ts }
    if (entry.name) item.n = String(entry.name).slice(0, 60)
    if (entry.mode) item.m = String(entry.mode)
    if (entry.image) item.i = String(entry.image) // image pas encore regardée par l'IA (id du message)
    if (entry.files?.length) item.f = entry.files.slice(0, 5).map(fileForMemory) // fichiers envoyés par l'IA
    list.splice(index, 0, item)
    this.kv.set(this.#key(chat), list.slice(-this.#limit()))
  }

  /** Remplace « [image] » par sa description une fois l'image regardée. */
  setImageText(chat, imageId, text) {
    const list = this.get(chat)
    const index = list.findIndex((e) => e.i === imageId)
    if (index === -1) return
    const item = { ...list[index], t: String(text).slice(0, MAX_TEXT) }
    delete item.i
    this.kv.set(this.#key(chat), [...list.slice(0, index), item, ...list.slice(index + 1)])
  }

  last(chat) {
    const list = this.get(chat)
    return list[list.length - 1]
  }

  clear(chat) {
    this.kv.del(this.#key(chat))
  }

  clearAll() {
    this.kv.deletePrefix('mem:')
  }

  count() {
    return this.kv.keys('mem:').length
  }
}
