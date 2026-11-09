import fs from 'node:fs'
import path from 'node:path'

/**
 * Mini chargeur de fichier .env (pas besoin de dépendance).
 * Ne remplace jamais une variable déjà définie (ex : variables Render).
 */
function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return
  const content = fs.readFileSync(file, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    if (quoted && value.length >= 2) {
      const dbl = value.startsWith('"')
      value = value.slice(1, -1)
      if (dbl) value = value.replace(/\\n/g, '\n')
    } else {
      const hash = value.indexOf(' #')
      if (hash !== -1) value = value.slice(0, hash).trim()
    }
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}

loadDotEnv()

const env = (key, fallback = '') => {
  const v = process.env[key]
  return v === undefined || v.trim() === '' ? fallback : v.trim()
}

const int = (key, fallback) => {
  const n = parseInt(env(key, ''), 10)
  return Number.isFinite(n) ? n : fallback
}

export const config = Object.freeze({
  port: int('PORT', 3000),
  sessionId: env('SESSION_ID'),
  adminPassword: env('ADMIN_PASSWORD'),

  nvidiaApiKey: env('NVIDIA_API_KEY'),
  nvidiaBaseUrl: env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
  nvidiaModel: env('NVIDIA_MODEL', 'nvidia/nemotron-3-ultra-550b-a55b'),

  prefix: env('PREFIX', '.'),
  botName: env('BOT_NAME', 'Nova'),
  ownerName: env('OWNER_NAME'),
  timeZone: env('TIME_ZONE', 'Europe/Paris'),
  logLevel: env('LOG_LEVEL', 'info'),

  mongoUri: env('MONGODB_URI'),
  mongoDb: env('MONGODB_DB', 'whatsapp_ai_bot'),
  dataDir: path.resolve(env('DATA_DIR', './data')),

  // Render définit automatiquement RENDER_EXTERNAL_URL (ex : https://mon-bot.onrender.com)
  externalUrl: env('RENDER_EXTERNAL_URL', env('PUBLIC_URL')).replace(/\/+$/, ''),
})
