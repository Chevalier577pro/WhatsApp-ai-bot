import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { maskNumber } from '../utils/phone.js'

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')
const TOKEN_TTL_MS = 10 * 60_000 // durée pendant laquelle la personne qui appaire peut voir le code / QR / SESSION_ID
const PAIR_COOLDOWN_MS = 15_000
const MAX_BODY = 64 * 1024
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"

const digest = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest()
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b))

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return forwarded || req.socket?.remoteAddress || '?'
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'Requête trop volumineuse.')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    throw new HttpError(400, 'JSON invalide.')
  }
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string'
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...headers,
  })
  res.end(isText ? body : JSON.stringify(body))
}

/**
 * Site d'appairage : code à 8 caractères, QR code, SESSION_ID, import, déconnexion.
 * - Avec ADMIN_PASSWORD : toutes les actions demandent le mot de passe.
 * - Sans ADMIN_PASSWORD : l'appairage n'est possible que tant que le bot n'est pas connecté.
 */
export function createWebServer({ wa, config, log, settings }) {
  const hasPassword = Boolean(config.adminPassword)
  let token = null // { value, expiresAt } remis à la personne qui vient de demander un code ou un QR
  let lastPairAt = 0
  const failures = new Map() // ip -> { count, until } (anti force brute)

  function checkBruteForce(ip) {
    const f = failures.get(ip)
    if (f && f.until > Date.now() && f.count >= 10) throw new HttpError(429, 'Trop de tentatives. Réessaie dans 10 minutes.')
  }

  function noteFailure(ip) {
    const now = Date.now()
    const f = failures.get(ip)
    if (!f || f.until < now) failures.set(ip, { count: 1, until: now + 10 * 60_000 })
    else f.count++
    if (failures.size > 1000) failures.delete(failures.keys().next().value)
  }

  function isAdmin(req) {
    if (!hasPassword) return false
    let given = String(req.headers['x-admin-password'] || '')
    if (!given) return false
    try {
      given = decodeURIComponent(given) // le site encode le mot de passe (accents, symboles)
    } catch {}
    const ip = clientIp(req)
    checkBruteForce(ip)
    if (safeEqual(given, config.adminPassword)) return true
    noteFailure(ip)
    return false
  }

  function requireAdmin(req) {
    if (!hasPassword) {
      throw new HttpError(403, "Ajoute la variable ADMIN_PASSWORD sur Render pour utiliser cette fonction depuis le site (ou envoie .session dans ta discussion « Moi »).")
    }
    if (!isAdmin(req)) throw new HttpError(401, 'Mot de passe incorrect.')
  }

  function requirePairingAllowed(req) {
    if (hasPassword) return requireAdmin(req)
    if (wa.connected) {
      throw new HttpError(409, 'Le bot est déjà connecté. Pour changer de compte, ajoute ADMIN_PASSWORD sur Render puis déconnecte-le depuis le site.')
    }
  }

  function tokenFrom(req, url) {
    return req.headers['x-pair-token'] || url.searchParams.get('token') || ''
  }

  function validToken(value) {
    return Boolean(token && value && token.expiresAt > Date.now() && safeEqual(value, token.value))
  }

  function newToken() {
    token = { value: crypto.randomBytes(24).toString('base64url'), expiresAt: Date.now() + TOKEN_TTL_MS }
    return token.value
  }

  function throttlePairing() {
    const wait = lastPairAt + PAIR_COOLDOWN_MS - Date.now()
    if (wait > 0) throw new HttpError(429, `Patiente ${Math.ceil(wait / 1000)} s avant de redemander un code.`)
    lastPairAt = Date.now()
  }

  function statusFor(req, url) {
    const st = wa.publicStatus()
    const trusted = validToken(tokenFrom(req, url))
    return {
      status: st.status,
      connected: st.connected,
      me: st.me ? { number: st.me.number ? maskNumber(st.me.number) : null, name: st.me.name || null } : null,
      hasSession: st.hasSession,
      storage: st.storage,
      lastError: st.lastError,
      connectedAt: st.connectedAt,
      botName: settings?.get('botName') || config.botName,
      needsPassword: hasPassword,
      canPair: hasPassword || !st.connected,
      pairing: trusted && st.pairing ? { code: st.pairing.code, expiresAt: st.pairing.expiresAt } : null,
      qr: trusted ? st.qr : null,
      sessionAvailable: trusted && st.connected,
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    const route = `${req.method} ${url.pathname}`
    switch (route) {
      case 'GET /':
      case 'GET /index.html': {
        const html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
        return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP })
      }
      case 'GET /health':
      case 'HEAD /health':
        return send(res, 200, { ok: true, status: wa.status, uptime: Math.round(process.uptime()) })
      case 'GET /favicon.ico':
        res.writeHead(204)
        return res.end()
      case 'GET /api/status':
        return send(res, 200, statusFor(req, url))
      case 'POST /api/login': {
        if (!hasPassword) return send(res, 200, { ok: true, noPassword: true })
        const ip = clientIp(req)
        checkBruteForce(ip)
        const { password } = await readJson(req)
        if (!password || !safeEqual(password, config.adminPassword)) {
          noteFailure(ip)
          throw new HttpError(401, 'Mot de passe incorrect.')
        }
        failures.delete(ip)
        return send(res, 200, { ok: true })
      }
      case 'POST /api/pair': {
        requirePairingAllowed(req)
        const { phone } = await readJson(req)
        if (!phone) throw new HttpError(400, 'Indique ton numéro WhatsApp.')
        throttlePairing()
        const code = await wa.requestPairing(String(phone))
        return send(res, 200, { code, expiresAt: wa.pairing?.expiresAt || Date.now() + 3 * 60_000, token: newToken() })
      }
      case 'POST /api/qr': {
        requirePairingAllowed(req)
        throttlePairing()
        const qr = await wa.requestQr()
        return send(res, 200, { qr, token: newToken() })
      }
      case 'GET /api/session': {
        if (!validToken(tokenFrom(req, url))) requireAdmin(req)
        const sessionId = wa.exportSession()
        if (!sessionId) throw new HttpError(404, "Aucune session : connecte d'abord ton WhatsApp.")
        return send(res, 200, { sessionId })
      }
      case 'POST /api/logout': {
        requireAdmin(req)
        await wa.logout()
        token = null
        return send(res, 200, { ok: true })
      }
      case 'POST /api/import': {
        if (hasPassword) requireAdmin(req)
        else if (wa.connected) throw new HttpError(409, 'Le bot est déjà connecté.')
        const { sessionId } = await readJson(req)
        if (!sessionId) throw new HttpError(400, 'Colle ton SESSION_ID.')
        await wa.importSession(String(sessionId).trim())
        return send(res, 200, { ok: true })
      }
      default:
        return send(res, 404, { error: 'Page introuvable.' })
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 400
      if (!(err instanceof HttpError)) log.warn({ err: err?.message }, 'Erreur API')
      if (!res.headersSent) send(res, status, { error: err?.message || 'Erreur inconnue.' })
      else res.end()
    })
  })
  server.requestTimeout = 90_000
  return server
}

export function startWebServer(options) {
  const { config, log } = options
  const server = createWebServer(options)
  server.listen(config.port, '0.0.0.0', () => log.info(`🌐 Site d'appairage en ligne sur le port ${config.port}`))
  return server
}
