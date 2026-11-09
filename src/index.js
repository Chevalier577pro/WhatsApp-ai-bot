import { config } from './config.js'
import { logger } from './logger.js'
import { KVStore } from './storage/kv.js'
import { Settings } from './settings.js'
import { applyEnvSession } from './session.js'
import { WhatsAppManager } from './whatsapp/manager.js'
import { NvidiaClient } from './ai/nvidia.js'
import { AIEngine } from './ai/engine.js'
import { Bot } from './bot/handler.js'
import { startWebServer } from './web/server.js'

const KEEP_ALIVE_MS = 10 * 60_000

async function main() {
  logger.info('🚀 Démarrage du bot WhatsApp IA…')

  const kv = await KVStore.create({
    mongoUri: config.mongoUri,
    mongoDb: config.mongoDb,
    dataDir: config.dataDir,
    log: logger,
  })
  logger.info(`💾 Stockage : ${kv.kind === 'mongodb' ? 'MongoDB' : 'fichier local'}`)
  if (kv.kind !== 'mongodb' && process.env.RENDER) {
    logger.info('Sans base de données : réglages, discussions actives et mémoire repartent à zéro à chaque redémarrage sur Render. La session WhatsApp revient grâce à SESSION_ID.')
  }

  const settings = new Settings(kv)

  try {
    const res = await applyEnvSession(kv, config.sessionId)
    if (res?.reason === 'imported') logger.info("🔑 SESSION_ID chargé depuis les variables d'environnement")
    if (res?.reason === 'revoked') {
      logger.warn("Ce SESSION_ID a été déconnecté : refais l'appairage depuis le site puis mets à jour la variable SESSION_ID.")
    }
  } catch (err) {
    logger.error({ err: err?.message }, 'SESSION_ID invalide : vérifie la variable SESSION_ID')
  }

  const wa = new WhatsAppManager({ kv, log: logger })
  const client = new NvidiaClient({ apiKey: config.nvidiaApiKey, baseUrl: config.nvidiaBaseUrl, log: logger })
  if (!client.configured) logger.warn('⚠️ NVIDIA_API_KEY manquante : le bot ne pourra pas répondre.')
  const ai = new AIEngine({ client, settings, timeZone: config.timeZone })
  const bot = new Bot({ wa, kv, settings, ai, config, log: logger })
  bot.attach()

  if (!config.adminPassword) {
    logger.warn("ADMIN_PASSWORD non défini : le site n'est protégé que tant que WhatsApp n'est pas connecté. Ajoute un mot de passe sur Render.")
  } else if (config.adminPassword === 'change-moi') {
    logger.warn('ADMIN_PASSWORD vaut encore « change-moi » : choisis un vrai mot de passe.')
  }
  const server = startWebServer({ wa, config, log: logger, settings })

  if (wa.hasSession()) {
    wa.start().catch((err) => logger.error({ err: err?.message }, 'Connexion WhatsApp impossible'))
  } else {
    const site = config.externalUrl || `http://localhost:${config.port}`
    logger.info(`📱 Aucune session WhatsApp : ouvre ${site} pour connecter ton compte.`)
  }

  // Garde le service gratuit de Render éveillé (il s'endort après 15 min sans visite)
  if (config.externalUrl) {
    const ping = () => fetch(new URL('/health', config.externalUrl), { signal: AbortSignal.timeout(15_000) }).catch(() => {})
    setInterval(ping, KEEP_ALIVE_MS).unref()
  }

  let stopping = false
  const shutdown = async (signal) => {
    if (stopping) return
    stopping = true
    logger.info({ signal }, 'Arrêt en cours…')
    setTimeout(() => process.exit(0), 8000).unref()
    try {
      wa.stop()
    } catch {}
    server.close()
    try {
      await kv.flush()
    } catch {}
    try {
      await kv.close()
    } catch {}
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

process.on('unhandledRejection', (err) => logger.error({ err: err?.message || String(err) }, 'Promesse rejetée non gérée'))
process.on('uncaughtException', (err) => logger.error({ err: err?.message, stack: err?.stack }, 'Exception non gérée'))

main().catch((err) => {
  logger.error({ err: err?.message, stack: err?.stack }, 'Échec du démarrage')
  process.exit(1)
})
