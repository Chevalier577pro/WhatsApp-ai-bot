import { DEFAULT_SETTINGS } from '../settings.js'
import { createMediaCommands } from './media.js'

const ON = new Set(['on', 'oui', 'yes', 'activer', 'active', 'start', 'true'])
const OFF = new Set(['off', 'non', 'no', 'desactiver', 'désactiver', 'stop', 'false'])
const PAGE_SIZE = 15

export function parseSwitch(arg) {
  const a = String(arg || '').trim().toLowerCase()
  if (ON.has(a)) return true
  if (OFF.has(a)) return false
  return null
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return [d && `${d} j`, h && `${h} h`, `${m} min`].filter(Boolean).join(' ')
}

/** maxTokens = 0 : illimité. */
export const tokensText = (v) => (Number(v) > 0 ? `${v} tokens` : 'illimitée ♾️')

/**
 * Commandes du propriétaire (toi uniquement : seuls TES messages sont lus comme des commandes).
 * Chaque commande reçoit { t, arg, say, sayHere, menuChat, pending } :
 *  t        = discussion visée (chat, ids, isGroup, self)
 *  say      = répondre (dans ta discussion perso si le mode discret est actif)
 *  sayHere  = répondre dans la discussion elle-même (.ask)
 */
export function createCommands(bot) {
  const { settings, wa, ai, memory } = bot
  const P = bot.prefix
  const mediaCmds = createMediaCommands(bot) // .song / .video
  const PUBLIC_COMMANDS = new Set(Object.keys(mediaCmds.COMMANDS)) // .song / .video : tout le monde
  const publicPendingKey = (ctx) =>
    `public:${ctx?.chat || ''}${ctx?.isGroup ? `#${ctx?.key?.participant || ''}` : ''}`
  let modelList = [] // dernière liste de modèles affichée (pour « .model <numéro> »)
  const MODEL_FOOTER =
    'Réponds avec le *numéro* du modèle, *+* pour la page suivante, un *mot* pour chercher (ex : llama), ou *0* pour annuler.'

  // ---------- activation de l'IA ----------

  async function toggleMode(a, mode) {
    const { t, arg, say } = a
    if (mode === 'meai' && t.self) {
      return say(`🪞 Le mode « à ta place » sert dans une discussion avec quelqu'un d'autre.\nIci, utilise *${P}ai* pour discuter en privé avec ton IA.`)
    }
    const wanted = parseSwitch(arg)
    const on = wanted === null ? !settings.isActive(mode, t.ids) : wanted
    settings.setActive(mode, t.ids, on)
    if (on) {
      const other = mode === 'ai' ? 'meai' : 'ai'
      if (settings.isActive(other, t.ids)) settings.setActive(other, t.ids, false) // un seul mode à la fois
    } else {
      bot.cancel(t.chat)
      if (!bot.activeModes(t.ids).length) settings.setActive('aai', t.ids, false) // .aai a besoin de .ai ou .meai
    }
    const title = mode === 'ai' ? `🤖 Assistant IA (${settings.get('botName')})` : '🪞 Réponse à ta place'
    let extra = ''
    if (on && mode === 'ai') {
      extra = t.self
        ? '\nÉcris-moi ici, je te réponds en privé.'
        : `\nJe réponds aux messages reçus ici${t.isGroup && settings.get('groupMode') === 'mention' ? ' quand on te mentionne ou te répond' : ''}.`
    }
    if (on && mode === 'meai') extra = '\nJe réponds à ta place, avec ton style. Si tu réponds toi-même avant moi, je ne dis rien.'
    const warn = on && !ai.client.configured ? "\n⚠️ NVIDIA_API_KEY manquante : l'IA ne pourra pas répondre." : ''
    return say(`${title} : *${on ? 'activé ✅' : 'désactivé ⛔'}*${extra}${warn}`)
  }

  async function stopHere({ t, say }) {
    settings.setActive('ai', t.ids, false)
    settings.setActive('meai', t.ids, false)
    settings.setActive('aai', t.ids, false)
    bot.cancel(t.chat)
    return say('⛔ IA désactivée dans cette discussion.')
  }

  async function stopAll({ say }) {
    settings.clearMode('ai')
    settings.clearMode('meai')
    settings.clearMode('aai')
    bot.cancelAll()
    return say('⛔ IA désactivée dans *toutes* les discussions.')
  }

  async function listActive({ say }) {
    const { ai: aiChats, meai: meaiChats, aai: aaiChats } = bot.activeList()
    const fmt = (ids) => (ids.length ? ids.map((id) => `- ${bot.label(id)}`).join('\n') : '- _aucune_')
    return say(
      [
        '📋 *Discussions actives*',
        '',
        `🤖 *Assistant IA* (${aiChats.length})`,
        fmt(aiChats),
        '',
        `🪞 *À ta place* (${meaiChats.length})`,
        fmt(meaiChats),
        '',
        `🙋 *L'IA te répond aussi* (${aaiChats.length})`,
        fmt(aaiChats),
      ].join('\n'),
    )
  }

  /** .aai : l'IA te répond aussi à toi dans cette discussion (il faut .ai ou .meai déjà actif). */
  async function toggleAai({ t, arg, say }) {
    if (t.self) {
      return say(`🙋 *${P}aai* sert dans une discussion avec quelqu'un (privée ou groupe).\nIci, *${P}ai* te répond déjà en privé.`)
    }
    const wanted = parseSwitch(arg)
    const on = wanted === null ? !settings.isActive('aai', t.ids) : wanted
    if (on && !bot.activeModes(t.ids).length) {
      return say(`❌ Active d'abord *${P}ai* ou *${P}meai* dans cette discussion, puis tape *${P}aai*.`)
    }
    settings.setActive('aai', t.ids, on)
    const extra = on
      ? `\nQuand tu écris ici, l'IA te répond aussi, en citant ton message. *${P}aai off* pour arrêter.`
      : "\nL'IA ne répond plus à tes propres messages ici."
    const warn = on && !ai.client.configured ? "\n⚠️ NVIDIA_API_KEY manquante : l'IA ne pourra pas répondre." : ''
    return say(`🙋 L'IA te répond aussi : *${on ? 'activé ✅' : 'désactivé ⛔'}*${extra}${warn}`)
  }

  // ---------- modèles ----------

  function renderModelPage(list, page, query = '', footer = '') {
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
    const p = Math.min(Math.max(1, page), pages)
    const current = settings.get('model')
    const start = (p - 1) * PAGE_SIZE
    const lines = list.slice(start, start + PAGE_SIZE).map((id, i) => `*${start + i + 1}.* ${id}${id === current ? ' ✅' : ''}`)
    const defaultFooter =
      `👉 *${P}model <numéro>* pour choisir` +
      (pages > 1 ? ` • *${P}models ${p < pages ? p + 1 : 1}* page suivante` : '') +
      ` • *${P}models <mot>* pour chercher`
    return [
      `🧠 *Modèles NVIDIA*${query ? ` (« ${query} »)` : ''} — page ${p}/${pages} • ${list.length} modèles`,
      `Actuel : *${current}*`,
      '',
      ...lines,
      '',
      footer || defaultFooter,
    ].join('\n')
  }

  async function listModels({ arg, say }) {
    const all = await ai.client.listModels()
    const q = String(arg || '').trim()
    if (!q || /^\d+$/.test(q)) {
      modelList = all
      return say(renderModelPage(all, q ? parseInt(q, 10) : 1))
    }
    const found = all.filter((id) => id.toLowerCase().includes(q.toLowerCase()))
    if (!found.length) return say(`🔎 Aucun modèle ne contient « ${q} ».`)
    modelList = found
    return say(renderModelPage(found, 1, q))
  }

  async function applyModel(id, say) {
    const previous = settings.get('model')
    settings.set('model', id)
    await say(`🧠 Modèle choisi : *${id}*\n⏳ Petit test en cours…`)
    try {
      const r = await ai.test({ ownerName: bot.ownerName() })
      return say(`✅ Le modèle répond en ${(r.ms / 1000).toFixed(1)} s :\n${r.text}`)
    } catch (err) {
      if (err?.status === 404 || err?.status === 400 || err?.status === 422) {
        settings.set('model', previous)
        return say(`❌ Ce modèle ne fonctionne pas : ${err.message}\nJe remets l'ancien : *${previous}*`)
      }
      return say(`⚠️ Le test a échoué : ${err?.message || err}\nJe garde quand même ce modèle (l'erreur est peut-être temporaire).`)
    }
  }

  async function setModel({ arg, say }) {
    const a = String(arg || '').trim()
    if (!a) {
      return say(`🧠 Modèle actuel : *${settings.get('model')}*\n👉 *${P}models* pour voir la liste, *${P}model <numéro ou nom>* pour changer.`)
    }
    if (/^\d+$/.test(a)) {
      if (!modelList.length) modelList = await ai.client.listModels()
      const id = modelList[parseInt(a, 10) - 1]
      if (!id) return say(`❌ Numéro invalide. Tape *${P}models* pour voir la liste.`)
      return applyModel(id, say)
    }
    if (!a.includes('/')) {
      const all = await ai.client.listModels()
      const found = all.filter((id) => id.toLowerCase().includes(a.toLowerCase()))
      if (found.length === 1) return applyModel(found[0], say)
      if (!found.length) return say(`🔎 Aucun modèle ne contient « ${a} ». Tape *${P}models* pour voir la liste.`)
      modelList = found
      return say(renderModelPage(found, 1, a))
    }
    return applyModel(a, say)
  }

  // ---------- réglages texte ----------

  function textSetting(key, { cmd, emoji, label, max, example = '', resetValue, show = (v) => `_${v}_`, empty = () => '_aucune_', done }) {
    return async ({ arg, say }) => {
      const a = String(arg || '').trim()
      const shown = () => (settings.get(key) ? show(settings.get(key)) : empty())
      if (!a) {
        return say(
          `${emoji} ${label} : ${shown()}\n👉 *${P}${cmd} <texte>* pour changer${example ? ` (ex : « ${example} »)` : ''}, *${P}${cmd} reset* pour revenir au défaut.`,
        )
      }
      if (a.toLowerCase() === 'reset') {
        settings.set(key, resetValue())
        return say(`${emoji} ${label} : valeur par défaut rétablie → ${shown()}`)
      }
      settings.set(key, a.slice(0, max))
      return say(done ? done(settings.get(key)) : `${emoji} ${label} : ${shown()} ✅`)
    }
  }

  const personality = textSetting('personality', {
    cmd: 'perso',
    emoji: '🎭',
    label: 'Personnalité',
    max: 500,
    example: 'sarcastique mais bienveillant',
    resetValue: () => DEFAULT_SETTINGS().personality,
  })
  const customPrompt = textSetting('customPrompt', {
    cmd: 'prompt',
    emoji: '📝',
    label: 'Consignes perso',
    max: 2000,
    example: 'Je suis étudiant à Lyon, tutoie tout le monde',
    resetValue: () => '',
  })
  const botNameCmd = textSetting('botName', {
    cmd: 'nom',
    emoji: '🏷️',
    label: 'Nom du bot',
    max: 30,
    show: (v) => `*${v}*`,
    resetValue: () => DEFAULT_SETTINGS().botName,
  })
  const ownerNameCmd = textSetting('ownerName', {
    cmd: 'owner',
    emoji: '👤',
    label: 'Ton prénom',
    max: 60,
    show: (v) => `*${v}*`,
    empty: () => `_(nom de ton profil WhatsApp : ${wa.me?.name || '?'})_`,
    resetValue: () => DEFAULT_SETTINGS().ownerName,
    done: (v) => `👤 C'est noté, je t'appellerai *${v}* ✅`,
  })

  // ---------- réglages numériques ----------

  function numberSetting(key, { cmd, emoji, label, min, max, unit = '', float = false, hint = '', show = (v) => `${v}${unit}`, special = null }) {
    return async ({ arg, say, menuChat, pending }) => {
      const a = String(arg || '').trim().replace(',', '.')
      const alt = special ? ` ou *${P}${cmd} ${special.word}*` : ''
      if (!a) {
        return say(`${emoji} ${label} : *${show(settings.get(key))}*${hint ? `\n${hint}` : ''}\n👉 *${P}${cmd} <${min}-${max}>*${alt} pour changer.`)
      }
      if (special?.match.test(a)) {
        settings.set(key, special.value)
        return say(`${emoji} ${label} : *${show(special.value)}* ✅${special.note ? `\n${special.note}` : ''}`)
      }
      const valid = float ? /^\d+(\.\d+)?$/.test(a) : /^\d+$/.test(a)
      const n = float ? Number(a) : Number.parseInt(a, 10)
      if (!valid || !Number.isFinite(n) || n < min || n > max) {
        if (pending) bot.setPending(menuChat, { ...pending })
        const or = special ? ` (ou « ${special.word} »)` : ''
        return say(`❌ Valeur invalide : choisis un nombre entre ${min} et ${max}${or}.${pending ? ' Réessaie (ou *annuler*).' : ''}`)
      }
      settings.set(key, float ? Math.round(n * 100) / 100 : n)
      return say(`${emoji} ${label} : *${show(settings.get(key))}* ✅`)
    }
  }

  const temperature = numberSetting('temperature', {
    cmd: 'temp',
    emoji: '🌡️',
    label: 'Température (créativité)',
    min: 0,
    max: 2,
    float: true,
    hint: '0 = précis et constant • 0.7 = équilibré • 1.2+ = très créatif',
  })
  const tokens = numberSetting('maxTokens', {
    cmd: 'tokens',
    emoji: '📏',
    label: 'Longueur max des réponses',
    min: 64,
    max: 8192,
    show: tokensText,
    hint: '1 token ≈ 0,75 mot.',
    special: {
      word: 'illimite',
      match: /^(0|illimit[a-zé]*|infini[a-z]*|unlimited|sans ?limites?|aucune|max|∞)$/i,
      value: 0,
      note: "Plus de limite imposée par le bot : le modèle écrit jusqu'à sa propre limite. Les longues réponses arrivent en plusieurs messages.",
    },
  })
  const memorySize = numberSetting('memory', {
    cmd: 'memoire',
    emoji: '🧩',
    label: 'Mémoire',
    min: 2,
    max: 500,
    unit: ' messages',
    hint: "Nombre de messages récents dont l'IA se souvient dans chaque discussion.",
  })
  const delay = numberSetting('replyDelay', {
    cmd: 'delai',
    emoji: '⏱️',
    label: 'Délai avant réponse',
    min: 0,
    max: 120,
    unit: ' s',
    hint: "J'attends ce délai pour regrouper les messages envoyés à la suite.",
  })

  // ---------- interrupteurs ----------

  function switchSetting(key, { emoji, label, on: onText, off: offText }) {
    const text = (x) => (typeof x === 'function' ? x() : x)
    return async ({ arg, say }) => {
      const a = String(arg || '').trim()
      const v = parseSwitch(a)
      if (v === null && a) return say('❌ Réponds par *on* ou *off*.')
      const next = v === null ? !settings.get(key) : v
      settings.set(key, next)
      return say(`${emoji} ${label} : *${next ? 'activé ✅' : 'désactivé ⛔'}*\n${text(next ? onText : offText)}`)
    }
  }

  const signature = switchSetting('signature', {
    emoji: '✍️',
    label: 'Signature',
    on: () => `Les réponses de l'assistant finissent par « — ${settings.get('botName')} 🤖 ».`,
    off: "Les réponses de l'assistant n'ont plus de signature.",
  })
  const discreet = switchSetting('discreet', {
    emoji: '🕶️',
    label: 'Mode discret',
    on: 'Tes commandes sont effacées de la discussion et mes réponses arrivent dans ta discussion perso (« Moi »).',
    off: "Mes réponses aux commandes s'affichent dans la discussion où tu les tapes (visibles par tous).",
  })
  const reasoning = switchSetting('reasoning', {
    emoji: '🧠',
    label: 'Mode réflexion',
    on: 'Les modèles compatibles réfléchissent avant de répondre (plus lent, parfois plus juste).',
    off: 'Réponses directes et rapides.',
  })

  async function groups({ arg, say, menuChat, pending }) {
    const a = String(arg || '').trim().toLowerCase()
    const describeMode = (v) => (v === 'all' ? 'à *tous* les messages' : 'seulement quand on te *mentionne* ou te répond')
    if (!a) return say(`👥 En groupe, je réponds ${describeMode(settings.get('groupMode'))}.\n👉 *${P}groupes tout* ou *${P}groupes mention*`)
    const map = { all: 'all', tout: 'all', tous: 'all', 1: 'all', mention: 'mention', mentions: 'mention', tag: 'mention', 2: 'mention' }
    const v = map[a]
    if (!v) {
      if (pending) bot.setPending(menuChat, { ...pending })
      return say('❌ Choisis *tout* (1) ou *mention* (2).')
    }
    settings.set('groupMode', v)
    return say(`👥 En groupe, je réponds maintenant ${describeMode(v)} ✅`)
  }

  // ---------- outils ----------

  async function resetMemory({ t, arg, say }) {
    if (/^(all|tout|toutes)$/i.test(String(arg || '').trim())) {
      memory.clearAll()
      return say('🧹 Mémoire de *toutes* les discussions effacée.')
    }
    for (const id of new Set([t.chat, ...t.ids])) memory.clear(id)
    return say('🧹 Mémoire de cette discussion effacée.')
  }

  async function test({ arg, say }) {
    if (!ai.client.configured) return say("❌ NVIDIA_API_KEY manquante : ajoute ta clé dans les variables d'environnement de Render.")
    const q = String(arg || '').trim()
    await say(`🧪 Test de *${settings.get('model')}*…`)
    const t0 = Date.now()
    const r = q ? await ai.ask(q, { ownerName: bot.ownerName() }) : await ai.test({ ownerName: bot.ownerName() })
    return say(`✅ Réponse en ${((Date.now() - t0) / 1000).toFixed(1)} s :\n\n${r.text}`, r.files)
  }

  async function ask({ t, arg, say, sayHere, ctx }) {
    const q = String(arg || '').trim()
    if (!q) return say(`❓ *${P}ask <question>* : l'IA répond directement dans cette discussion.`)
    await wa.presence(t.chat, 'composing')
    const gear = await bot.react(ctx, '⚙️')
    try {
      const r = await ai.ask(q, { ownerName: bot.ownerName() })
      return await (sayHere || say)(r.text, r.files)
    } finally {
      if (gear) await bot.react(ctx, '')
      await wa.presence(t.chat, 'paused')
    }
  }

  /** .vision : l'IA regarde les images reçues (description par un modèle de vision). */
  async function vision({ arg, say }) {
    const a = String(arg || '').trim()
    const show = () => `👁️ Vision (images) : *${settings.get('vision') ? 'activée ✅' : 'désactivée ⛔'}*\nModèle de vision : *${settings.get('visionModel')}*`
    if (!a) {
      return say(`${show()}\n👉 *${P}vision on/off* • *${P}vision <modèle>* pour changer (il doit accepter les images) • *${P}vision reset*`)
    }
    const sw = parseSwitch(a)
    if (sw !== null) {
      settings.set('vision', sw)
      return say(`${show()}\n${sw ? "Je regarde les images reçues avant de répondre." : 'Les images restent de simples « [image] » pour l’IA.'}`)
    }
    if (a.toLowerCase() === 'reset') {
      settings.update({ visionModel: DEFAULT_SETTINGS().visionModel, vision: true })
      return say(show())
    }
    let id = a
    if (!a.includes('/')) {
      const found = (await ai.client.listModels()).filter((m) => m.toLowerCase().includes(a.toLowerCase()))
      if (!found.length) return say(`🔎 Aucun modèle ne contient « ${a} ».`)
      if (found.length > 1) return say(`🔎 Plusieurs modèles correspondent :\n${found.slice(0, 15).map((m) => `- ${m}`).join('\n')}\n👉 *${P}vision <nom complet>*`)
      id = found[0]
    }
    settings.update({ visionModel: id, vision: true })
    return say(show())
  }

  async function session({ t, say }) {
    const id = wa.exportSession()
    const self = wa.selfJid()
    if (!id || !self) return say('❌ Aucune session active.')
    await wa.send(self, {
      text: '🔑 *Ton SESSION_ID* — garde-le secret, il donne accès à ton WhatsApp.\nColle-le dans la variable *SESSION_ID* de ton service Render (message suivant) :',
    })
    await wa.send(self, { text: id })
    if (!t.self && !settings.get('discreet')) return say("🔑 Je t'ai envoyé ton SESSION_ID dans ta discussion perso (« Moi »).")
  }

  async function status({ say }) {
    const s = settings.all()
    const { ai: a, meai: m, aai: x } = bot.activeList()
    const st = wa.publicStatus()
    return say(
      [
        `📊 *Statut de ${s.botName}*`,
        `- WhatsApp : ${st.connected ? 'connecté ✅' : st.status}${wa.me?.number ? ` (+${wa.me.number})` : ''}`,
        `- Modèle : ${s.model}`,
        `- Clé NVIDIA : ${ai.client.configured ? 'configurée ✅' : 'manquante ❌'}`,
        `- Discussions actives : ${a.length} assistant • ${m.length} à ta place • ${x.length} avec ${P}aai`,
        `- Conversations en mémoire : ${memory.count()}`,
        `- Stockage : ${bot.kv.kind === 'mongodb' ? 'MongoDB ✅' : 'fichier local (sans base de données : réglages remis à zéro à chaque redémarrage, la session revient grâce au SESSION_ID)'}`,
        `- En ligne depuis : ${formatDuration(Date.now() - bot.startedAt)}`,
        `- Musique/vidéo : ${mediaCmds.statusText()}`,
        `- Node ${process.version} • RAM ${Math.round(process.memoryUsage().rss / 1048576)} Mo`,
      ].join('\n'),
    )
  }

  async function showSettings({ say }) {
    const s = settings.all()
    return say(
      [
        '⚙️ *Réglages*',
        `- Nom du bot : ${s.botName}`,
        `- Ton prénom : ${s.ownerName || `_(profil WhatsApp : ${wa.me?.name || '?'})_`}`,
        `- Modèle : ${s.model}`,
        `- Vision (images) : ${s.vision ? s.visionModel : 'désactivée'}`,
        `- Personnalité : ${s.personality}`,
        `- Consignes perso : ${s.customPrompt ? s.customPrompt.slice(0, 200) : '_aucune_'}`,
        `- Température : ${s.temperature}`,
        `- Longueur max : ${tokensText(s.maxTokens)}`,
        `- Mémoire : ${s.memory} messages`,
        `- Délai : ${s.replyDelay} s`,
        `- Groupes : ${s.groupMode === 'all' ? 'répond à tout' : 'seulement si mentionné'}`,
        `- Signature : ${s.signature ? 'oui' : 'non'}`,
        `- Mode discret : ${s.discreet ? 'oui' : 'non'}`,
        `- Mode réflexion : ${s.reasoning ? 'oui' : 'non'}`,
        `- Préfixe des commandes : ${P}`,
      ].join('\n'),
    )
  }

  async function factoryReset({ say }) {
    settings.reset()
    return say('♻️ Réglages remis par défaut (les discussions actives sont conservées).')
  }

  async function ping({ say }) {
    return say(`🏓 Pong ! En ligne depuis ${formatDuration(Date.now() - bot.startedAt)}.`)
  }

  // ---------- aide ----------

  // Une entrée par commande : résumé pour .help, détail et exemples pour .help <commande>
  const HELP_CATS = [
    ['ia', '🤖 IA dans une discussion'],
    ['modele', '🧠 Modèle & capacités'],
    ['perso', '🎨 Personnalisation'],
    ['reglages', '⚙️ Réglages'],
    ['media', '🎵 Musique & vidéos (ouvert à tous)'],
    ['compte', '🔑 Compte'],
  ]
  const HELP = [
    { cat: 'ia', cmd: 'ai', args: '[on/off]', short: "l'assistant IA répond aux messages reçus ici", detail: "L'assistant IA répond aux messages reçus dans cette discussion, en se présentant comme ton assistant. Dans « Moi », c'est ton IA privée.", examples: ['ai', 'ai off'] },
    { cat: 'ia', cmd: 'meai', args: '[on/off]', short: "l'IA répond à ta place, avec ton style", detail: "L'IA répond comme toi, en imitant ton style. Si tu réponds toi-même avant elle, elle se tait. Remplace .ai dans cette discussion.", examples: ['meai', 'meai off'] },
    { cat: 'ia', cmd: 'aai', args: '[on/off]', short: "l'IA te répond aussi à toi ici", detail: "L'IA répond aussi à TES messages dans cette discussion (privée ou groupe), en les citant. Il faut d'abord .ai ou .meai.", examples: ['aai', 'aai off'] },
    { cat: 'ia', cmd: 'stop', short: "coupe l'IA dans cette discussion", detail: 'Désactive .ai, .meai et .aai dans cette discussion.' },
    { cat: 'ia', cmd: 'stopall', short: "coupe l'IA partout", detail: "Désactive l'IA dans toutes les discussions." },
    { cat: 'ia', cmd: 'actifs', short: "discussions où l'IA est active" },
    { cat: 'ia', cmd: 'ask', args: '<question>', short: 'question directe, réponse dans la discussion', detail: "L'IA répond à ta question directement dans cette discussion (visible par tous). Elle peut aussi envoyer un fichier.", examples: ['ask résume la Révolution française', 'ask fais-moi un CV en page html'] },
    { cat: 'ia', cmd: 'reset', args: '[tout]', short: 'efface la mémoire de cette discussion', detail: "L'IA oublie la conversation ici ; *tout* : dans toutes les discussions.", examples: ['reset', 'reset tout'] },
    { cat: 'modele', cmd: 'models', args: '[page ou mot]', short: 'liste des modèles NVIDIA', detail: 'Liste des modèles NVIDIA par pages de 15, ou recherche par mot.', examples: ['models', 'models 2', 'models llama'] },
    { cat: 'modele', cmd: 'model', args: '<numéro ou nom>', short: 'choisir le modèle', detail: "Change le modèle de l'IA. Il est testé tout de suite ; s'il ne marche pas, l'ancien revient.", examples: ['model 3', 'model deepseek'] },
    { cat: 'modele', cmd: 'vision', args: '[on/off ou modèle]', short: "l'IA regarde les images reçues", detail: "Quand on envoie une photo, un modèle de vision la décrit à l'IA, qui peut y réagir et s'en souvenir. *vision <modèle>* change ce modèle, *vision reset* remet celui par défaut.", examples: ['vision', 'vision off', 'vision llama-3.2-90b-vision'] },
    { cat: 'modele', cmd: 'reflexion', args: '[on/off]', short: 'réfléchir avant de répondre (plus lent)', detail: 'Les modèles compatibles réfléchissent avant de répondre : plus lent, parfois plus juste.' },
    { cat: 'modele', cmd: 'test', args: '[question]', short: "tester l'IA et son temps de réponse", examples: ['test', 'test Combien font 17 × 23 ?'] },
    { cat: 'perso', cmd: 'perso', args: '<texte>', short: "personnalité de l'IA", examples: ['perso sarcastique mais bienveillant', 'perso reset'] },
    { cat: 'perso', cmd: 'prompt', args: '<texte>', short: "consignes perso (qui tu es, ta façon d'écrire…)", examples: ['prompt Je suis étudiant à Lyon, tutoie tout le monde', 'prompt reset'] },
    { cat: 'perso', cmd: 'owner', args: '<prénom>', short: "ton prénom, utilisé par l'IA", examples: ['owner Alex'] },
    { cat: 'perso', cmd: 'nom', args: '<nom>', short: 'nom du bot', examples: ['nom Nova'] },
    { cat: 'reglages', cmd: 'temp', args: '<0-2>', short: 'créativité des réponses', detail: '0 = précis et constant • 0.7 = équilibré • 1.2+ = très créatif.', examples: ['temp 0.7'] },
    { cat: 'reglages', cmd: 'tokens', args: '<64-8192 ou illimite>', short: 'longueur max des réponses', detail: "1 token ≈ 0,75 mot. *illimite* (ou 0) : plus de limite, le modèle s'arrête à sa propre limite et les longues réponses arrivent en plusieurs messages. Augmente-la pour les gros fichiers.", examples: ['tokens 2048', 'tokens illimite'] },
    { cat: 'reglages', cmd: 'memoire', args: '<2-500>', short: 'messages retenus par discussion', examples: ['memoire 30'] },
    { cat: 'reglages', cmd: 'delai', args: '<0-120>', short: "secondes d'attente avant de répondre", detail: "J'attends ce délai pour regrouper les messages envoyés à la suite.", examples: ['delai 5'] },
    { cat: 'reglages', cmd: 'groupes', args: 'tout/mention', short: 'en groupe : répondre à tout, ou seulement si on te mentionne', examples: ['groupes mention'] },
    { cat: 'reglages', cmd: 'discret', args: '[on/off]', short: 'efface tes commandes et répond dans « Moi »' },
    { cat: 'reglages', cmd: 'signature', args: '[on/off]', short: "signe les réponses de l'assistant" },
    { cat: 'reglages', cmd: 'reglages', short: 'voir tous les réglages' },
    { cat: 'reglages', cmd: 'reinit', short: 'remettre les réglages par défaut', detail: 'Les discussions actives sont conservées.' },
    { cat: 'media', cmd: 'song', args: '<titre ou lien>', short: 'musique : MP3 (fichier) ou audio WhatsApp', detail: 'Envoie la miniature, puis réponds *1* (MP3 en fichier) ou *2* (audio WhatsApp). Tes contacts peuvent aussi l’utiliser.', examples: ['song bababoy'] },
    { cat: 'media', cmd: 'video', args: '<titre ou lien>', short: 'vidéo : MP4 (fichier) ou vidéo WhatsApp', detail: 'Envoie la miniature, puis réponds *1* (MP4 en fichier) ou *2* (vidéo WhatsApp). Tes contacts peuvent aussi l’utiliser.', examples: ['video daft punk around the world'] },
    { cat: 'compte', cmd: 'statut', short: 'état du bot' },
    { cat: 'compte', cmd: 'session', short: 'recevoir ton SESSION_ID dans « Moi »', detail: 'Garde-le secret : il donne accès à ton WhatsApp.' },
    { cat: 'compte', cmd: 'ping', short: 'vérifier que le bot répond' },
    { cat: 'compte', cmd: 'menu', short: 'menu numéroté (tout régler avec des numéros)' },
    { cat: 'compte', cmd: 'help', args: '[commande]', short: "cette aide, ou le détail d'une commande", examples: ['help', 'help tokens'] },
  ]
  const usage = (h) => `*${P}${h.cmd}*${h.args ? ` ${h.args}` : ''}`

  /** .help <commande> : détail, exemples et autres noms d'une commande. */
  function commandHelp(query) {
    const name = query.startsWith(P) ? query.slice(P.length) : query
    const fn = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null
    const entry = fn && HELP.find((h) => COMMANDS[h.cmd] === fn)
    if (!entry) {
      const close = HELP.filter((h) => name && (h.cmd.includes(name) || name.includes(h.cmd))).map((h) => `*${P}${h.cmd}*`)
      return `❓ Je ne connais pas « ${query} ».${close.length ? ` Tu cherches peut-être ${close.slice(0, 3).join(', ')} ?` : ''}\n👉 *${P}help* pour toutes les commandes.`
    }
    const aliases = Object.keys(COMMANDS).filter((k) => k !== entry.cmd && COMMANDS[k] === fn)
    const detail = entry.detail || `${entry.short.charAt(0).toUpperCase()}${entry.short.slice(1)}.`
    return [
      `📖 ${usage(entry)}`,
      detail,
      entry.examples?.length ? `\n*Exemples*\n${entry.examples.map((e) => `- ${P}${e}`).join('\n')}` : '',
      aliases.length ? `\n_Autres noms : ${aliases.map((x) => P + x).join(', ')}_` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  /** .help : toutes les commandes par thème ; .help <commande> : le détail. */
  async function commandList({ arg, say }) {
    const query = String(arg || '').trim().toLowerCase()
    if (query) return say(commandHelp(query))
    const lines = [`📖 *Aide de ${settings.get('botName')}*`, '_Commandes réservées à toi, sauf 🎵 (ouvertes à tous)._']
    for (const [cat, title] of HELP_CATS) {
      lines.push('', `*${title}*`, ...HELP.filter((h) => h.cat === cat).map((h) => `${usage(h)} — ${h.short}`))
    }
    lines.push(
      '',
      '💡 *Bon à savoir*',
      settings.get('vision')
        ? "- Envoie une photo : l'IA la voit et peut en parler."
        : `- La vision est coupée : *${P}vision on* pour que l'IA voie les photos.`,
      "- Demande un fichier (.html, .txt, .csv…) : l'IA l'envoie en pièce jointe.",
      `- *${P}help <commande>* : détail et exemples (ex : *${P}help tokens*).`,
      `- *${P}menu* : tout régler en répondant par des numéros.`,
    )
    return say(lines.join('\n'))
  }

  // ---------- menu numéroté ----------

  const ZERO_IS_VALUE = new Set(['temp', 'delai', 'tokens']) // étapes où « 0 » est une vraie valeur (tokens : 0 = illimité)
  const CANCEL = /^(annuler|cancel|x)$/i
  const yes = (v) => (v ? '✅' : '⛔')
  const cut = (s, n = 28) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
  const onOff = (v) => (v ? 'activé' : 'désactivé')

  /** Question d'une option du menu : la réponse revient dans STEPS[step], puis le menu se rouvre. */
  function askFor(a, step, text) {
    bot.setPending(a.menuChat, { step, target: a.t, menu: true })
    return a.say(`${text}\n\n_Réponds *${ZERO_IS_VALUE.has(step) ? 'annuler' : '0'}* pour revenir au menu._`)
  }

  async function chooseModel(a) {
    const list = await ai.client.listModels()
    modelList = list
    bot.setPending(a.menuChat, { step: 'model', target: a.t, page: 1, list, query: '', menu: true })
    return a.say(renderModelPage(list, 1, '', MODEL_FOOTER))
  }

  // Les numéros suivent l'ordre d'affichage ; value = état actuel montré dans le menu
  const MENU_SECTIONS = [
    [
      '🤖 IA dans cette discussion',
      [
        { icon: '🤖', label: 'Assistant IA', value: (t) => yes(settings.isActive('ai', t.ids)), run: (a) => toggleMode(a, 'ai') },
        { icon: '🪞', label: 'Répondre à ma place', value: (t) => yes(settings.isActive('meai', t.ids)), run: (a) => toggleMode(a, 'meai') },
        { icon: '🙋', label: 'Me répondre aussi', value: (t) => yes(settings.isActive('aai', t.ids)), run: toggleAai },
        { icon: '🛑', label: "Couper l'IA ici", run: stopHere },
        {
          icon: '📋',
          label: 'Discussions actives',
          value: () => {
            const { ai: x, meai: y } = bot.activeList()
            return String(new Set([...x, ...y]).size)
          },
          run: listActive,
        },
      ],
    ],
    [
      '🧠 Intelligence',
      [
        { icon: '🧠', label: 'Modèle', value: () => `_${cut(String(settings.get('model')).split('/').pop(), 32)}_`, run: chooseModel },
        {
          icon: '👁️',
          label: 'Vision des images',
          value: () => yes(settings.get('vision')),
          run: (a) =>
            askFor(
              a,
              'vision',
              `👁️ Vision : *${onOff(settings.get('vision'))}* • modèle : *${settings.get('visionModel')}*\n\n*1.* Activer\n*2.* Désactiver\n*3.* Modèle par défaut\nOu envoie le nom d'un modèle qui accepte les images (ex : llama-3.2-90b-vision).`,
            ),
        },
        { icon: '💭', label: 'Mode réflexion', value: () => yes(settings.get('reasoning')), run: reasoning },
        { icon: '🧪', label: "Tester l'IA", run: test },
      ],
    ],
    [
      '🎨 Personnalisation',
      [
        {
          icon: '🎭',
          label: 'Personnalité',
          value: () => `_${cut(settings.get('personality'))}_`,
          run: (a) => askFor(a, 'perso', `🎭 Personnalité actuelle : _${settings.get('personality')}_\n\nEnvoie la nouvelle personnalité (ex : « sarcastique mais bienveillant »), ou *reset*.`),
        },
        {
          icon: '📝',
          label: 'Consignes perso',
          value: () => (settings.get('customPrompt') ? `_${cut(settings.get('customPrompt'))}_` : '_aucune_'),
          run: (a) => {
            const current = settings.get('customPrompt')
            return askFor(a, 'prompt', `📝 Consignes actuelles : ${current ? `_${current}_` : '_aucune_'}\n\nEnvoie tes consignes (ex : « Je suis étudiant à Lyon, tutoie tout le monde »), ou *reset* pour les effacer.`)
          },
        },
        {
          icon: '👤',
          label: 'Ton prénom',
          value: () => `_${bot.ownerName() || '?'}_`,
          run: (a) => askFor(a, 'owner', `👤 Prénom actuel : *${bot.ownerName() || '?'}*\n\nEnvoie ton prénom (l'IA l'utilise pour parler de toi et à ta place).`),
        },
        {
          icon: '🏷️',
          label: 'Nom du bot',
          value: () => `_${settings.get('botName')}_`,
          run: (a) => askFor(a, 'nom', `🏷️ Nom actuel du bot : *${settings.get('botName')}*\n\nEnvoie le nouveau nom.`),
        },
      ],
    ],
    [
      '⚙️ Réglages',
      [
        {
          icon: '🌡️',
          label: 'Créativité',
          value: () => `_${settings.get('temperature')}_`,
          run: (a) => askFor(a, 'temp', `🌡️ Température actuelle : *${settings.get('temperature')}*\n\nEnvoie un nombre entre 0 et 2 (0 = précis • 0.7 = équilibré • 1.2 = très créatif).`),
        },
        {
          icon: '📏',
          label: 'Longueur max',
          value: () => `_${tokensText(settings.get('maxTokens'))}_`,
          run: (a) =>
            askFor(a, 'tokens', `📏 Longueur max actuelle : *${tokensText(settings.get('maxTokens'))}*\n\nEnvoie un nombre entre 64 et 8192 (1 token ≈ 0,75 mot), ou *illimite* (ou *0*) pour ne plus limiter.`),
        },
        {
          icon: '🧩',
          label: 'Mémoire',
          value: () => `_${settings.get('memory')} messages_`,
          run: (a) => askFor(a, 'memoire', `🧩 Mémoire actuelle : *${settings.get('memory')} messages*\n\nEnvoie un nombre entre 2 et 500.`),
        },
        {
          icon: '⏱️',
          label: 'Délai avant réponse',
          value: () => `_${settings.get('replyDelay')} s_`,
          run: (a) => askFor(a, 'delai', `⏱️ Délai actuel : *${settings.get('replyDelay')} s*\n\nEnvoie un nombre de secondes entre 0 et 120.`),
        },
        {
          icon: '👥',
          label: 'En groupe',
          value: () => (settings.get('groupMode') === 'all' ? '_répond à tout_' : '_si mentionné_'),
          run: (a) =>
            askFor(
              a,
              'groupes',
              `👥 En groupe, je réponds actuellement ${settings.get('groupMode') === 'all' ? 'à *tous* les messages' : 'seulement quand on te *mentionne*'}.\n\n*1.* Répondre à tous les messages\n*2.* Seulement quand on te mentionne ou te répond`,
            ),
        },
        {
          icon: '🕶️',
          label: 'Discret / signature',
          value: () => `${yes(settings.get('discreet'))} / ${yes(settings.get('signature'))}`,
          run: (a) =>
            askFor(
              a,
              'discret',
              `🕶️ Mode discret : *${onOff(settings.get('discreet'))}* • ✍️ Signature : *${onOff(settings.get('signature'))}*\n\n*1.* Activer le mode discret\n*2.* Désactiver le mode discret\n*3.* Activer la signature\n*4.* Désactiver la signature`,
            ),
        },
      ],
    ],
    [
      '🔧 Outils',
      [
        { icon: '🧹', label: 'Effacer la mémoire ici', run: resetMemory },
        {
          icon: '📊',
          label: 'Statut & SESSION_ID',
          run: async (a) => {
            await status(a)
            return session(a)
          },
        },
      ],
    ],
  ]
  const MENU_ITEMS = MENU_SECTIONS.flatMap(([, items]) => items)
  const MENU = [...MENU_ITEMS.map((it, i) => [i + 1, it.icon, it.label]), [0, '❌', 'Fermer le menu']]

  function menuText(t) {
    const lines = [`📋 *Menu de ${settings.get('botName')}*`, `📍 Discussion : _${bot.label(t.chat)}_`]
    let n = 0
    for (const [title, items] of MENU_SECTIONS) {
      lines.push('', `*${title}*`)
      for (const it of items) {
        const v = it.value?.(t)
        lines.push(`*${++n}.* ${it.icon} ${it.label}${v ? ` — ${v}` : ''}`)
      }
    }
    lines.push('', '*0.* ❌ Fermer le menu', '', '_Réponds avec un numéro. Le menu reste ouvert : enchaîne les numéros, *menu* pour le revoir, *0* pour le fermer._')
    return lines.join('\n')
  }

  async function menu({ t, say, sayRaw, menuChat }) {
    bot.setPending(menuChat, { step: 'menu', target: t })
    return (sayRaw || say)(menuText(t))
  }

  async function runMenuItem(n, a) {
    if (n === 0) return a.say('👋 Menu fermé.')
    const item = MENU_ITEMS[n - 1]
    if (!item) {
      bot.setPending(a.menuChat, { step: 'menu', target: a.t })
      return a.say(`❌ Choisis un numéro entre 0 et ${MENU_ITEMS.length} (*menu* pour revoir la liste).`)
    }
    return item.run({ ...a, arg: '', pending: null })
  }

  /** Réponses aux questions du menu (le texte que tu envoies après avoir choisi un numéro). */
  const STEPS = {
    ...mediaCmds.STEPS,
    perso: personality,
    prompt: customPrompt,
    owner: ownerNameCmd,
    nom: botNameCmd,
    temp: temperature,
    tokens,
    memoire: memorySize,
    delai: delay,
    groupes: groups,
    async discret(a) {
      const choice = { 1: [discreet, 'on'], 2: [discreet, 'off'], 3: [signature, 'on'], 4: [signature, 'off'] }[a.arg.trim()]
      if (!choice) {
        bot.setPending(a.menuChat, { ...a.pending })
        return a.say('❌ Réponds *1*, *2*, *3* ou *4* (*0* pour annuler).')
      }
      return choice[0]({ ...a, arg: choice[1] })
    },
    async vision(a) {
      const input = a.arg.trim()
      const choice = { 1: 'on', 2: 'off', 3: 'reset' }[input]
      if (!choice && /^\d+$/.test(input)) {
        bot.setPending(a.menuChat, { ...a.pending })
        return a.say("❌ Réponds *1*, *2*, *3* ou le nom d'un modèle (*0* pour revenir au menu).")
      }
      return vision({ ...a, arg: choice || input })
    },
    async model(a) {
      const input = a.arg.trim()
      const state = a.pending
      const list = state.list?.length ? state.list : modelList
      if (/^\d+$/.test(input)) {
        const id = list[Number.parseInt(input, 10) - 1]
        if (!id) {
          bot.setPending(a.menuChat, { ...state })
          return a.say('❌ Numéro invalide, réessaie (*0* pour annuler).')
        }
        return applyModel(id, a.say)
      }
      if (/^(\+|>|s|suivant|suite|next)$/i.test(input)) {
        const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
        const page = ((state.page || 1) % pages) + 1
        bot.setPending(a.menuChat, { ...state, page })
        return a.say(renderModelPage(list, page, state.query, MODEL_FOOTER))
      }
      if (input.includes('/')) return applyModel(input, a.say)
      const all = await ai.client.listModels()
      const found = all.filter((id) => id.toLowerCase().includes(input.toLowerCase()))
      if (!found.length) {
        bot.setPending(a.menuChat, { ...state })
        return a.say(`🔎 Aucun modèle ne contient « ${input} ». Essaie un autre mot (*0* pour annuler).`)
      }
      modelList = found
      bot.setPending(a.menuChat, { step: 'model', target: a.t, page: 1, list: found, query: input, menu: state.menu })
      return a.say(renderModelPage(found, 1, input, MODEL_FOOTER))
    },
  }

  async function handlePending(ctx, pending, key = ctx.chat) {
    const input = String(ctx.text || '').trim()
    const menuChat = ctx.chat
    const say = (text) => wa.send(menuChat, { text }).catch((err) => bot.log.warn({ err: err?.message }, 'Envoi impossible'))
    if (mediaCmds.isStep(pending.step) && !mediaCmds.accepts(pending, input) && !CANCEL.test(input) && !/^\d{1,2}$/.test(input)) {
      bot.clearPending(key)
      return false // message normal : le choix du format se ferme et le message est traité normalement
    }
    if (pending.step === 'menu' && !/^\d{1,2}$/.test(input)) {
      if (/^menu$/i.test(input)) {
        bot.setPending(key, { ...pending })
        await say(menuText(pending.target))
        return true
      }
      bot.clearPending(key)
      if (CANCEL.test(input)) {
        await say('👋 Menu fermé.')
        return true
      }
      return false // message normal : le menu se ferme et le message est traité normalement
    }
    bot.clearPending(key)
    const backToMenu = () => bot.setPending(key, { step: 'menu', target: pending.target })
    if (CANCEL.test(input) || (input === '0' && pending.step !== 'menu' && !ZERO_IS_VALUE.has(pending.step))) {
      if (!pending.menu) {
        await say('❎ Annulé.')
        return true
      }
      backToMenu()
      await say('❎ Annulé. Le menu est toujours ouvert : envoie un numéro (*menu* pour le revoir, *0* pour le fermer).')
      return true
    }
    const a = { t: pending.target, arg: input, say, sayHere: say, sayRaw: say, menuChat, pending, pendingKey: key }
    try {
      if (pending.step === 'menu') await runMenuItem(Number.parseInt(input, 10), a)
      else if (STEPS[pending.step]) await STEPS[pending.step](a)
      else return false
    } catch (err) {
      bot.log.error({ err: err?.message, step: pending.step }, 'Erreur du menu')
      await say(`⚠️ ${err?.message || err}`)
    }
    // Le menu reste ouvert pour enchaîner les réglages (sauf « 0 » ou si une autre question attend sa réponse)
    const fromMenu = pending.step === 'menu' ? input !== '0' : !!pending.menu
    if (fromMenu && !bot.getPending(key)) backToMenu()
    return true
  }

  // ---------- commandes tapées ----------

  const aiCmd = (a) => toggleMode(a, 'ai')
  const COMMANDS = {
    menu,
    help: commandList,
    aide: commandList,
    commandes: commandList,
    cmds: commandList,
    commands: commandList,
    ai: aiCmd,
    ia: aiCmd,
    meai: (a) => toggleMode(a, 'meai'),
    aai: toggleAai,
    stop: stopHere,
    stopall: stopAll,
    actifs: listActive,
    actives: listActive,
    liste: listActive,
    list: listActive,
    models: listModels,
    modeles: listModels,
    'modèles': listModels,
    model: setModel,
    modele: setModel,
    'modèle': setModel,
    perso: personality,
    personnalite: personality,
    'personnalité': personality,
    prompt: customPrompt,
    consignes: customPrompt,
    owner: ownerNameCmd,
    proprio: ownerNameCmd,
    prenom: ownerNameCmd,
    'prénom': ownerNameCmd,
    nom: botNameCmd,
    name: botNameCmd,
    temp: temperature,
    temperature,
    'température': temperature,
    tokens,
    memoire: memorySize,
    'mémoire': memorySize,
    memory: memorySize,
    delai: delay,
    'délai': delay,
    delay,
    groupes: groups,
    groupe: groups,
    groups,
    signature,
    discret: discreet,
    discreet,
    reflexion: reasoning,
    'réflexion': reasoning,
    raisonnement: reasoning,
    reasoning,
    think: reasoning,
    vision,
    images: vision,
    reset: resetMemory,
    oublie: resetMemory,
    test,
    ask,
    q: ask,
    question: ask,
    session,
    statut: status,
    status,
    reglages: showSettings,
    'réglages': showSettings,
    settings: showSettings,
    config: showSettings,
    reinit: factoryReset,
    'réinit': factoryReset,
    factory: factoryReset,
    ping,
    ...mediaCmds.COMMANDS,
  }

  async function run(ctx) {
    const body = String(ctx.text || '').slice(P.length).trim()
    const name = (body.split(/\s+/)[0] || '').toLowerCase()
    const fn = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null
    if (!fn) return false
    const arg = body.slice(name.length).trim()
    const menuChat = bot.replyChat(ctx)
    bot.clearPending(menuChat) // une nouvelle commande annule le menu en cours
    if (settings.get('discreet') && !ctx.self) {
      Promise.resolve()
        .then(() => wa.deleteForEveryone(ctx.chat, ctx.key))
        .catch(() => {})
    }
    const a = {
      t: { chat: ctx.chat, ids: ctx.ids, isGroup: ctx.isGroup, self: ctx.self },
      arg,
      say: (text, files) => bot.reply(ctx, text, { files }),
      sayHere: (text, files) => bot.reply(ctx, text, { here: true, files }),
      sayRaw: (text) => wa.send(menuChat, { text }).catch(() => {}),
      menuChat,
      pending: null,
      ctx,
    }
    try {
      await fn(a)
    } catch (err) {
      bot.log.error({ err: err?.message, cmd: name }, 'Erreur de commande')
      await a.say(`⚠️ ${err?.message || err}`)
    }
    return true
  }

  /** .song / .video : ouverts à tout le monde, sans toucher aux autres commandes (réservées au propriétaire). */
  async function runPublic(ctx) {
    const body = String(ctx.text || '').slice(P.length).trim()
    const name = (body.split(/\s+/)[0] || '').toLowerCase()
    if (!PUBLIC_COMMANDS.has(name)) return false
    const arg = body.slice(name.length).trim()
    const menuChat = ctx.chat
    const pendingKey = publicPendingKey(ctx)
    bot.clearPending(pendingKey)
    const a = {
      t: { chat: ctx.chat, ids: ctx.ids, isGroup: ctx.isGroup, self: ctx.self },
      arg,
      say: (text) => bot.reply(ctx, text, { here: true }),
      sayHere: (text) => bot.reply(ctx, text, { here: true }),
      sayRaw: (text) => wa.send(menuChat, { text }).catch(() => {}),
      menuChat,
      pendingKey,
      pending: null,
      ctx,
    }
    try {
      await mediaCmds.COMMANDS[name](a)
    } catch (err) {
      bot.log.error({ err: err?.message, cmd: name }, 'Erreur de commande publique')
      await a.say(`⚠️ ${err?.message || err}`)
    }
    return true
  }

  async function handlePublicPending(ctx, pending, key) {
    if (!mediaCmds.isStep(pending?.step)) return false
    return handlePending(ctx, pending, key)
  }

  return {
    run,
    runPublic,
    handlePending,
    handlePublicPending,
    publicPendingKey,
    handleReply: mediaCmds.handleReply,
    mediaIdle: mediaCmds.idle,
    COMMANDS,
    MENU,
    HELP,
  }
}
