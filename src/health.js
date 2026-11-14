import http from 'node:http'

// Point de contrôle pour Render. Le site d’appairage est hébergé séparément.
export function createHealthServer({ wa }) {
  return http.createServer((req, res) => {
    const ok = ['GET', 'HEAD'].includes(req.method) && ['/', '/health'].includes(req.url?.split('?')[0])
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(ok ? { ok: true, status: wa.status, uptime: Math.round(process.uptime()) } : { error: 'Page introuvable.' }))
  })
}
