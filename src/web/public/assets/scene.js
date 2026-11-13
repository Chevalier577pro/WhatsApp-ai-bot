// Scène 3D du héros : un « cerveau » en particules (sphère de Fibonacci), des signaux qui
// circulent entre les neurones, des anneaux en orbite et des bulles de message.
// Canvas 2D + projection perspective maison : aucune bibliothèque (la CSP bloque les CDN).
;(() => {
  'use strict'
  const canvas = document.getElementById('scene')
  if (!canvas || !canvas.getContext) return
  const ctx = canvas.getContext('2d')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const small = innerWidth < 700
  const N = small ? 300 : 520
  const D = 3.2 // distance de la caméra, en rayons
  const STOPS = [
    [37, 211, 102],
    [34, 211, 238],
    [139, 92, 246],
  ]
  const mix = (t) => {
    const k = t < 0.5 ? t * 2 : (t - 0.5) * 2
    const [a, b] = t < 0.5 ? [STOPS[0], STOPS[1]] : [STOPS[1], STOPS[2]]
    return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k))
  }

  // Neurones
  const pts = []
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const th = i * Math.PI * (3 - Math.sqrt(5))
    const jitter = 1 + (Math.random() - 0.5) * 0.06
    pts.push({ x: Math.cos(th) * r * jitter, y: y * jitter, z: Math.sin(th) * r * jitter, c: mix((y + 1) / 2), ph: Math.random() * 6.28, sx: 0, sy: 0, sz: 0, s: 1 })
  }

  // Synapses : quelques voisins proches par neurone
  const edges = []
  const maxD2 = (small ? 0.3 : 0.23) ** 2
  const degree = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (degree[i] >= 3 || degree[j] >= 3) continue
      const dx = pts[i].x - pts[j].x
      const dy = pts[i].y - pts[j].y
      const dz = pts[i].z - pts[j].z
      if (dx * dx + dy * dy + dz * dz < maxD2) {
        edges.push([i, j])
        degree[i]++
        degree[j]++
      }
    }
  }

  // Anneaux en orbite
  const rings = [
    { r: 1.32, tiltX: 1.15, tiltZ: 0.35, speed: 0.22, n: small ? 50 : 80, c: [34, 211, 238] },
    { r: 1.45, tiltX: 1.35, tiltZ: -0.6, speed: -0.14, n: small ? 60 : 100, c: [139, 92, 246] },
  ]

  // Bulles de message en orbite
  const bubbles = Array.from({ length: small ? 4 : 6 }, (_, i) => ({
    r: 1.18 + Math.random() * 0.22,
    a: (i / (small ? 4 : 6)) * Math.PI * 2,
    incl: (Math.random() - 0.5) * 1.2,
    speed: 0.18 + Math.random() * 0.12,
    out: i % 2 === 0,
  }))

  // Étoiles de fond
  const stars = Array.from({ length: small ? 70 : 140 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random(), ph: Math.random() * 6.28 }))

  const signals = []
  let W = 0
  let H = 0
  let dpr = 1
  let cx = 0
  let cy = 0
  let R = 100
  let rotY = 0
  let rotX = 0.35
  let target = { x: 0, y: 0 }
  let cur = { x: 0, y: 0 }
  let last = performance.now()
  let raf = 0
  let onScreen = true

  function resize() {
    const rect = canvas.getBoundingClientRect()
    dpr = Math.min(2, devicePixelRatio || 1)
    W = rect.width
    H = rect.height
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const wide = W > 980
    cx = wide ? W * 0.735 : W * 0.5
    cy = wide ? H * 0.5 : H - Math.min(330, H * 0.3)
    R = Math.min(W, H) * (wide ? 0.34 : 0.4)
    if (reduce) draw(0)
  }

  function project(x, y, z, cY, sY, cX, sX) {
    // rotation Y puis X
    const x1 = x * cY + z * sY
    const z1 = -x * sY + z * cY
    const y1 = y * cX - z1 * sX
    const z2 = y * sX + z1 * cX
    const s = D / (D - z2)
    return [cx + x1 * R * s, cy + y1 * R * s, z2, s]
  }

  function bubble(x, y, s, alpha, out, t) {
    const w = 38 * s
    const h = 24 * s
    const r = 8 * s
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.moveTo(x - w / 2 + r, y - h / 2)
    ctx.arcTo(x + w / 2, y - h / 2, x + w / 2, y + h / 2, r)
    ctx.arcTo(x + w / 2, y + h / 2, x - w / 2, y + h / 2, r)
    ctx.lineTo(x - w / 2 + (out ? w - 6 * s : 6 * s), y + h / 2)
    ctx.lineTo(x + (out ? w / 2 + 4 * s : -w / 2 - 4 * s), y + h / 2 + 5 * s)
    ctx.lineTo(x - w / 2 + (out ? w - 14 * s : 14 * s), y + h / 2)
    ctx.arcTo(x - w / 2, y + h / 2, x - w / 2, y - h / 2, r)
    ctx.arcTo(x - w / 2, y - h / 2, x + w / 2, y - h / 2, r)
    ctx.closePath()
    ctx.fillStyle = out ? '#005c4b' : '#1f2c34'
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = out ? 'rgba(37,211,102,.7)' : 'rgba(255,255,255,.18)'
    ctx.stroke()
    ctx.fillStyle = '#e9edef'
    for (let k = -1; k <= 1; k++) {
      const bounce = Math.sin(t * 6 + k) * 1.6 * s
      ctx.beginPath()
      ctx.arc(x + k * 8 * s, y + bounce, 2.2 * s, 0, 6.283)
      ctx.fill()
    }
  }

  function draw(dt) {
    const t = performance.now() / 1000
    const light = document.documentElement.dataset.theme === 'light'
    ctx.clearRect(0, 0, W, H)

    cur.x += (target.x - cur.x) * 0.05
    cur.y += (target.y - cur.y) * 0.05
    rotY += dt * 0.00012
    const ay = rotY + cur.x * 0.6
    const ax = 0.32 + cur.y * 0.4
    rotX = ax
    const cY = Math.cos(ay)
    const sY = Math.sin(ay)
    const cX = Math.cos(rotX)
    const sX = Math.sin(rotX)

    // Étoiles
    for (const st of stars) {
      const px = (st.x * W + cur.x * -30 * st.z + W) % W
      const py = (st.y * H + cur.y * -30 * st.z + H) % H
      const a = (0.25 + 0.55 * st.z) * (0.6 + 0.4 * Math.sin(t * 1.5 + st.ph))
      ctx.globalAlpha = light ? a * 0.35 : a
      ctx.fillStyle = light ? '#334155' : '#cbd5e1'
      ctx.fillRect(px, py, 1.4 * st.z + 0.4, 1.4 * st.z + 0.4)
    }

    // Halo central
    const pulse = 0.85 + Math.sin(t * 1.4) * 0.15
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.25)
    g.addColorStop(0, light ? `rgba(34,211,238,${0.16 * pulse})` : `rgba(37,211,102,${0.2 * pulse})`)
    g.addColorStop(0.5, light ? 'rgba(139,92,246,0.06)' : 'rgba(34,211,238,0.07)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalAlpha = 1
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(cx, cy, R * 1.25, 0, 6.283)
    ctx.fill()

    // Projection des neurones
    for (const p of pts) {
      const [x, y, z, s] = project(p.x, p.y, p.z, cY, sY, cX, sX)
      p.sx = x
      p.sy = y
      p.sz = z
      p.s = s
    }

    // Bulles derrière la sphère
    const bubbleProj = bubbles.map((b) => {
      const a = b.a + t * b.speed
      const x = Math.cos(a) * b.r
      const z = Math.sin(a) * b.r
      const y = Math.sin(a * 0.7) * 0.25 + b.incl * Math.sin(a) * 0.5
      return [b, ...project(x, y, z, Math.cos(rotY * 0.5), Math.sin(rotY * 0.5), cX, sX)]
    })
    const drawBubbles = (front) => {
      for (const [b, x, y, z, s] of bubbleProj) {
        if (front !== z >= 0) continue
        bubble(x, y, s, (0.35 + 0.65 * ((z + 1.6) / 3.2)) * (light ? 0.9 : 0.85), b.out, t + b.a)
      }
    }
    drawBubbles(false)

    // Synapses, regroupées par profondeur pour limiter les appels de dessin
    const buckets = [[], [], [], []]
    for (const [i, j] of edges) {
      const d = (pts[i].sz + pts[j].sz) / 2
      buckets[Math.max(0, Math.min(3, Math.floor(((d + 1) / 2) * 4)))].push(i, j)
    }
    ctx.lineWidth = 1
    buckets.forEach((list, k) => {
      ctx.globalAlpha = light ? 0.05 + k * 0.07 : 0.05 + k * 0.08
      ctx.strokeStyle = light ? '#0e7490' : '#5eead4'
      ctx.beginPath()
      for (let n = 0; n < list.length; n += 2) {
        const a = pts[list[n]]
        const b = pts[list[n + 1]]
        ctx.moveTo(a.sx, a.sy)
        ctx.lineTo(b.sx, b.sy)
      }
      ctx.stroke()
    })

    // Neurones
    for (const p of pts) {
      const depth = (p.sz + 1) / 2
      const tw = 0.75 + 0.25 * Math.sin(t * 2 + p.ph)
      ctx.globalAlpha = (0.12 + 0.88 * depth) * tw * (light ? 0.85 : 1)
      const [r, gg, b] = p.c
      ctx.fillStyle = light ? `rgb(${r * 0.6 | 0},${gg * 0.6 | 0},${b * 0.75 | 0})` : `rgb(${r},${gg},${b})`
      const size = (0.7 + depth * 1.9) * p.s
      ctx.beginPath()
      ctx.arc(p.sx, p.sy, size, 0, 6.283)
      ctx.fill()
    }

    // Signaux qui voyagent sur les synapses
    if (!reduce && edges.length) {
      if (signals.length < (small ? 8 : 16) && Math.random() < 0.18) {
        const e = edges[(Math.random() * edges.length) | 0]
        signals.push({ e, k: 0, sp: 0.0012 + Math.random() * 0.0012, flip: Math.random() < 0.5 })
      }
      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'
      for (let n = signals.length - 1; n >= 0; n--) {
        const sg = signals[n]
        sg.k += sg.sp * dt
        if (sg.k >= 1) {
          signals.splice(n, 1)
          continue
        }
        const [i, j] = sg.flip ? [sg.e[1], sg.e[0]] : sg.e
        const a = pts[i]
        const b = pts[j]
        const x = a.sx + (b.sx - a.sx) * sg.k
        const y = a.sy + (b.sy - a.sy) * sg.k
        const depth = ((a.sz + b.sz) / 2 + 1) / 2
        const rad = 7 * (0.5 + depth)
        const gl = ctx.createRadialGradient(x, y, 0, x, y, rad)
        gl.addColorStop(0, light ? 'rgba(14,116,144,0.9)' : 'rgba(255,255,255,0.95)')
        gl.addColorStop(0.35, light ? 'rgba(11,155,74,0.45)' : 'rgba(37,211,102,0.6)')
        gl.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.globalAlpha = Math.sin(sg.k * Math.PI) * (0.4 + 0.6 * depth)
        ctx.fillStyle = gl
        ctx.beginPath()
        ctx.arc(x, y, rad, 0, 6.283)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    // Anneaux
    for (const ring of rings) {
      const cTz = Math.cos(ring.tiltZ)
      const sTz = Math.sin(ring.tiltZ)
      const cTx = Math.cos(ring.tiltX)
      const sTx = Math.sin(ring.tiltX)
      const [r, gg, b] = ring.c
      ctx.fillStyle = light ? `rgb(${r * 0.6 | 0},${gg * 0.6 | 0},${b * 0.8 | 0})` : `rgb(${r},${gg},${b})`
      for (let k = 0; k < ring.n; k++) {
        const a = (k / ring.n) * 6.283 + t * ring.speed
        const x = Math.cos(a) * ring.r
        const z = Math.sin(a) * ring.r
        // inclinaison de l'anneau (y = 0 dans son plan)
        const y1 = -z * sTx
        const z1 = z * cTx
        const x2 = x * cTz - y1 * sTz
        const y2 = x * sTz + y1 * cTz
        const [px, py, pz, s] = project(x2, y2, z1, cY, sY, cX, sX)
        const depth = (pz + ring.r) / (2 * ring.r)
        ctx.globalAlpha = (0.1 + 0.7 * depth) * (0.5 + 0.5 * Math.sin(a * 3 + t * 2) ** 2)
        ctx.beginPath()
        ctx.arc(px, py, (0.6 + depth * 1.4) * s, 0, 6.283)
        ctx.fill()
      }
    }

    drawBubbles(true)
    ctx.globalAlpha = 1
  }

  function loop(now) {
    const dt = Math.min(50, now - last)
    last = now
    draw(dt)
    raf = requestAnimationFrame(loop)
  }
  function start() {
    if (raf || reduce || !onScreen || document.hidden) return
    last = performance.now()
    raf = requestAnimationFrame(loop)
  }
  function stop() {
    cancelAnimationFrame(raf)
    raf = 0
  }

  addEventListener('pointermove', (e) => {
    target = { x: e.clientX / innerWidth - 0.5, y: e.clientY / innerHeight - 0.5 }
  }, { passive: true })
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()))
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      onScreen = entries[0].isIntersecting
      onScreen ? start() : stop()
    }).observe(canvas)
  }
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas)
  else addEventListener('resize', resize)
  resize()
  if (reduce) draw(0)
  else start()
})()
