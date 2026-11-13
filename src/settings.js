import { config } from './config.js'

export const DEFAULT_SETTINGS = () => ({
  botName: config.botName || 'Nova',
  ownerName: config.ownerName || '',
  personality: 'amical, drôle, naturel et serviable',
  customPrompt: '',
  model: config.nvidiaModel,
  visionModel: config.nvidiaVisionModel,
  vision: true, // l'IA regarde les images reçues
  temperature: 0.7,
  maxTokens: 1024, // 0 = illimité (aucune limite envoyée au modèle)
  memory: 20,
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
    this.data = { ...DEFAULT_SETTINGS(), ...(kv.get('settings') || {}) }
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
