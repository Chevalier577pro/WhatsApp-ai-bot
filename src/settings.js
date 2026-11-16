import { config } from './config.js'

const DEFAULTS_VERSION = 2
// Anciennes valeurs par défaut : mises à jour une seule fois, sans toucher aux choix explicites.
const LEGACY_DEFAULTS = {
  model: 'nvidia/nemotron-3-ultra-550b-a55b',
  maxTokens: 1024,
  memory: 20,
}

export const DEFAULT_SETTINGS = () => ({
  defaultsVersion: DEFAULTS_VERSION,
  botName: config.botName || 'Nova',
  ownerName: config.ownerName || '',
  personality: 'amical, drôle, naturel et serviable',
  customPrompt: '',
  model: config.nvidiaModel,
  visionModel: config.nvidiaVisionModel,
  vision: true, // l'IA regarde les images reçues
  temperature: 0.7,
  maxTokens: 0, // 0 = illimité (aucune limite envoyée au modèle)
  memory: 500,
  replyDelay: 2,
  groupMode: 'all', // 'all' = répond à tout | 'mention' = seulement si on te mentionne / te répond
  signature: false,
  discreet: true,
  reasoning: false,
})

/** Réglages de l'IA + conversations où .ai / .meai / .aai sont actifs (persistés dans le KVStore). */
export class Settings {
  constructor(kv) {
    this.kv = kv
    const saved = kv.get('settings') || {}
    this.data = { ...DEFAULT_SETTINGS(), ...saved }
    this.#migrate(saved)
    this.aiChats = new Set(kv.get('aiChats') || [])
    this.meaiChats = new Set(kv.get('meaiChats') || [])
    this.aaiChats = new Set(kv.get('aaiChats') || []) // .aai : l'IA te répond aussi à toi
  }

  get(key) {
    return this.data[key]
  }

  set(key, value) {
    this.data[key] = value
    this.save()
  }

  update(patch) {
    Object.assign(this.data, patch)
    this.save()
  }

  save() {
    this.kv.set('settings', { ...this.data })
  }

  reset() {
    this.data = DEFAULT_SETTINGS()
    this.save()
  }

  all() {
    return { ...this.data }
  }

  /** Passe les anciennes valeurs par défaut aux nouvelles (une seule fois). */
  #migrate(saved) {
    if (saved.defaultsVersion === DEFAULTS_VERSION) return
    const d = DEFAULT_SETTINGS()
    if (saved.model === LEGACY_DEFAULTS.model) this.data.model = d.model
    if (saved.maxTokens === LEGACY_DEFAULTS.maxTokens) this.data.maxTokens = d.maxTokens
    if (saved.memory === LEGACY_DEFAULTS.memory) this.data.memory = d.memory
    this.data.defaultsVersion = DEFAULTS_VERSION
    if (Object.keys(saved).length) this.save()
  }

  #set(mode) {
    if (mode === 'meai') return this.meaiChats
    if (mode === 'aai') return this.aaiChats
    return this.aiChats
  }

  #persist(mode) {
    const key = mode === 'meai' ? 'meaiChats' : mode === 'aai' ? 'aaiChats' : 'aiChats'
    this.kv.set(key, [...this.#set(mode)])
  }

  /** ids = toutes les formes connues de la conversation (JID numéro + JID LID). */
  isActive(mode, ids) {
    const set = this.#set(mode)
    return ids.some((id) => id && set.has(id))
  }

  setActive(mode, ids, on) {
    const set = this.#set(mode)
    for (const id of ids) {
      if (!id) continue
      if (on) set.add(id)
      else set.delete(id)
    }
    this.#persist(mode)
  }

  clearMode(mode) {
    this.#set(mode).clear()
    this.#persist(mode)
  }

  activeChats() {
    return { ai: [...this.aiChats], meai: [...this.meaiChats], aai: [...this.aaiChats] }
  }
}
