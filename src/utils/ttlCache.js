/** Cache mémoire avec expiration (compatible avec l'interface CacheStore de Baileys). */
export class TTLCache {
  constructor({ ttlMs = 60_000, max = 5000 } = {}) {
    this.ttlMs = ttlMs
    this.max = max
    this.map = new Map()
  }

  get(key) {
    const entry = this.map.get(key)
    if (!entry) return undefined
    if (entry.expires <= Date.now()) {
      this.map.delete(key)
      return undefined
    }
    return entry.value
  }

  has(key) {
    return this.get(key) !== undefined
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.has(key)) this.map.delete(key)
    else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value)
    this.map.set(key, { value, expires: Date.now() + ttlMs })
    return true
  }

  del(key) {
    this.map.delete(key)
  }

  delete(key) {
    this.map.delete(key)
  }

  flushAll() {
    this.map.clear()
  }

  get size() {
    return this.map.size
  }
}
