import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { replacer, reviver } from './storage/bufferJson.js'

/**
 * Format du SESSION_ID : "WAI~" + base64url( gzip( JSON(creds) ) )
 * Le décodeur accepte aussi : un autre préfixe "XXX~", du base64 simple ou du JSON brut (creds.json).
 */
export const SESSION_PREFIX = 'WAI~'

export const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex')

export function encodeSession(creds) {
  const json = JSON.stringify(creds, replacer)
  return SESSION_PREFIX + zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url')
}

function extractCreds(obj) {
  const creds = obj && typeof obj === 'object' && obj.creds && typeof obj.creds === 'object' ? obj.creds : obj
  if (!creds || typeof creds !== 'object' || !creds.noiseKey || !creds.signedIdentityKey || !creds.signedPreKey) {
    throw new Error("SESSION_ID invalide : ce n'est pas une session WhatsApp reconnue")
  }
  return creds
}

export function decodeSession(input) {
  if (!input || typeof input !== 'string') throw new Error('SESSION_ID vide')
  let s = input.trim().replace(/^['"]+|['"]+$/g, '')
  if (s.startsWith('{')) return extractCreds(JSON.parse(s, reviver))

  const tilde = s.lastIndexOf('~')
  if (tilde !== -1) s = s.slice(tilde + 1)
  s = s.replace(/\s+/g, '')
  if (!s || !/^[A-Za-z0-9+/=_-]+$/.test(s)) {
    throw new Error('SESSION_ID invalide : format non reconnu (utilise celui généré par le site du bot)')
  }

  const buf = Buffer.from(s, 'base64') // Node accepte aussi l'alphabet base64url
  const decoders = [() => zlib.gunzipSync(buf), () => zlib.inflateSync(buf), () => zlib.brotliDecompressSync(buf), () => buf]
  for (const decode of decoders) {
    let text
    try {
      text = decode().toString('utf8')
    } catch {
      continue
    }
    if (!text.trimStart().startsWith('{')) continue
    try {
      return extractCreds(JSON.parse(text, reviver))
    } catch (err) {
      if (String(err?.message).startsWith('SESSION_ID invalide')) throw err
    }
  }
  throw new Error('SESSION_ID invalide : impossible de le décoder (copie-le en entier, sans espace ni retour à la ligne)')
}

/** Session réellement connectée (appairage terminé), par code ou par QR. */
export function hasValidSession(creds) {
  return !!creds && !!(creds.registered || (creds.account && creds.me?.id))
}

/** Mémorise un SESSION_ID connu (pour ne pas ré-importer inutilement au prochain démarrage). */
export function rememberSession(kv, sessionId) {
  const value = String(sessionId).trim()
  const hash = sha256(value)
  const known = kv.get('meta:sessionHashes', []).filter((h) => h !== hash)
  known.push(hash)
  kv.set('meta:sessionHashes', known.slice(-10))
  kv.set('meta:sessionId', value)
  kv.set('meta:revokedHashes', kv.get('meta:revokedHashes', []).filter((h) => h !== hash))
}

/** Après une déconnexion : on note les sessions mortes pour ne pas les ré-importer en boucle. */
export function revokeSessions(kv, envSessionId) {
  const hashes = new Set([...kv.get('meta:revokedHashes', []), ...kv.get('meta:sessionHashes', [])])
  if (envSessionId) hashes.add(sha256(String(envSessionId).trim()))
  kv.set('meta:revokedHashes', [...hashes].slice(-20))
  kv.del('meta:sessionHashes')
  kv.del('meta:sessionId')
}

/**
 * Importe le SESSION_ID des variables d'environnement si besoin.
 * - même SESSION_ID que celui déjà en mémoire -> on garde l'état stocké (plus complet)
 * - nouveau SESSION_ID -> on remplace l'état d'authentification
 */
export function applyEnvSession(kv, sessionId) {
  if (!sessionId) return { applied: false, reason: 'none' }
  const value = String(sessionId).trim()
  const hash = sha256(value)
  if (kv.get('meta:revokedHashes', []).includes(hash)) return { applied: false, reason: 'revoked' }
  if (kv.get('meta:sessionHashes', []).includes(hash) && hasValidSession(kv.get('auth:creds'))) {
    return { applied: false, reason: 'current' }
  }
  const creds = decodeSession(value)
  kv.deletePrefix('auth:')
  kv.set('auth:creds', creds)
  rememberSession(kv, value)
  return { applied: true, reason: 'imported' }
}
