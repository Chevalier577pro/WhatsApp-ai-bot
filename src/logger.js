import pino from 'pino'
import { config } from './config.js'

export const logger = pino({
  level: config.logLevel,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
})

// Logger dédié à Baileys (très bavard) : silencieux par défaut.
export const baileysLogger = pino({
  level: process.env.BAILEYS_LOG_LEVEL || 'silent',
  base: undefined,
})
