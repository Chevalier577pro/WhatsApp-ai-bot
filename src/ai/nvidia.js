/**
 * Client minimal pour l'API NVIDIA (compatible OpenAI) : https://integrate.api.nvidia.com/v1
 * Clé gratuite sur https://build.nvidia.com
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class AIError extends Error {
  constructor(message, { status, kind = 'api' } = {}) {
    super(message)
    this.name = 'AIError'
    this.status = status
    this.kind = kind
  }
}

// Modèles qui ne servent pas à discuter (embeddings, vision seule, audio, biologie...)
const NON_CHAT =
  /(embed|rerank|retriev|nv-?clip|reward|guard|safety|parakeet|canary|whisper|riva|asr|tts|fastpitch|ocr|paddle|deplot|kosmos|fuyu|neva|vila|cosmos|grounding|bge-|e5-|audio2face|dinov|changenet|sdxl|stable-diffusion|flux|esm2|alphafold|diffdock|molmim|genmol|vista-3d|maisi|usdcode|usdsearch|eyecontact|studiovoice|bevformer|sparsedrive)/i

function httpMessage(status, detail) {
  if (status === 401 || status === 403) return `Clé NVIDIA invalide ou sans accès à ce modèle (${status}). Vérifie NVIDIA_API_KEY.`
  if (status === 404) return 'Modèle introuvable (404). Choisis-en un autre avec .models'
  if (status === 429) return 'Trop de requêtes ou quota NVIDIA atteint (429). Réessaie dans un moment.'
  if (status >= 500) return `Le service NVIDIA est indisponible (${status}). Réessaie plus tard.`
  return `Requête refusée par NVIDIA (${status})${detail ? ` : ${detail}` : ''}`
}

/** Retire le "raisonnement" que certains modèles renvoient entre <think>...</think>. */
export function cleanOutput(text) {
  let t = String(text ?? '')
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '')
  if (/<\/think>/i.test(t)) t = t.replace(/^[\s\S]*<\/think>/i, '')
  t = t.replace(/<\/?think>/gi, '')
  return t.trim()
}

export class NvidiaClient {
  constructor({ apiKey, baseUrl = 'https://integrate.api.nvidia.com/v1', log, fetchImpl } = {}) {
    this.apiKey = apiKey
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.log = log
    this.fetch = fetchImpl || globalThis.fetch
    this.modelsCache = null
  }

  get configured() {
    return !!this.apiKey
  }

  async #request(path, { method = 'GET', body, timeoutMs = 90_000 } = {}) {
    if (!this.apiKey) {
      throw new AIError("NVIDIA_API_KEY manquante : ajoute ta clé (nvapi-...) dans les variables d'environnement.", { kind: 'config' })
    }
    let lastErr
    for (let attempt = 0; attempt < 3; attempt++) {
      let res
      try {
        res = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
          throw new AIError('Le modèle met trop de temps à répondre (délai dépassé). Essaie un modèle plus rapide.', { kind: 'timeout' })
        }
        lastErr = new AIError(`Erreur réseau vers NVIDIA : ${err?.message || err}`, { kind: 'network' })
        if (attempt < 2) {
          await sleep(1500 * (attempt + 1))
          continue
        }
        throw lastErr
      }
      if (res.ok) return res.json()

      const raw = await res.text().catch(() => '')
      let detail = raw
      try {
        const j = JSON.parse(raw)
        detail = j.detail || j.error?.message || j.message || j.title || raw
      } catch {}
      detail = (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)
      lastErr = new AIError(httpMessage(res.status, detail), { status: res.status })
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const retryAfter = Number(res.headers?.get?.('retry-after'))
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 2000 * (attempt + 1))
        continue
      }
      throw lastErr
    }
    throw lastErr
  }

  /** maxTokens <= 0 ou null : illimité (le modèle s'arrête à sa propre limite). */
  async chat({ model, messages, temperature = 0.7, maxTokens = 1024, reasoning = false }) {
    const unlimited = !(Number(maxTokens) > 0)
    const body = { model, messages, temperature, top_p: 0.95, stream: false }
    if (!unlimited) body.max_tokens = Number(maxTokens)
    // Sans limite, une longue réponse peut prendre plusieurs minutes
    const timeoutMs = unlimited ? 300_000 : 90_000
    // Active/désactive le "mode réflexion" des modèles qui le proposent
    if (/nemotron|qwen3|deepseek-v3\.[1-9]|glm-4\.[5-9]/i.test(model)) {
      body.chat_template_kwargs = { enable_thinking: !!reasoning, thinking: !!reasoning }
    }
    let data
    try {
      data = await this.#request('/chat/completions', { method: 'POST', body, timeoutMs })
    } catch (err) {
      if (!body.chat_template_kwargs || (err.status !== 400 && err.status !== 422)) throw err
      delete body.chat_template_kwargs // le modèle n'accepte pas l'option : on réessaie sans
      data = await this.#request('/chat/completions', { method: 'POST', body, timeoutMs })
    }
    const choice = data?.choices?.[0]
    let content = choice?.message?.content
    if (Array.isArray(content)) content = content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
    const text = cleanOutput(content)
    if (!text) {
      const why =
        choice?.finish_reason === 'length'
          ? ' (limite de longueur atteinte : augmente-la avec .tokens, ou .tokens illimite, ou désactive le raisonnement)'
          : ''
      throw new AIError(`Le modèle a renvoyé une réponse vide${why}.`, { kind: 'empty' })
    }
    return { text, model: data.model || model, usage: data.usage || null, finishReason: choice?.finish_reason || null }
  }

  /** Liste des modèles de discussion disponibles (mise en cache 1 h). */
  async listModels({ force = false } = {}) {
    if (!force && this.modelsCache && Date.now() - this.modelsCache.at < 3_600_000) return this.modelsCache.ids
    const data = await this.#request('/models', { timeoutMs: 20_000 })
    const ids = [...new Set((data?.data || []).map((m) => m?.id).filter(Boolean))]
      .filter((id) => !NON_CHAT.test(id))
      .sort((a, b) => a.localeCompare(b))
    this.modelsCache = { at: Date.now(), ids }
    return ids
  }
}
