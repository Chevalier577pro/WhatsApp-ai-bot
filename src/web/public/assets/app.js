;(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c])
  const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const sleep = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? Math.min(ms, 60) : ms))
  // Mise en forme WhatsApp (*gras*, _italique_) sur un texte déjà échappé
  const waFormat = (html) => html.replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,!?;:)])/g, '$1<i>$2</i>')

  // ───────────── État & API (même contrat que l'ancienne page) ─────────────
  const LABELS = {
    idle: 'Non connecté', connecting: 'Connexion…', waiting_pair: 'En attente du code', waiting_qr: 'En attente du QR',
    connected: 'Connecté', reconnecting: 'Reconnexion…', logged_out: 'Déconnecté', replaced: 'Ouvert ailleurs', error: 'Erreur',
  }
  const WAITING = ['connecting', 'waiting_pair', 'waiting_qr', 'reconnecting']
  const BAD = ['logged_out', 'replaced', 'error']
  const PAIR_TOTAL_MS = 180000
  const RING = 119.4
  const state = {
    token: sessionStorage.getItem('pairToken') || '',
    pwd: sessionStorage.getItem('adminPwd') || '',
    st: null, statusAt: 0, sessionShown: false, timer: null, pairExpires: 0, pollTimer: null,
    code: '', botName: 'Nova', prefix: '.', favCls: null, catalog: null, cmdCat: 'all', cmdQuery: '',
  }

  function msg(id, text, ok) {
    const el = $(id)
    el.textContent = text || ''
    el.className = 'msg' + (text ? ' show ' + (ok ? 'ok' : 'err') : '')
  }
  function setToken(t) {
    state.token = t || ''
    if (t) sessionStorage.setItem('pairToken', t)
    else sessionStorage.removeItem('pairToken')
  }
  function forgetPwd() {
    state.pwd = ''
    sessionStorage.removeItem('adminPwd')
  }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {}
    if (body) headers['Content-Type'] = 'application/json'
    if (state.pwd) headers['x-admin-password'] = encodeURIComponent(state.pwd)
    if (state.token) headers['x-pair-token'] = state.token
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(data.error || 'Erreur ' + res.status)
      err.status = res.status
      if (res.status === 401) { forgetPwd(); setTimeout(refresh, 0) }
      throw err
    }
    return data
  }

  // ───────────── Petits outils d'interface ─────────────
  function toast(text, type = 'ok', ms = 2600) {
    const el = document.createElement('div')
    el.className = 'toast ' + type
    el.textContent = text
    $('toasts').append(el)
    setTimeout(() => {
      el.classList.add('out')
      setTimeout(() => el.remove(), 350)
    }, ms)
  }

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    toast('Copié dans le presse-papiers ✅')
    if (btn && !btn.dataset.busy) {
      btn.dataset.busy = '1'
      const old = btn.textContent
      btn.textContent = '✅ Copié !'
      setTimeout(() => { btn.textContent = old; delete btn.dataset.busy }, 1500)
    }
  }

  function confirmBox({ title, text, ok }) {
    return new Promise((resolve) => {
      const modal = $('modal')
      $('modalTitle').textContent = title
      $('modalText').textContent = text
      $('modalOk').textContent = ok
      const last = document.activeElement
      modal.classList.remove('hidden')
      $('modalCancel').focus()
      const done = (v) => {
        modal.classList.add('hidden')
        modal.removeEventListener('click', onBg)
        document.removeEventListener('keydown', onKey, true)
        $('modalOk').onclick = $('modalCancel').onclick = null
        last?.focus?.()
        resolve(v)
      }
      const onBg = (e) => { if (e.target === modal) done(false) }
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false) } }
      modal.addEventListener('click', onBg)
      document.addEventListener('keydown', onKey, true)
      $('modalOk').onclick = () => done(true)
      $('modalCancel').onclick = () => done(false)
    })
  }

  function confetti() {
    if (reduceMotion) return
    const c = document.createElement('canvas')
    c.className = 'confetti'
    document.body.append(c)
    const dpr = Math.min(2, devicePixelRatio || 1)
    c.width = innerWidth * dpr
    c.height = innerHeight * dpr
    const ctx = c.getContext('2d')
    ctx.scale(dpr, dpr)
    const colors = ['#25d366', '#22d3ee', '#8b5cf6', '#ffb02e', '#f472b6', '#ffffff']
    const parts = Array.from({ length: 170 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 160,
      y: innerHeight * 0.42,
      vx: (Math.random() - 0.5) * 16,
      vy: -Math.random() * 15 - 5,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      c: colors[(Math.random() * colors.length) | 0],
    }))
    const start = performance.now()
    const frame = (t) => {
      ctx.clearRect(0, 0, innerWidth, innerHeight)
      for (const p of parts) {
        p.vy += 0.38
        p.vx *= 0.99
        p.x += p.vx
        p.y += p.vy
        p.r += p.vr
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.r)
        ctx.fillStyle = p.c
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)))
        ctx.restore()
      }
      if (t - start < 3200) requestAnimationFrame(frame)
      else c.remove()
    }
    requestAnimationFrame(frame)
  }

  function formatDuration(sec) {
    sec = Math.max(0, Math.floor(sec))
    const d = Math.floor(sec / 86400)
    const h = Math.floor((sec % 86400) / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    if (d) return `${d} j ${h} h`
    if (h) return `${h} h ${String(m).padStart(2, '0')} min`
    if (m) return `${m} min ${String(s).padStart(2, '0')} s`
    return `${s} s`
  }

  function setText(sel, value) {
    for (const el of $$(sel)) if (el.textContent !== value) el.textContent = value
  }

  // ───────────── Rendu de l'état ─────────────
  const FAV_PATH = 'M16 2.5C8.5 2.5 2.5 8.4 2.5 15.7c0 2.5.7 4.9 2 7L3 29.5l7-1.8a13.6 13.6 0 0 0 6 1.4c7.5 0 13.5-5.9 13.5-13.2S23.5 2.5 16 2.5Z'
  function setFavicon(cls) {
    if (cls === state.favCls) return
    state.favCls = cls
    const color = { ok: '#25d366', wait: '#ffb02e', err: '#f15c6d' }[cls] || '#8b9ba6'
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#25d366"/><stop offset=".55" stop-color="#22d3ee"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><path fill="url(#g)" d="${FAV_PATH}"/><circle cx="25.5" cy="6.5" r="5.5" fill="${color}" stroke="#05090d" stroke-width="2"/></svg>`
    $('favicon').href = 'data:image/svg+xml,' + encodeURIComponent(svg)
  }

  const DASH = {
    connected: ['Le bot est en ligne', (n, p) => `${n} veille sur ton WhatsApp. Envoie ${p}menu dans « Moi » pour tout régler.`],
    idle: ['En attente de connexion', () => 'Aucun compte WhatsApp relié pour le moment : connecte-le juste en dessous.'],
    connecting: ['Connexion en cours…', () => 'Le bot ouvre la session WhatsApp.'],
    waiting_pair: ['En attente du code', () => 'Saisis le code dans WhatsApp : Appareils connectés → Connecter un appareil.'],
    waiting_qr: ['En attente du QR code', () => 'Scanne le QR code depuis WhatsApp : Appareils connectés.'],
    reconnecting: ['Reconnexion…', () => 'La connexion a sauté, le bot se reconnecte tout seul.'],
    logged_out: ['WhatsApp déconnecté', () => "L'appareil a été retiré dans WhatsApp : refais l'appairage."],
    replaced: ['Session ouverte ailleurs', () => "Ce SESSION_ID tourne à un autre endroit : n'en garde qu'un seul."],
    error: ['Erreur de connexion', () => 'Une erreur est survenue. Réessaie dans un instant.'],
  }

  function statusClass(st) {
    return st.connected ? 'ok' : WAITING.includes(st.status) ? 'wait' : BAD.includes(st.status) ? 'err' : ''
  }

  function renderDashboard(st, cls) {
    $('orb').className = 'orb ' + (cls || 'idle')
    const [title, sub] = DASH[st.status] || [LABELS[st.status] || st.status, () => '']
    setText('#dashTitle', title)
    setText('#dashSub', BAD.includes(st.status) && st.lastError ? st.lastError : sub(state.botName, state.prefix))
    setText('#mAccount', st.me ? [st.me.name, st.me.number].filter(Boolean).join(' · ') || 'Connecté' : st.hasSession ? 'Session enregistrée' : 'Aucun')
    const model = st.model ? String(st.model).split('/').pop() : '—'
    setText('#mModel', model)
    $('mModel').title = st.model || ''
    setText('#dashAction', st.connected ? 'Voir ma session' : 'Connecter mon WhatsApp')
    const items = [
      ['WhatsApp', st.connected ? 'ok' : cls === 'wait' ? 'warn' : cls === 'err' ? 'err' : 'warn', LABELS[st.status] || st.status],
    ]
    if (typeof st.aiConfigured === 'boolean') items.push(['Clé NVIDIA', st.aiConfigured ? 'ok' : 'err', st.aiConfigured ? 'présente' : 'manquante'])
    items.push(['Mot de passe du site', st.needsPassword ? 'ok' : 'warn', st.needsPassword ? 'actif' : 'absent'])
    items.push(['Stockage', st.storage === 'mongodb' ? 'ok' : 'warn', st.storage === 'mongodb' ? 'MongoDB' : 'fichier local'])
    const html = items.map(([k, c, v]) => `<span class="diag-item ${c}">${esc(k)} <span>${esc(v)}</span></span>`).join('')
    if ($('diag').innerHTML !== html) $('diag').innerHTML = html
    tickClocks()
  }

  function tickClocks() {
    const st = state.st
    if (!st) return
    if (typeof st.uptime === 'number') setText('#mUptime', formatDuration(st.uptime + (Date.now() - state.statusAt) / 1000))
    setText('#mSince', st.connected && st.connectedAt ? formatDuration((Date.now() - st.connectedAt) / 1000) : '—')
  }
  setInterval(tickClocks, 1000)

  function updateSteps(st, linked) {
    let cur = 1
    if (linked) cur = 3
    else if (['waiting_pair', 'waiting_qr', 'connecting'].includes(st.status) || ($('pairResult') && !$('pairResult').classList.contains('hidden'))) cur = 2
    for (const li of $$('#steps li')) {
      const n = Number(li.dataset.step)
      li.classList.toggle('done', n < cur || (n === 3 && st.connected && state.sessionShown))
      li.classList.toggle('current', n === cur)
    }
  }

  function renderTiles(code) {
    const box = $('code')
    box.innerHTML = [...code].map((ch, i) => `<span class="tile${ch === '-' ? ' sep' : ''}" style="--i:${i}">${ch === '-' ? '–' : esc(ch)}</span>`).join('')
    box.setAttribute('aria-label', "Code d'appairage : " + code)
  }

  function showCode(code, expiresAt) {
    if (code !== state.code) {
      state.code = code
      renderTiles(code)
    }
    $('pairResult').classList.remove('hidden')
    state.pairExpires = expiresAt || Date.now() + PAIR_TOTAL_MS
    if (!state.timer) state.timer = setInterval(tick, 1000)
    tick()
  }
  function tick() {
    const leftMs = Math.max(0, state.pairExpires - Date.now())
    const left = Math.round(leftMs / 1000)
    const mmss = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0')
    $('timer').textContent = left ? 'Code valable encore ' + mmss : 'Code expiré : demande un nouveau code.'
    $('timerShort').textContent = left ? mmss : '0:00'
    $('timerRing').style.strokeDashoffset = String(RING * (1 - Math.min(1, leftMs / PAIR_TOTAL_MS)))
    $('timerRing').closest('.ring').classList.toggle('low', left < 30)
    if (!left) stopTimer()
  }
  function stopTimer() {
    clearInterval(state.timer)
    state.timer = null
  }

  async function loadSession() {
    if (state.sessionShown) return
    state.sessionShown = true
    try {
      const { sessionId } = await api('/api/session')
      $('sessionId').value = sessionId
      $('secretWrap').classList.add('veiled')
      $('sessionBox').classList.remove('hidden')
      $('showSession').classList.add('hidden')
      msg('connMsg', '')
    } catch (e) {
      state.sessionShown = false
      msg('connMsg', e.message)
    }
  }

  function render(st) {
    const prev = state.st
    state.st = st
    state.statusAt = Date.now()
    const name = st.botName || 'Bot'
    if (name !== state.botName) {
      state.botName = name
      setText('.js-botname', name)
      updateEnv()
    }
    document.title = name + ' — Bot WhatsApp IA'
    const cls = statusClass(st)
    $('navStatus').className = 'status-pill' + (cls ? ' st-' + cls : '')
    setText('#navStatusText', LABELS[st.status] || st.status)
    $('storage').textContent = st.storage === 'mongodb' ? 'Stockage : MongoDB ✅' : 'Stockage : fichier local (garde ton SESSION_ID à jour sur Render)'
    setFavicon(cls)
    renderDashboard(st, cls)
    if (prev && !prev.connected && st.connected) {
      toast('WhatsApp connecté ! 🎉')
      confetti()
    } else if (prev && prev.connected && !st.connected) {
      toast('WhatsApp déconnecté', 'err')
    }

    $('panelLoading').classList.add('hidden')
    const linked = st.connected || (st.hasSession && ['connecting', 'reconnecting'].includes(st.status))
    const needPwd = st.needsPassword && !state.pwd
    $('pwdCard').classList.toggle('hidden', !needPwd)
    $('connectedCard').classList.toggle('hidden', !linked)
    $('pairCard').classList.toggle('hidden', linked || needPwd)
    updateSteps(st, linked)
    if (linked) {
      stopTimer()
      $('who').textContent = st.me ? 'Compte : ' + [st.me.name, st.me.number].filter(Boolean).join(' • ') : 'Reconnexion en cours…'
      $('logoutBtn').classList.toggle('hidden', !(st.needsPassword && state.pwd))
      $('noPwdHint').classList.toggle('hidden', st.needsPassword)
      $('showSession').classList.toggle('hidden', state.sessionShown || !st.connected || !(state.pwd || st.sessionAvailable))
      if (st.sessionAvailable) loadSession()
      return
    }
    state.sessionShown = false
    $('sessionBox').classList.add('hidden')
    if (st.pairing && st.pairing.code) showCode(st.pairing.code, st.pairing.expiresAt)
    if (st.qr) {
      $('qrImg').src = st.qr
      $('qrWrap').classList.remove('hidden')
    } else if (st.status !== 'waiting_qr') {
      $('qrWrap').classList.add('hidden')
    }
    msg('statusMsg', BAD.includes(st.status) || st.status === 'idle' ? st.lastError || '' : '')
  }

  async function refresh() {
    clearTimeout(state.pollTimer)
    try {
      render(await api('/api/status'))
    } catch {
      $('navStatus').className = 'status-pill st-err'
      setText('#navStatusText', 'Hors ligne')
      $('orb').className = 'orb err'
      setText('#dashTitle', 'Serveur injoignable')
      setText('#dashSub', 'Nouvelle tentative dans quelques secondes… (sur Render gratuit, le réveil prend parfois 30 s)')
      setFavicon('err')
      const loading = $('panelLoading')
      if (!loading.classList.contains('hidden')) loading.innerHTML = '<span class="spinner"></span> Serveur injoignable, nouvelle tentative…'
    }
    state.pollTimer = setTimeout(refresh, state.st && state.st.connected ? 10000 : 3000)
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh() })

  // ───────────── Mot de passe ─────────────
  $('pwdBtn').onclick = async () => {
    const pwd = $('pwd').value
    if (!pwd) return msg('pwdMsg', 'Entre le mot de passe.')
    $('pwdBtn').disabled = true
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Mot de passe incorrect.')
      state.pwd = pwd
      sessionStorage.setItem('adminPwd', pwd)
      $('pwd').value = ''
      msg('pwdMsg', '')
      toast('Bienvenue 👋 Accès administrateur déverrouillé')
      refresh()
    } catch (e) {
      msg('pwdMsg', e.message)
      $('pwdCard').animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], { duration: 300 })
    } finally {
      $('pwdBtn').disabled = false
    }
  }
  $('pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pwdBtn').click() })
  $('pwdEye').onclick = () => {
    const show = $('pwd').type === 'password'
    $('pwd').type = show ? 'text' : 'password'
    $('pwdEye').textContent = show ? '🙈' : '👁'
  }

  // ───────────── Numéro de téléphone (indicatif + numéro) ─────────────
  // [code ISO, drapeau, pays, indicatif, 0 national à retirer]
  const COUNTRIES = [
    ['FR', '🇫🇷', 'France', '33', 1], ['BE', '🇧🇪', 'Belgique', '32', 1], ['CH', '🇨🇭', 'Suisse', '41', 1],
    ['CA', '🇨🇦', 'Canada', '1', 0], ['US', '🇺🇸', 'États-Unis', '1', 0], ['LU', '🇱🇺', 'Luxembourg', '352', 0],
    ['MC', '🇲🇨', 'Monaco', '377', 0], ['RE', '🇷🇪', 'La Réunion / Mayotte', '262', 1], ['GP', '🇬🇵', 'Guadeloupe', '590', 1],
    ['MQ', '🇲🇶', 'Martinique', '596', 1], ['GF', '🇬🇫', 'Guyane', '594', 1], ['NC', '🇳🇨', 'Nouvelle-Calédonie', '687', 0],
    ['PF', '🇵🇫', 'Polynésie française', '689', 0], ['MA', '🇲🇦', 'Maroc', '212', 1], ['DZ', '🇩🇿', 'Algérie', '213', 1],
    ['TN', '🇹🇳', 'Tunisie', '216', 0], ['SN', '🇸🇳', 'Sénégal', '221', 0], ['CI', '🇨🇮', "Côte d'Ivoire", '225', 0],
    ['CM', '🇨🇲', 'Cameroun', '237', 0], ['ML', '🇲🇱', 'Mali', '223', 0], ['BF', '🇧🇫', 'Burkina Faso', '226', 0],
    ['BJ', '🇧🇯', 'Bénin', '229', 0], ['TG', '🇹🇬', 'Togo', '228', 0], ['GN', '🇬🇳', 'Guinée', '224', 0],
    ['GA', '🇬🇦', 'Gabon', '241', 0], ['CG', '🇨🇬', 'Congo', '242', 0], ['CD', '🇨🇩', 'RD Congo', '243', 1],
    ['MG', '🇲🇬', 'Madagascar', '261', 1], ['HT', '🇭🇹', 'Haïti', '509', 0], ['DE', '🇩🇪', 'Allemagne', '49', 1],
    ['ES', '🇪🇸', 'Espagne', '34', 0], ['IT', '🇮🇹', 'Italie', '39', 0], ['PT', '🇵🇹', 'Portugal', '351', 0],
    ['GB', '🇬🇧', 'Royaume-Uni', '44', 1], ['NL', '🇳🇱', 'Pays-Bas', '31', 1], ['XX', '🌍', 'Autre (indicatif inclus)', '', 0],
  ]
  const countrySel = $('country')
  countrySel.innerHTML = COUNTRIES.map(([iso, flag, name, code]) => `<option value="${iso}">${flag} ${code ? '+' + code : ''} ${esc(name)}</option>`).join('')
  const guessCountry = () => {
    try {
      const saved = localStorage.getItem('country')
      if (saved && COUNTRIES.some((c) => c[0] === saved)) return saved
    } catch {}
    // Site en français : on ne devine le pays que depuis une langue française (fr-BE, fr-CA…)
    for (const lang of navigator.languages || [navigator.language || '']) {
      const [base, region] = String(lang).split('-')
      if (base === 'fr' && region && COUNTRIES.some((c) => c[0] === region.toUpperCase())) return region.toUpperCase()
    }
    return 'FR'
  }
  countrySel.value = guessCountry()
  const country = () => COUNTRIES.find((c) => c[0] === countrySel.value) || COUNTRIES[0]

  function fullNumber() {
    const raw = $('phone').value.trim()
    let digits = raw.replace(/\D/g, '')
    if (!digits) return ''
    if (/^(\+|00)/.test(raw)) return digits.replace(/^00/, '')
    const [, , , code, trunk] = country()
    if (!code) return digits
    if (digits.startsWith(code) && digits.length - code.length >= 8) return digits
    if (trunk) digits = digits.replace(/^0+/, '')
    return code + digits
  }
  function updatePhonePreview() {
    const full = fullNumber()
    const el = $('phonePreview')
    if (!full) {
      el.textContent = "Choisis ton pays puis tape ton numéro (le 0 du début est retiré tout seul)."
      return
    }
    el.innerHTML = `Numéro envoyé : <b>+${esc(full)}</b>${full.length < 8 || full.length > 15 ? ' · <span style="color:var(--red)">longueur inhabituelle</span>' : ''}`
  }
  countrySel.addEventListener('change', () => {
    try { localStorage.setItem('country', countrySel.value) } catch {}
    updatePhonePreview()
  })
  $('phone').addEventListener('input', updatePhonePreview)
  updatePhonePreview()

  // ───────────── Appairage ─────────────
  $('pairBtn').onclick = async () => {
    const phone = fullNumber()
    if (phone.length < 8) return msg('pairMsg', 'Numéro invalide : indicatif du pays + numéro, par exemple 33612345678.')
    const btn = $('pairBtn')
    btn.disabled = true
    btn.innerHTML = '<span class="spinner"></span> Demande en cours… (jusqu\'à 45 s)'
    msg('pairMsg', '')
    try {
      const r = await api('/api/pair', { method: 'POST', body: { phone } })
      setToken(r.token)
      showCode(r.code, r.expiresAt)
      if (state.st) updateSteps(state.st, false)
      msg('pairMsg', 'Code prêt ! Saisis-le vite dans WhatsApp.', true)
      toast('Code prêt : saisis-le dans WhatsApp 📲')
    } catch (e) {
      msg('pairMsg', e.message)
    } finally {
      btn.disabled = false
      btn.textContent = 'Obtenir un nouveau code'
    }
  }
  $('phone').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pairBtn').click() })
  $('copyCode').onclick = () => copy(state.code.replace(/-/g, ''), $('copyCode'))

  $('qrBtn').onclick = async () => {
    const btn = $('qrBtn')
    btn.disabled = true
    msg('qrMsg', '')
    try {
      const r = await api('/api/qr', { method: 'POST' })
      setToken(r.token)
      $('qrImg').src = r.qr
      $('qrWrap').classList.remove('hidden')
      msg('qrMsg', 'Scanne le QR avec WhatsApp. Il se renouvelle automatiquement.', true)
    } catch (e) {
      msg('qrMsg', e.message)
    } finally {
      btn.disabled = false
    }
  }

  $('importBtn').onclick = async () => {
    const sessionId = $('importInput').value.trim()
    if (!sessionId) return msg('importMsg', 'Colle ton SESSION_ID.')
    $('importBtn').disabled = true
    try {
      await api('/api/import', { method: 'POST', body: { sessionId } })
      $('importInput').value = ''
      msg('importMsg', 'Session importée, connexion en cours…', true)
      refresh()
    } catch (e) {
      msg('importMsg', e.message)
    } finally {
      $('importBtn').disabled = false
    }
  }

  $('showSession').onclick = () => loadSession()
  $('copySession').onclick = () => copy($('sessionId').value, $('copySession'))
  $('revealSession').onclick = () => $('secretWrap').classList.remove('veiled')
  $('hideSession').onclick = () => $('secretWrap').classList.add('veiled')
  $('logoutBtn').onclick = async () => {
    const ok = await confirmBox({
      title: 'Déconnecter ce WhatsApp ?',
      text: "Il faudra refaire l'appairage et remplacer SESSION_ID sur Render.",
      ok: 'Déconnecter',
    })
    if (!ok) return
    try {
      await api('/api/logout', { method: 'POST' })
      state.sessionShown = false
      $('sessionBox').classList.add('hidden')
      setToken('')
      refresh()
    } catch (e) {
      msg('connMsg', e.message)
    }
  }

  // Onglets Code / QR / SESSION_ID
  const TABS = ['code', 'qr', 'import']
  function selectTab(name, focus) {
    $$('#tabs button').forEach((b, i) => {
      const on = b.dataset.tab === name
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', String(on))
      b.tabIndex = on ? 0 : -1
      if (on) {
        $('tabs').style.setProperty('--i', i)
        if (focus) b.focus()
      }
    })
    for (const t of TABS) $('tab-' + t).classList.toggle('hidden', t !== name)
  }
  $$('#tabs button').forEach((btn) => {
    btn.onclick = () => selectTab(btn.dataset.tab)
    btn.onkeydown = (e) => {
      const i = TABS.indexOf(btn.dataset.tab)
      if (e.key === 'ArrowRight') selectTab(TABS[(i + 1) % 3], true)
      if (e.key === 'ArrowLeft') selectTab(TABS[(i + 2) % 3], true)
    }
  })
  selectTab('code')

  // ───────────── Conversations animées (héros + modes) ─────────────
  function chatPlayer(box, statusEl) {
    let run = 0
    const baseStatus = statusEl ? statusEl.textContent : ''
    const add = (cls, html) => {
      const b = document.createElement('div')
      b.className = 'bubble ' + cls
      b.innerHTML = html
      box.append(b)
      while (box.children.length > 9) box.firstElementChild.remove()
      return b
    }
    const setStatus = (text, on) => {
      if (!statusEl) return
      statusEl.textContent = text
      statusEl.classList.toggle('typing-on', on)
    }
    async function play(getScript, loop) {
      const id = ++run
      box.innerHTML = ''
      do {
        for (const s of getScript()) {
          if (id !== run) return
          if (s.type) {
            setStatus('écrit…', true)
            const t = add('in typing', '<span class="typing-dots"><i></i><i></i><i></i></span>')
            await sleep(s.type)
            t.remove()
            setStatus(baseStatus, false)
          } else if (s.think) {
            // ⚙️ comme le vrai bot pendant que l'IA écrit
            const last = box.lastElementChild
            const r = document.createElement('span')
            r.className = 'react'
            r.textContent = '⚙️'
            last?.append(r)
            await sleep(s.think)
            r.remove()
          } else {
            const meta = s.side === 'sys' ? '' : `<span class="meta">${s.time || nowTime()}${s.side === 'out' ? ' <span class="ticks">✓✓</span>' : ''}</span>`
            add(s.side, s.html + meta)
            await sleep(s.ms || 1600)
          }
        }
        if (loop) {
          await sleep(3200)
          if (id !== run) return
          box.innerHTML = ''
        }
      } while (loop && id === run)
    }
    return { play, stop: () => run++ }
  }
  const nowTime = () => new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const P = () => esc(state.prefix)
  const N = () => esc(state.botName)

  const heroScript = () => [
    { side: 'in', html: 'Salut ! Lucas est dispo samedi ? 😊', ms: 900 },
    { think: 1500 },
    { side: 'out', html: `<span class="who">🤖 ${N()}</span>Bonjour Léa 👋 Je suis ${N()}, l'assistante de Lucas. Il est occupé, mais je lui transmets !`, ms: 2200 },
    { type: 1200 },
    { side: 'in', html: '<span class="media">🪴</span>C\'est quoi cette plante ?', ms: 900 },
    { think: 1600 },
    { side: 'out', html: `<span class="who">🤖 ${N()}</span>C'est un <b>monstera</b> 🌿 Arrose-le une fois par semaine, à l'abri du soleil direct.`, ms: 2200 },
    { type: 1000 },
    { side: 'in', html: `<span class="cmd">${P()}song daft punk get lucky</span>`, ms: 900 },
    { think: 1300 },
    { side: 'out', html: '<span class="media music">🎧</span><b>Get Lucky</b> · Daft Punk · 6:09<br>Réponds <b>1</b> MP3 · <b>2</b> audio WhatsApp', ms: 1700 },
    { side: 'in', html: '2', ms: 1000 },
    { side: 'out', html: '<span class="audio"><span class="play">▶</span><span class="wave"></span><small>6:09</small></span>', ms: 1800 },
  ]
  const hero = chatPlayer($('heroChat'), $('heroTyping'))

  const MODES = {
    ai: {
      contact: 'Léa',
      title: () => 'Un assistant qui répond pour toi',
      text: () => `Active <code>${P()}ai</code> dans une discussion : ${N()} répond aux messages reçus en se présentant comme ton assistant. Dans « Moi », c'est ton IA privée.`,
      points: () => ['Se présente clairement comme une IA', 'Peut envoyer des fichiers : .html, .csv, code…', 'Voit les photos et se souvient de la conversation'],
      script: () => [
        { side: 'sys', html: `Tu as envoyé <b>${P()}ai</b> · effacé (mode discret)`, ms: 900 },
        { side: 'in', html: 'Coucou, Lucas peut me faire une liste pour la raclette ? 🧀', ms: 800 },
        { think: 1500 },
        { side: 'out', html: `<span class="who">🤖 ${N()}</span>Avec plaisir ! Je t'envoie la liste en fichier 👇`, ms: 1100 },
        { side: 'out', html: '<span class="file"><span>📄</span><span><b>courses-raclette.txt</b><small>1 Ko · Texte</small></span></span>Bon appétit ! 😋', ms: 1800 },
      ],
    },
    meai: {
      contact: 'Hugo',
      title: () => "L'IA répond à ta place",
      text: () => `Avec <code>${P()}meai</code>, l'IA écrit comme toi, avec ton style. Elle attend le délai choisi (<code>${P()}delai</code>, 2 s par défaut) : si tu réponds avant, elle se tait.`,
      points: () => [`Décris-toi avec ${state.prefix}prompt pour des réponses crédibles`, `Remplace ${state.prefix}ai dans cette discussion`, 'Pas de fichiers dans ce mode'],
      script: () => [
        { side: 'in', html: 'tu viens au foot demain soir ?', ms: 900 },
        { side: 'sys', html: '⏳ 2 s sans réponse de ta part…', ms: 1000 },
        { think: 1300 },
        { side: 'out', html: 'grave ! 18h comme d\'hab ? ⚽', ms: 1300 },
        { side: 'in', html: 'yes, ramène le ballon stp 😅', ms: 900 },
        { think: 1100 },
        { side: 'out', html: 'ça marche, je le mets dans mon sac 👌', ms: 1800 },
      ],
    },
    aai: {
      contact: 'Les potes 🎉',
      title: () => "L'IA te répond aussi à toi",
      text: () => `<code>${P()}aai</code> ajoute une chose : l'IA répond aussi à <b>tes</b> messages, en les citant. Pratique en groupe pour une info rapide. Il faut d'abord <code>${P()}ai</code> ou <code>${P()}meai</code>.`,
      points: () => ['Marche en privé comme en groupe', 'Cite ton message pour garder le fil', `${state.prefix}stop coupe tout dans la discussion`],
      script: () => [
        { side: 'out', html: "c'est quoi déjà la capitale de l'Australie ?", ms: 900 },
        { think: 1400 },
        { side: 'out', html: `<span class="quote">c'est quoi déjà la capitale de l'Australie ?</span><span class="who">🤖 ${N()}</span><b>Canberra</b> ! Pas Sydney, piège classique 😉`, ms: 1300 },
        { side: 'in', html: '<span class="who" style="color:#f59e0b">Sarah</span>ahah je pensais Sydney 😂', ms: 1800 },
      ],
    },
  }
  const modeChat = chatPlayer($('modeChat'), $('modeTyping'))
  let currentMode = 'ai'
  function renderModeInfo() {
    const m = MODES[currentMode]
    $('modeInfo').innerHTML = `<div class="anim"><h3>${m.title()}</h3><p>${m.text()}</p><ul>${m.points().map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`
    $('modeContact').textContent = m.contact
    $('modeAvatar').textContent = m.contact[0]
  }
  function selectMode(mode, focus) {
    currentMode = mode
    $$('#modeTabs button').forEach((b) => {
      const on = b.dataset.mode === mode
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', String(on))
      b.tabIndex = on ? 0 : -1
      if (on && focus) b.focus()
    })
    renderModeInfo()
    modeChat.play(MODES[mode].script, false)
  }
  renderModeInfo()
  const MODE_KEYS = Object.keys(MODES)
  $$('#modeTabs button').forEach((b) => {
    b.onclick = () => selectMode(b.dataset.mode)
    b.onkeydown = (e) => {
      const i = MODE_KEYS.indexOf(b.dataset.mode)
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); selectMode(MODE_KEYS[(i + 1) % 3], true) }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); selectMode(MODE_KEYS[(i + 2) % 3], true) }
    }
  })
  $('modeReplay').onclick = () => selectMode(currentMode)

  // Démarre les démos quand elles deviennent visibles
  const once = (el, fn) => {
    if (!('IntersectionObserver' in window)) return fn()
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect()
        fn()
      }
    }, { threshold: 0.2 })
    io.observe(el)
  }
  once($('heroChat'), () => hero.play(heroScript, true))
  once($('modeChat'), () => selectMode('ai'))

  // ───────────── Catalogue des commandes ─────────────
  const CAT_EMOJI = { ia: '🤖', modele: '🧠', perso: '🎨', reglages: '⚙️', media: '🎵', compte: '🔑' }
  const SYNONYMS = { musique: 'song', chanson: 'song', mp3: 'song', film: 'video', mp4: 'video', image: 'vision', photo: 'vision', oublier: 'reset', memoire: 'memoire', couper: 'stop', arreter: 'stop', aide: 'help', mot: 'prompt', connexion: 'session' }

  async function loadCommands() {
    let data = null
    try {
      const res = await fetch('/api/commands', { cache: 'no-store' })
      if (res.ok) data = await res.json()
    } catch {}
    if (!data || !Array.isArray(data.commands) || !data.commands.length) {
      $('cmdCount').textContent = ''
      $('cmdEmpty').textContent = 'Liste des commandes indisponible pour le moment. Sur WhatsApp, envoie .help dans « Moi ».'
      $('cmdEmpty').classList.remove('hidden')
      return
    }
    state.catalog = data
    state.prefix = data.prefix || '.'
    setText('.js-prefix', state.prefix)
    const counter = $('statCmds')
    counter.dataset.count = String(data.commands.length)
    if (counter.dataset.done) counter.textContent = String(data.commands.length)
    renderCats()
    renderCommands()
    buildPalette()
    if (state.st) renderDashboard(state.st, statusClass(state.st))
    renderModeInfo()
  }

  function catTitle(id) {
    return state.catalog?.categories.find((c) => c.id === id)?.title || id
  }

  function renderCats() {
    const { categories, commands } = state.catalog
    const count = (id) => commands.filter((c) => id === 'all' || c.cat === id).length
    const chips = [{ id: 'all', title: '✨ Toutes' }, ...categories]
    $('cmdCats').innerHTML = chips
      .map((c) => `<button class="chip${state.cmdCat === c.id ? ' active' : ''}" type="button" data-cat="${esc(c.id)}" aria-pressed="${state.cmdCat === c.id}">${esc(c.title)}<span>${count(c.id)}</span></button>`)
      .join('')
  }

  function matches(c, q) {
    if (!q) return true
    const words = q.split(/\s+/).filter(Boolean)
    const hay = norm([c.cmd, c.args, c.short, c.detail, ...(c.aliases || []), ...(c.examples || []), catTitle(c.cat)].join(' '))
    return words.every((w) => {
      const word = w.replace(/^\./, '')
      return hay.includes(word) || (SYNONYMS[word] && (c.cmd === SYNONYMS[word] || hay.includes(SYNONYMS[word])))
    })
  }

  function highlight(text, q) {
    const words = q.split(/\s+/).map((w) => w.replace(/^\./, '')).filter((w) => w.length > 1)
    if (!words.length) return esc(text)
    const re = new RegExp('(' + words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi')
    return String(text).split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('')
  }

  function renderCommands() {
    const { commands } = state.catalog
    const q = norm(state.cmdQuery.trim())
    const rawQ = state.cmdQuery.trim()
    const list = commands.filter((c) => (state.cmdCat === 'all' || c.cat === state.cmdCat) && matches(c, q))
    const p = esc(state.prefix)
    $('cmdList').innerHTML = list
      .map((c, i) => {
        const detail = c.detail || (c.short ? c.short.charAt(0).toUpperCase() + c.short.slice(1) + '.' : '')
        return `<article class="cmd" style="--i:${Math.min(i, 20)}" data-cmd="${esc(c.cmd)}">
          <button class="cmd-head" type="button" aria-expanded="false" aria-controls="cmd-${esc(c.cmd)}">
            <span class="cmd-emoji" aria-hidden="true">${CAT_EMOJI[c.cat] || '•'}</span>
            <span><span class="cmd-name">${p}${highlight(c.cmd, rawQ)}</span><span class="cmd-args">${esc(c.args)}</span>${c.cat === 'media' ? '<span class="badge-public">ouvert à tous</span>' : ''}<span class="cmd-short">${highlight(c.short, rawQ)}</span></span>
            <svg class="cmd-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="cmd-body" id="cmd-${esc(c.cmd)}"><div><div class="cmd-body-inner">
            <p>${waFormat(esc(detail))}</p>
            ${c.examples?.length ? `<div class="cmd-ex">${c.examples.map((e) => `<button class="ex" type="button" data-copy="${esc(state.prefix + e)}" title="Copier">${esc(state.prefix + e)}</button>`).join('')}</div>` : ''}
            ${c.aliases?.length ? `<p class="cmd-alias">Autres noms : ${c.aliases.map((a) => `<code>${esc(state.prefix + a)}</code>`).join(', ')}</p>` : ''}
          </div></div></div>
        </article>`
      })
      .join('')
    $('cmdEmpty').classList.toggle('hidden', list.length > 0)
    $('cmdCount').textContent = list.length === commands.length ? `${list.length} commandes` : `${list.length} sur ${commands.length} commandes`
  }

  function openCommand(cmd) {
    const card = $('cmdList').querySelector(`.cmd[data-cmd="${CSS.escape(cmd)}"]`)
    if (!card) return
    card.classList.add('open')
    card.querySelector('.cmd-head').setAttribute('aria-expanded', 'true')
    card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' })
  }

  $('cmdList').addEventListener('click', (e) => {
    const ex = e.target.closest('.ex')
    if (ex) return copy(ex.dataset.copy)
    const head = e.target.closest('.cmd-head')
    if (!head) return
    const card = head.closest('.cmd')
    const open = card.classList.toggle('open')
    head.setAttribute('aria-expanded', String(open))
  })
  $('cmdCats').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip')
    if (!chip) return
    state.cmdCat = chip.dataset.cat
    renderCats()
    renderCommands()
  })
  let searchTimer
  $('cmdSearch').addEventListener('input', () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      state.cmdQuery = $('cmdSearch').value
      if (state.catalog) renderCommands()
    }, 90)
  })
  $('cmdSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('cmdSearch').value = ''
      state.cmdQuery = ''
      if (state.catalog) renderCommands()
    }
  })

  // ───────────── Architecture interactive ─────────────
  const NODES = {
    whatsapp: ['📱 Ton WhatsApp', "Ton téléphone reste l'appareil principal. Le bot y est relié comme un « appareil connecté », exactement comme WhatsApp Web."],
    site: ['🌐 Ce site', "Il sert à relier ton compte (code ou QR), à récupérer ton SESSION_ID et à déconnecter le bot. Protégé par ADMIN_PASSWORD."],
    baileys: ['🔌 Baileys', 'Bibliothèque open source qui parle le protocole de WhatsApp Web. Non officielle : garde le bot pour un usage personnel.'],
    bot: ['🤖 Le bot', 'Le cœur, en Node.js sur Render : il lit les messages, exécute tes commandes, gère la mémoire, le mode discret, les groupes et le délai de réponse.'],
    nvidia: ['🧠 NVIDIA', 'Les modèles de build.nvidia.com écrivent les réponses (Nemotron par défaut, ou le modèle choisi avec .model) et décrivent les images reçues.'],
    storage: ['💾 Stockage', 'MongoDB (facultatif) garde réglages, discussions actives et mémoire. Sans base : un fichier local, effacé à chaque redémarrage sur Render.'],
    media: ['🎵 yt-dlp + ffmpeg', 'Recherche YouTube, téléchargement et conversion en MP3 ou MP4 pour .song et .video. Installés automatiquement.'],
  }
  const EDGES = [['whatsapp', 'baileys'], ['baileys', 'bot'], ['bot', 'nvidia'], ['bot', 'storage'], ['bot', 'media'], ['site', 'bot']]
  const SVGNS = 'http://www.w3.org/2000/svg'
  const nodeEl = (k) => $('arch').querySelector(`[data-node="${k}"]`)
  const edgePaths = {}

  function showNode(k) {
    $$('#arch .node').forEach((n) => n.classList.toggle('sel', n.dataset.node === k))
    const [title, text] = NODES[k]
    $('archInfo').innerHTML = `<b>${esc(title)}</b> — ${esc(text)}`
  }

  function anchor(r, box, toward, horizontal) {
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
    if (horizontal) {
      const x = toward.x > r.left + r.width / 2 ? r.right : r.left
      return { x: x - box.left, y: clamp(toward.y, r.top + 18, r.bottom - 18) - box.top }
    }
    const y = toward.y > r.top + r.height / 2 ? r.bottom : r.top
    return { x: clamp(toward.x, r.left + 18, r.right - 18) - box.left, y: y - box.top }
  }

  function drawArch() {
    const arch = $('arch')
    const svg = $('archLines')
    const box = arch.getBoundingClientRect()
    if (!box.width) return
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`)
    svg.innerHTML = ''
    for (const [a, b] of EDGES) {
      const ra = nodeEl(a).getBoundingClientRect()
      const rb = nodeEl(b).getBoundingClientRect()
      const ca = { x: ra.left + ra.width / 2, y: ra.top + ra.height / 2 }
      const cb = { x: rb.left + rb.width / 2, y: rb.top + rb.height / 2 }
      const gapX = Math.max(rb.left - ra.right, ra.left - rb.right)
      const gapY = Math.max(rb.top - ra.bottom, ra.top - rb.bottom)
      const horizontal = gapX >= gapY
      const p1 = anchor(ra, box, cb, horizontal)
      const p2 = anchor(rb, box, ca, horizontal)
      const d = horizontal
        ? `M${p1.x},${p1.y} C${(p1.x + p2.x) / 2},${p1.y} ${(p1.x + p2.x) / 2},${p2.y} ${p2.x},${p2.y}`
        : `M${p1.x},${p1.y} C${p1.x},${(p1.y + p2.y) / 2} ${p2.x},${(p1.y + p2.y) / 2} ${p2.x},${p2.y}`
      const path = document.createElementNS(SVGNS, 'path')
      path.setAttribute('d', d)
      svg.append(path)
      edgePaths[a + '-' + b] = path
      if (!reduceMotion) {
        const dot = document.createElementNS(SVGNS, 'circle')
        dot.setAttribute('r', '3')
        const mo = document.createElementNS(SVGNS, 'animateMotion')
        mo.setAttribute('dur', (2.6 + Math.random() * 1.6).toFixed(2) + 's')
        mo.setAttribute('repeatCount', 'indefinite')
        mo.setAttribute('path', d)
        dot.append(mo)
        svg.append(dot)
      }
    }
  }
  let archRaf = 0
  const scheduleArch = () => {
    cancelAnimationFrame(archRaf)
    archRaf = requestAnimationFrame(drawArch)
  }
  if ('ResizeObserver' in window) new ResizeObserver(scheduleArch).observe($('arch'))
  addEventListener('resize', scheduleArch)
  $$('#arch .node').forEach((n) => { n.onclick = () => showNode(n.dataset.node) })
  showNode('bot')

  function pulseEdge(key, reverse) {
    const path = edgePaths[key]
    if (!path) return
    path.classList.add('hot')
    setTimeout(() => path.classList.remove('hot'), 900)
    if (reduceMotion) return
    const dot = document.createElementNS(SVGNS, 'circle')
    dot.setAttribute('class', 'big')
    dot.setAttribute('r', '6')
    const mo = document.createElementNS(SVGNS, 'animateMotion')
    mo.setAttribute('dur', '0.75s')
    mo.setAttribute('fill', 'freeze')
    mo.setAttribute('begin', 'indefinite')
    mo.setAttribute('path', path.getAttribute('d'))
    if (reverse) {
      mo.setAttribute('keyPoints', '1;0')
      mo.setAttribute('keyTimes', '0;1')
      mo.setAttribute('calcMode', 'linear')
    }
    dot.append(mo)
    $('archLines').append(dot)
    try { mo.beginElement() } catch {}
    setTimeout(() => dot.remove(), 900)
  }

  let simRunning = false
  $('simBtn').onclick = async () => {
    if (simRunning) return
    simRunning = true
    const btn = $('simBtn')
    btn.disabled = true
    btn.textContent = '⏳ Simulation…'
    const journey = $$('#journey li')
    const hot = (k) => $$('#arch .node').forEach((n) => n.classList.toggle('hot', n.dataset.node === k))
    const step = (i) => journey.forEach((li, j) => li.classList.toggle('hot', j === i))
    const say = (html) => { $('archInfo').innerHTML = html }
    const seq = [
      () => { hot('whatsapp'); step(0); say('<b>1.</b> Léa écrit « Tu fais quoi ce soir ? » sur ton WhatsApp.') },
      () => pulseEdge('whatsapp-baileys'),
      () => { hot('baileys'); say('<b>2.</b> Baileys reçoit le message en même temps que ton téléphone.') },
      () => pulseEdge('baileys-bot'),
      () => { hot('bot'); step(1); say('<b>3.</b> Le bot vérifie : IA active ici ? groupe ? délai .meai ?') },
      () => pulseEdge('bot-storage'),
      () => { hot('storage'); say('<b>4.</b> Il relit la mémoire de la discussion et tes réglages.') },
      () => pulseEdge('bot-storage', true),
      () => pulseEdge('bot-nvidia'),
      () => { hot('nvidia'); step(2); say('<b>5.</b> Le modèle NVIDIA écrit la réponse (⚙️ s\'affiche pendant ce temps).') },
      () => pulseEdge('bot-nvidia', true),
      () => { hot('bot'); say('<b>6.</b> Le bot découpe la réponse si besoin et joint les fichiers.') },
      () => pulseEdge('baileys-bot', true),
      () => pulseEdge('whatsapp-baileys', true),
      () => { hot('whatsapp'); step(3); say('<b>7.</b> ✅ Léa reçoit la réponse, en quelques secondes.') },
    ]
    for (const fn of seq) {
      fn()
      await sleep(820)
    }
    await sleep(1200)
    hot(null)
    step(-1)
    showNode('bot')
    btn.disabled = false
    btn.textContent = '↻ Rejouer la simulation'
    simRunning = false
  }

  // ───────────── Générateur de variables ─────────────
  function randomPassword(len = 20) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    const buf = new Uint32Array(len)
    crypto.getRandomValues(buf)
    return Array.from(buf, (n) => chars[n % chars.length]).join('')
  }
  function updateEnv() {
    const v = (id, fallback = '') => ($(id).value || '').trim() || fallback
    const line = (k, val) => `<span class="k">${k}</span>=<span class="v">${esc(val)}</span>`
    $('envOut').innerHTML = [
      '<span class="c"># Render → Environment (ou fichier .env)</span>',
      line('NVIDIA_API_KEY', 'nvapi-ta-cle-ici'),
      line('ADMIN_PASSWORD', v('envPwd')),
      line('BOT_NAME', v('envBot', 'Nova')),
      line('OWNER_NAME', v('envOwner')),
      line('TIME_ZONE', v('envTz', 'Europe/Paris')),
      '<span class="c"># Après l\'appairage :</span>',
      line('SESSION_ID', ''),
    ].join('\n')
  }
  $('envPwd').value = randomPassword()
  $('envPwdGen').onclick = () => {
    $('envPwd').value = randomPassword()
    updateEnv()
    toast('Nouveau mot de passe généré 🎲')
  }
  for (const id of ['envBot', 'envOwner', 'envTz', 'envPwd']) $(id).addEventListener('input', updateEnv)
  updateEnv()
  $('healthUrl').textContent = location.origin + '/health'
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy-from]')
    if (b) copy($(b.dataset.copyFrom).textContent, b)
  })

  // ───────────── Navigation, défilement, thème ─────────────
  const nav = $('nav')
  const onScroll = () => {
    const y = scrollY
    nav.classList.toggle('scrolled', y > 10)
    const max = document.documentElement.scrollHeight - innerHeight
    $('progress').style.setProperty('--p', max > 0 ? (y / max).toFixed(4) : 0)
    $('toTop').classList.toggle('show', y > 900)
  }
  addEventListener('scroll', onScroll, { passive: true })
  onScroll()
  $('toTop').onclick = () => scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })

  const links = $('navLinks')
  const setMenu = (open) => {
    links.classList.toggle('open', open)
    $('menuBtn').setAttribute('aria-expanded', String(open))
  }
  $('menuBtn').onclick = () => setMenu(!links.classList.contains('open'))
  links.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false) })
  document.addEventListener('click', (e) => { if (!e.target.closest('#nav')) setMenu(false) })

  if ('IntersectionObserver' in window) {
    const navMap = new Map($$('#navLinks a').map((a) => [a.getAttribute('href').slice(1), a]))
    const spy = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        for (const a of navMap.values()) a.classList.remove('active')
        navMap.get(e.target.id)?.classList.add('active')
      }
    }, { rootMargin: '-45% 0px -50% 0px' })
    for (const id of navMap.keys()) if ($(id)) spy.observe($(id))
  }

  const themeMeta = document.querySelector('meta[name="theme-color"]')
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t
    themeMeta.content = t === 'light' ? '#f2f6f8' : '#060b10'
  }
  applyTheme(document.documentElement.dataset.theme || 'dark')
  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
    applyTheme(next)
    try { localStorage.setItem('theme', next) } catch {}
  }
  $('themeToggle').onclick = toggleTheme

  // Apparition au défilement
  if ('IntersectionObserver' in window && !reduceMotion) {
    const groups = new Map()
    for (const el of $$('[data-reveal]')) {
      const list = groups.get(el.parentElement) || []
      el.style.setProperty('--d', Math.min(list.length, 6) * 70 + 'ms')
      list.push(el)
      groups.set(el.parentElement, list)
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        e.target.classList.add('in')
        io.unobserve(e.target)
      }
    }, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' })
    $$('[data-reveal]').forEach((el) => io.observe(el))
  } else {
    $$('[data-reveal]').forEach((el) => el.classList.add('in'))
  }

  // Compteurs animés
  function runCounter(el) {
    const target = Number(el.dataset.count) || 0
    el.dataset.done = '1'
    if (reduceMotion) return void (el.textContent = String(target))
    const t0 = performance.now()
    const frame = (t) => {
      const k = Math.min(1, (t - t0) / 1400)
      el.textContent = String(Math.round(target * (1 - Math.pow(1 - k, 3))))
      if (k < 1) requestAnimationFrame(frame)
      else el.textContent = el.dataset.count
    }
    requestAnimationFrame(frame)
  }
  $$('.counter').forEach((el) => once(el, () => runCounter(el)))

  // Téléphone 3D : suit la souris et le défilement
  const stage = $('stage')
  let pointer = { x: 0, y: 0 }
  const applyStage = () => {
    const s = Math.min(1, scrollY / 700)
    stage.style.setProperty('--ry', (-16 + pointer.x * 16 + s * 22).toFixed(2) + 'deg')
    stage.style.setProperty('--rx', (6 - pointer.y * 10 + s * 8).toFixed(2) + 'deg')
  }
  if (!reduceMotion) {
    if (finePointer) {
      addEventListener('pointermove', (e) => {
        if (scrollY > innerHeight) return
        pointer = { x: e.clientX / innerWidth - 0.5, y: e.clientY / innerHeight - 0.5 }
        applyStage()
      }, { passive: true })
    }
    addEventListener('scroll', () => { if (scrollY < innerHeight * 1.2) applyStage() }, { passive: true })
  }

  // Cartes inclinables en 3D
  if (finePointer && !reduceMotion) {
    for (const card of $$('.tilt')) {
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect()
        const px = (e.clientX - r.left) / r.width
        const py = (e.clientY - r.top) / r.height
        card.classList.add('tilting')
        card.style.setProperty('--ty', ((px - 0.5) * 9).toFixed(2) + 'deg')
        card.style.setProperty('--tx', ((0.5 - py) * 9).toFixed(2) + 'deg')
        card.style.setProperty('--mx', (px * 100).toFixed(1) + '%')
        card.style.setProperty('--my', (py * 100).toFixed(1) + '%')
      })
      card.addEventListener('pointerleave', () => {
        card.classList.remove('tilting')
        card.style.setProperty('--ty', '0deg')
        card.style.setProperty('--tx', '0deg')
      })
    }
  }

  // ───────────── Recherche rapide (Ctrl + K) ─────────────
  const SECTIONS = [
    ['🏠', 'Accueil', 'Haut de la page', 'top'],
    ['📊', 'Tableau de bord', 'État du bot en direct', 'dashboard'],
    ['🔗', 'Connexion', 'Code, QR code ou SESSION_ID', 'connect'],
    ['✨', 'Fonctionnalités', 'Tout ce que fait le bot', 'features'],
    ['🎭', 'Modes IA', '.ai, .meai et .aai expliqués', 'modes'],
    ['📖', 'Commandes', 'Liste complète avec exemples', 'commands'],
    ['🧭', 'Comment ça marche', "Le trajet d'un message", 'how'],
    ['🚀', 'Installation', 'GitHub + Render en 5 étapes', 'guide'],
    ['❓', 'FAQ & dépannage', 'Problèmes fréquents', 'faq'],
  ]
  let paletteItems = []
  let paletteSel = 0
  let paletteView = []
  const goTo = (id) => $(id)?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' })
  function buildPalette() {
    paletteItems = [
      ...SECTIONS.map(([icon, title, sub, id]) => ({ icon, title, sub, kind: 'Section', run: () => goTo(id) })),
      { icon: '🌓', title: 'Changer de thème', sub: 'Clair / sombre', kind: 'Action', run: toggleTheme },
      { icon: '📷', title: 'Se connecter avec un QR code', sub: 'Ouvre l\'onglet QR code', kind: 'Action', run: () => { selectTab('qr'); goTo('connect') } },
      { icon: '🔢', title: 'Se connecter avec un code', sub: "Ouvre l'onglet Code", kind: 'Action', run: () => { selectTab('code'); goTo('connect'); setTimeout(() => $('phone').focus({ preventScroll: true }), 500) } },
      { icon: '▶️', title: 'Lancer la simulation', sub: "Voir le trajet d'un message", kind: 'Action', run: () => { goTo('how'); setTimeout(() => $('simBtn').click(), 600) } },
      { icon: '🎲', title: 'Générer un mot de passe', sub: 'Pour ADMIN_PASSWORD', kind: 'Action', run: () => { goTo('guide'); $('envPwdGen').click() } },
      { icon: '🩺', title: 'État du serveur', sub: '/health', kind: 'Action', run: () => open('/health', '_blank', 'noopener') },
      ...(state.catalog?.commands || []).map((c) => ({
        icon: CAT_EMOJI[c.cat] || '•',
        title: state.prefix + c.cmd + (c.args ? ' ' + c.args : ''),
        sub: c.short,
        kind: 'Commande',
        keys: [c.cmd, ...(c.aliases || [])].join(' '),
        run: () => {
          state.cmdCat = 'all'
          state.cmdQuery = ''
          $('cmdSearch').value = ''
          renderCats()
          renderCommands()
          openCommand(c.cmd)
        },
      })),
    ]
  }
  buildPalette()
  function renderPalette() {
    const q = norm($('paletteInput').value.trim()).replace(/^\./, '')
    paletteView = paletteItems.filter((it) => !q || norm(`${it.title} ${it.sub} ${it.keys || ''} ${it.kind}`).includes(q)).slice(0, 40)
    paletteSel = Math.min(paletteSel, Math.max(0, paletteView.length - 1))
    $('paletteList').innerHTML = paletteView.length
      ? paletteView
          .map((it, i) => `<li role="option" data-i="${i}" class="${i === paletteSel ? 'active' : ''}" aria-selected="${i === paletteSel}"><span class="pi">${it.icon}</span><span class="pt"><b>${esc(it.title)}</b><small>${esc(it.sub)}</small></span><span class="pk">${it.kind}</span></li>`)
          .join('')
      : '<li class="none">Aucun résultat</li>'
    $('paletteList').querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }
  const paletteOpen = () => !$('palette').classList.contains('hidden')
  function openPalette() {
    $('palette').classList.remove('hidden')
    $('paletteInput').value = ''
    paletteSel = 0
    renderPalette()
    $('paletteInput').focus()
  }
  function closePalette() {
    $('palette').classList.add('hidden')
  }
  function runPalette(i) {
    const it = paletteView[i]
    if (!it) return
    closePalette()
    it.run()
  }
  $('paletteBtn').onclick = openPalette
  $('paletteInput').addEventListener('input', () => { paletteSel = 0; renderPalette() })
  $('paletteInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteSel = Math.min(paletteView.length - 1, paletteSel + 1); renderPalette() }
    if (e.key === 'ArrowUp') { e.preventDefault(); paletteSel = Math.max(0, paletteSel - 1); renderPalette() }
    if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteSel) }
  })
  $('paletteList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]')
    if (li) runPalette(Number(li.dataset.i))
  })
  $('palette').addEventListener('click', (e) => { if (e.target === $('palette')) closePalette() })

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      paletteOpen() ? closePalette() : openPalette()
      return
    }
    if (e.key === 'Escape') {
      if (paletteOpen()) closePalette()
      setMenu(false)
      return
    }
    if (e.key === '/' && !typing && $('modal').classList.contains('hidden') && !paletteOpen()) {
      e.preventDefault()
      goTo('commands')
      setTimeout(() => $('cmdSearch').focus({ preventScroll: true }), reduceMotion ? 0 : 450)
    }
  })

  // ───────────── Démarrage ─────────────
  refresh()
  loadCommands()
})()
