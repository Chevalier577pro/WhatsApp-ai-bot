import { initAuthCreds, proto } from '../whatsapp/baileys.js'

function toAppStateSyncKey(value) {
  const v = { ...value }
  if (typeof v.keyData === 'string') v.keyData = Buffer.from(v.keyData, 'base64')
  const T = proto?.Message?.AppStateSyncKeyData
  if (!T) return v
  if (typeof T.fromObject === 'function') return T.fromObject(v)
  if (typeof T.create === 'function') return T.create(v)
  return v
}

/**
 * État d'authentification Baileys stocké dans le KVStore (fichier ou MongoDB).
 * - auth:creds              -> identifiants principaux (c'est eux qui forment le SESSION_ID)
 * - auth:<type>:<id>        -> clés Signal (pre-keys, sessions, sender-keys, app-state...)
 */
export function useKVAuthState(kv) {
  let creds = kv.get('auth:creds')
  if (!creds) {
    creds = initAuthCreds()
    kv.set('auth:creds', creds)
  }

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {}
        for (const id of ids) {
          let value = kv.get(`auth:${type}:${id}`)
          if (value === undefined) continue
          if (type === 'app-state-sync-key' && value) value = toAppStateSyncKey(value)
          data[id] = value
        }
        return data
      },
      set: async (data) => {
        for (const type of Object.keys(data || {})) {
          const entries = data[type] || {}
          for (const id of Object.keys(entries)) {
            const value = entries[id]
            const key = `auth:${type}:${id}`
            if (value) kv.set(key, value)
            else kv.del(key)
          }
        }
      },
      clear: async () => {
        for (const key of kv.keys('auth:')) if (key !== 'auth:creds') kv.del(key)
      },
    },
  }

  const saveCreds = async () => {
    kv.set('auth:creds', state.creds)
  }

  return { state, saveCreds }
}
