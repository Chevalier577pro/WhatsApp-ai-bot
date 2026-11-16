import http from 'node:http'

/** /health : sonde de vie. / : redirection vers le site d'appairage public. */
export function createHealthServer({ wa, pairingSiteUrl }) {
  return http.createServer((req, res) => {
    const p = req.url?.split('?')[0]
    if (['GET', 'HEAD'].includes(req.method) && (p === '/' || p === '/index.html')) {
      res.writeHead(302, { Location: pairingSiteUrl, 'Cache-Control': 'no-store' })
      return res.end()
    }
    const ok = ['GET', 'HEAD'].includes(req.method) && p === '/health'
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(ok ? { ok: true, status: wa.status, uptime: Math.round(process.uptime()) } : { error: 'Page introuvable.' }))
  })
}
