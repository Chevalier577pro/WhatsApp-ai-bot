import { DEFAULT_SETTINGS } from '../settings.js'

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
    bot.cancel(t.chat)
    return say('⛔ IA désactivée dans cette discussion.')
  }

  async function stopAll({ say }) {
    settings.clearMode('ai')
    settings.clearMode('meai')
    bot.cancelAll()
    return say('⛔ IA désactivée dans *toutes* les discussions.')
  }

  async function listActive({ say }) {
    const { ai: aiChats, meai: meaiChats } = bot.activeList()
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
      ].join('\n'),
    )
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

  function numberSetting(key, { cmd, emoji, label, min, max, unit = '', float = false, hint = '' }) {
    return async ({ arg, say, menuChat, pending }) => {
      const a = String(arg || '').trim().replace(',', '.')
      if (!a) {
        return say(`${emoji} ${label} : *${settings.get(key)}${unit}*${hint ? `\n${hint}` : ''}\n👉 *${P}${cmd} <${min}-${max}>* pour changer.`)
      }
      const valid = float ? /^\d+(\.\d+)?$/.test(a) : /^\d+$/.test(a)
      const n = float ? Number(a) : Number.parseInt(a, 10)
      if (!valid || !Number.isFinite(n) || n < min || n > max) {
        if (pending) bot.setPending(menuChat, { ...pending })
        return say(`❌ Valeur invalide : choisis un nombre entre ${min} et ${max}.${pending ? ' Réessaie (ou *annuler*).' : ''}`)
      }
      settings.set(key, float ? Math.round(n * 100) / 100 : n)
      return say(`${emoji} ${label} : *${settings.get(key)}${unit}* ✅`)
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
    unit: ' tokens',
    hint: '1 token ≈ 0,75 mot.',
  })
  const memorySize = numberSetting('memory', {
    cmd: 'memoire',
    emoji: '🧩',
    label: 'Mémoire',
    min: 2,
    max: 100,
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
    return say(`✅ Réponse en ${((Date.now() - t0) / 1000).toFixed(1)} s :\n\n${r.text}`)
  }

  async function ask({ t, arg, say, sayHere }) {
    const q = String(arg || '').trim()
    if (!q) return say(`❓ *${P}ask <question>* : l'IA répond directement dans cette discussion.`)
    await wa.presence(t.chat, 'composing')
    try {
      const r = await ai.ask(q, { ownerName: bot.ownerName() })
      return await (sayHere || say)(r.text)
    } finally {
      await wa.presence(t.chat, 'paused')
    }
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
    const { ai: a, meai: m } = bot.activeList()
    const st = wa.publicStatus()
    return say(
      [
        `📊 *Statut de ${s.botName}*`,
        `- WhatsApp : ${st.connected ? 'connecté ✅' : st.status}${wa.me?.number ? ` (+${wa.me.number})` : ''}`,
        `- Modèle : ${s.model}`,
        `- Clé NVIDIA : ${ai.client.configured ? 'configurée ✅' : 'manquante ❌'}`,
        `- Discussions actives : ${a.length} assistant • ${m.length} à ta place`,
        `- Conversations en mémoire : ${memory.count()}`,
        `- Stockage : ${bot.kv.kind === 'mongodb' ? 'MongoDB ✅' : 'fichier local ⚠️ (effacé à chaque redémarrage sur Render : garde ton SESSION_ID à jour)'}`,
        `- En ligne depuis : ${formatDuration(Date.now() - bot.startedAt)}`,
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
        `- Personnalité : ${s.personality}`,
        `- Consignes perso : ${s.customPrompt ? s.customPrompt.slice(0, 200) : '_aucune_'}`,
        `- Température : ${s.temperature}`,
        `- Longueur max : ${s.maxTokens} tokens`,
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

  async function commandList({ say }) {
    return say(
      [
        `📖 *Commandes* (préfixe ${P})`,
        '',
        '*IA*',
        `${P}ai [on/off] — assistant IA dans cette discussion`,
        `${P}meai [on/off] — l'IA répond à ta place`,
        `${P}stop — désactiver l'IA ici • ${P}stopall — partout`,
        `${P}actifs — discussions où l'IA est active`,
        `${P}ask <question> — réponse de l'IA ici même`,
        `${P}test [question] — tester l'IA en privé`,
        `${P}reset [tout] — effacer la mémoire`,
        '',
        '*Réglages*',
        `${P}models [page/mot] • ${P}model <n°/nom>`,
        `${P}perso <texte> • ${P}prompt <texte>`,
        `${P}owner <prénom> • ${P}nom <nom du bot>`,
        `${P}temp <0-2> • ${P}tokens <64-8192>`,
        `${P}memoire <2-100> • ${P}delai <0-120>`,
        `${P}groupes tout/mention`,
        `${P}discret on/off • ${P}signature on/off • ${P}reflexion on/off`,
        `${P}reglages • ${P}reinit`,
        '',
        '*Compte*',
        `${P}statut • ${P}session • ${P}ping • ${P}menu`,
      ].join('\n'),
    )
  }

  // ---------- menu numéroté ----------

  const MENU = [
    [1, '🤖', 'Assistant IA ici (on/off)'],
    [2, '🪞', 'Répondre à ma place ici (on/off)'],
    [3, '⛔', "Désactiver l'IA ici"],
    [4, '📋', 'Discussions actives'],
    [5, '🧠', 'Choisir le modèle IA'],
    [6, '🎭', 'Personnalité'],
    [7, '📝', 'Consignes perso'],
    [8, '👤', 'Ton prénom'],
    [9, '🏷️', 'Nom du bot'],
    [10, '🌡️', 'Créativité (température)'],
    [11, '📏', 'Longueur max des réponses'],
    [12, '🧩', 'Mémoire (nombre de messages)'],
    [13, '⏱️', 'Délai avant réponse'],
    [14, '👥', 'Comportement en groupe'],
    [15, '🕶️', 'Mode discret & signature'],
    [16, '🧪', "Tester l'IA"],
    [17, '🧹', 'Effacer la mémoire ici'],
    [18, '🔑', 'Statut & SESSION_ID'],
    [0, '❌', 'Fermer le menu'],
  ]
  const ZERO_IS_VALUE = new Set(['temp', 'delai']) // étapes où « 0 » est une vraie valeur
  const CANCEL = /^(annuler|cancel|x)$/i

  function menuText(t) {
    const s = settings.all()
    const state = settings.isActive('meai', t.ids) ? '🪞 à ta place' : settings.isActive('ai', t.ids) ? '🤖 assistant' : '💤 inactive'
    return [
      `*${s.botName} — Menu*`,
      `📍 Discussion : _${bot.label(t.chat)}_ • IA : ${state}`,
      `🧠 ${s.model}`,
      '',
      ...MENU.map(([n, e, l]) => `*${n}.* ${e} ${l}`),
      '',
      '_Réponds avec un numéro (ex : *1*)._',
    ].join('\n')
  }

  async function menu({ t, say, sayRaw, menuChat }) {
    bot.setPending(menuChat, { step: 'menu', target: t })
    return (sayRaw || say)(menuText(t))
  }

  async function runMenuItem(n, a) {
    const { t, say, menuChat } = a
    const askFor = (step, text) => {
      bot.setPending(menuChat, { step, target: t })
      return say(`${text}\n\n_Réponds *${ZERO_IS_VALUE.has(step) ? 'annuler' : '0'}* pour annuler._`)
    }
    const onOff = (v) => (v ? 'activé' : 'désactivé')
    const call = (fn) => fn({ ...a, arg: '', pending: null })
    switch (n) {
      case 0:
        return say('👋 Menu fermé.')
      case 1:
        return toggleMode({ ...a, arg: '' }, 'ai')
      case 2:
        return toggleMode({ ...a, arg: '' }, 'meai')
      case 3:
        return call(stopHere)
      case 4:
        return call(listActive)
      case 5: {
        const list = await ai.client.listModels()
        modelList = list
        bot.setPending(menuChat, { step: 'model', target: t, page: 1, list, query: '' })
        return say(renderModelPage(list, 1, '', MODEL_FOOTER))
      }
      case 6:
        return askFor('perso', `🎭 Personnalité actuelle : _${settings.get('personality')}_\n\nEnvoie la nouvelle personnalité (ex : « sarcastique mais bienveillant »), ou *reset*.`)
      case 7: {
        const current = settings.get('customPrompt')
        return askFor('prompt', `📝 Consignes actuelles : ${current ? `_${current}_` : '_aucune_'}\n\nEnvoie tes consignes (ex : « Je suis étudiant à Lyon, tutoie tout le monde »), ou *reset* pour les effacer.`)
      }
      case 8:
        return askFor('owner', `👤 Prénom actuel : *${bot.ownerName() || '?'}*\n\nEnvoie ton prénom (l'IA l'utilise pour parler de toi et à ta place).`)
      case 9:
        return askFor('nom', `🏷️ Nom actuel du bot : *${settings.get('botName')}*\n\nEnvoie le nouveau nom.`)
      case 10:
        return askFor('temp', `🌡️ Température actuelle : *${settings.get('temperature')}*\n\nEnvoie un nombre entre 0 et 2 (0 = précis • 0.7 = équilibré • 1.2 = très créatif).`)
      case 11:
        return askFor('tokens', `📏 Longueur max actuelle : *${settings.get('maxTokens')} tokens*\n\nEnvoie un nombre entre 64 et 8192 (1 token ≈ 0,75 mot).`)
      case 12:
        return askFor('memoire', `🧩 Mémoire actuelle : *${settings.get('memory')} messages*\n\nEnvoie un nombre entre 2 et 100.`)
      case 13:
        return askFor('delai', `⏱️ Délai actuel : *${settings.get('replyDelay')} s*\n\nEnvoie un nombre de secondes entre 0 et 120.`)
      case 14:
        return askFor(
          'groupes',
          `👥 En groupe, je réponds actuellement ${settings.get('groupMode') === 'all' ? 'à *tous* les messages' : 'seulement quand on te *mentionne*'}.\n\n*1.* Répondre à tous les messages\n*2.* Seulement quand on te mentionne ou te répond`,
        )
      case 15:
        return askFor(
          'discret',
          `🕶️ Mode discret : *${onOff(settings.get('discreet'))}* • ✍️ Signature : *${onOff(settings.get('signature'))}*\n\n*1.* Activer le mode discret\n*2.* Désactiver le mode discret\n*3.* Activer la signature\n*4.* Désactiver la signature`,
        )
      case 16:
        return call(test)
      case 17:
        return call(resetMemory)
      case 18:
        await call(status)
        return call(session)
      default:
        bot.setPending(menuChat, { step: 'menu', target: t })
        return say('❌ Choisis un numéro entre 0 et 18.')
    }
  }

  /** Réponses aux questions du menu (le texte que tu envoies après avoir choisi un numéro). */
  const STEPS = {
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
      bot.setPending(a.menuChat, { step: 'model', target: a.t, page: 1, list: found, query: input })
      return a.say(renderModelPage(found, 1, input, MODEL_FOOTER))
    },
  }

  async function handlePending(ctx, pending) {
    const input = String(ctx.text || '').trim()
    const menuChat = ctx.chat
    const say = (text) => wa.send(menuChat, { text }).catch((err) => bot.log.warn({ err: err?.message }, 'Envoi impossible'))
    if (pending.step === 'menu' && !/^\d{1,2}$/.test(input)) {
      bot.clearPending(menuChat)
      if (CANCEL.test(input)) {
        await say('👋 Menu fermé.')
        return true
      }
      return false // message normal : le menu se ferme et le message est traité normalement
    }
    bot.clearPending(menuChat)
    if (CANCEL.test(input) || (input === '0' && pending.step !== 'menu' && !ZERO_IS_VALUE.has(pending.step))) {
      await say('❎ Annulé.')
      return true
    }
    const a = { t: pending.target, arg: input, say, sayHere: say, sayRaw: say, menuChat, pending }
    try {
      if (pending.step === 'menu') await runMenuItem(Number.parseInt(input, 10), a)
      else if (STEPS[pending.step]) await STEPS[pending.step](a)
      else return false
    } catch (err) {
      bot.log.error({ err: err?.message, step: pending.step }, 'Erreur du menu')
      await say(`⚠️ ${err?.message || err}`)
    }
    return true
  }

  // ---------- commandes tapées ----------

  const COMMANDS = {
    menu,
    aide: menu,
    help: menu,
    commandes: commandList,
    cmds: commandList,
    commands: commandList,
    ai: (a) => toggleMode(a, 'ai'),
    ia: (a) => toggleMode(a, 'ai'),
    meai: (a) => toggleMode(a, 'meai'),
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
      say: (text) => bot.reply(ctx, text),
      sayHere: (text) => bot.reply(ctx, text, { here: true }),
      sayRaw: (text) => wa.send(menuChat, { text }).catch(() => {}),
      menuChat,
      pending: null,
    }
    try {
      await fn(a)
    } catch (err) {
      bot.log.error({ err: err?.message, cmd: name }, 'Erreur de commande')
      await a.say(`⚠️ ${err?.message || err}`)
    }
    return true
  }

  return { run, handlePending, COMMANDS, MENU }
}
