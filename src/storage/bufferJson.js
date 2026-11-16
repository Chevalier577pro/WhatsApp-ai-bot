/**
 * Sérialisation JSON compatible avec les Buffers (même format que BufferJSON de Baileys :
 * { type: 'Buffer', data: '<base64>' }). Sans dépendance, donc testable hors ligne.
 */

export function replacer(_key, value) {
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return { type: 'Buffer', data: Buffer.from(value).toString('base64') }
    }
    // Buffer.toJSON() est appelé avant le replacer : { type: 'Buffer', data: [..] }
    if (value.type === 'Buffer' && Array.isArray(value.data)) {
      return { type: 'Buffer', data: Buffer.from(value.data).toString('base64') }
    }
  }
  return value
}

export function reviver(_key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.type === 'Buffer') {
      if (typeof value.data === 'string') return Buffer.from(value.data, 'base64')
      if (Array.isArray(value.data)) return Buffer.from(value.data)
    }
    // Uint8Array sérialisé "à la main" : { "0": 12, "1": 255, ... }
    const keys = Object.keys(value)
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      const values = Object.values(value)
      if (values.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return Buffer.from(values)
    }
  }
  return value
}

export const serialize = (value) => JSON.stringify(value, replacer)
export const deserialize = (text) => JSON.parse(text, reviver)
