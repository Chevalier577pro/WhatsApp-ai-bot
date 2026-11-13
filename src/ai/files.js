/**
 * Fichiers créés par l'IA : elle écrit leur contenu entre <file name="page.html"> et </file>,
 * le bot retire ces blocs du texte et les envoie comme documents WhatsApp.
 */
const MAX_FILES = 5
const MAX_BYTES = 5 * 1024 * 1024

const MIME = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  py: 'text/x-python',
  sh: 'application/x-sh',
  sql: 'application/sql',
  rtf: 'application/rtf',
}

// Nom entre guillemets ou non : <file name="a.txt">, <file name='a.txt'>, <file name=a.txt>
const OPEN = /<(file|fichier)\s+(?:file)?(?:name|nom)\s*=\s*(?:"([^"\n<>]{1,150})"|'([^'\n<>]{1,150})'|([^\s"'<>]{1,150}))\s*>/i
const MEMORY_MAX = 1500 // caractères d'un fichier gardés dans la mémoire de l'IA

export function mimeFor(name) {
  const ext = String(name || '').split('.').pop().toLowerCase()
  return MIME[ext] || 'text/plain'
}

/** Nom de fichier sûr (sans dossier ni caractère interdit), avec une extension. */
export function cleanFileName(name) {
  let n = String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[<>:"|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 100)
  if (!n) n = 'fichier'
  if (!/\.[a-z0-9]{1,8}$/i.test(n)) n += '.txt'
  return n
}

/** Retire un éventuel bloc ```lang ... ``` qui entoure tout le contenu. */
function unfence(content) {
  const m = content.match(/^\s*```[\w+-]*[ \t]*\n([\s\S]*?)\n?```\s*$/)
  return m ? m[1] : content
}

/**
 * Sépare le texte de la réponse et les fichiers.
 * -> { text, files: [{ name, mimetype, content: Buffer, truncated }] }
 * Un bloc non refermé (réponse coupée par la limite de tokens) est gardé, marqué truncated.
 */
export function extractFiles(raw) {
  let rest = String(raw ?? '')
  const files = []
  let text = ''
  for (;;) {
    const open = rest.match(OPEN)
    if (!open) break
    text += rest.slice(0, open.index)
    const after = rest.slice(open.index + open[0].length)
    const close = after.match(/<\/(file|fichier)\s*>/i)
    const body = close ? after.slice(0, close.index) : after
    rest = close ? after.slice(close.index + close[0].length) : ''
    const content = unfence(body.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, ''))
    if (!content.trim() || files.length >= MAX_FILES) continue
    const name = cleanFileName(open[2] ?? open[3] ?? open[4])
    let buf = Buffer.from(content, 'utf8')
    if (buf.length > MAX_BYTES) buf = buf.subarray(0, MAX_BYTES)
    files.push({ name, mimetype: mimeFor(name), content: buf, truncated: !close })
  }
  text += rest
  if (files.length) {
    // Les blocs ```...``` vides laissés autour des balises
    text = text.replace(/```[\w+-]*\s*```/g, '').replace(/\n{3,}/g, '\n\n')
  }
  return { text: text.trim(), files }
}

/**
 * Fichier tel que l'IA le retrouve dans sa mémoire : avec les vraies balises, pour qu'elle
 * reprenne ce format (une simple mention « fichier envoyé » était recopiée sans rien envoyer).
 */
export function fileForMemory(file) {
  const c = Buffer.isBuffer(file.content) ? file.content.toString('utf8') : String(file.content ?? '')
  return { n: String(file.name).slice(0, 100), c: c.slice(0, MEMORY_MAX), ...(c.length > MEMORY_MAX ? { cut: 1 } : {}) }
}

export const fileFromMemory = (f) => `<file name="${f.n}">\n${f.c}\n</file>${f.cut ? '\n(début du fichier seulement)' : ''}`

/** Ancienne trace mémorisée à la place des fichiers (à retirer des vieux historiques). */
export const LEGACY_MEMO = /\n?\[📎 fichier envoyé : [^\]\n]*\]/g

/** La réponse annonce-t-elle un fichier ? (à vérifier quand aucun fichier n'a été extrait) */
export function claimsFile(text) {
  return /📎|<\/?(file|fichier)\b|ci-joint|pi[eè]ce jointe|(fichier|document)[^\n]{0,40}envoy|envoy[^\n]{0,40}(fichier|document)|voici[^\n]{0,30}(fichier|document)/i.test(
    String(text || ''),
  )
}

/** Retire les faux « 📎 fichier envoyé » d'une réponse sans fichier. */
export const stripFakeFiles = (text) =>
  String(text || '')
    .replace(/\[?[ \t]*📎[^\n\]]*\]?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
