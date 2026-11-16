import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

/**
 * Outils externes pour .song / .video :
 *  - yt-dlp : recherche et téléchargement (binaire autonome, sans Python)
 *  - ffmpeg : conversion (fourni par le paquet npm « ffmpeg-static »)
 */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const BIN_DIR = path.join(ROOT_DIR, 'bin')
const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/'

function isMusl() {
  if (process.platform !== 'linux') return false
  try {
    const header = process.report?.getReport?.()?.header
    return header ? !header.glibcVersionRuntime : false
  } catch {
    return false
  }
}

/** Nom du binaire yt-dlp à télécharger pour cette machine. */
export function ytdlpAsset(platform = process.platform, arch = process.arch, musl = isMusl()) {
  if (platform === 'win32') return arch === 'arm64' ? 'yt-dlp_arm64.exe' : arch === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe'
  if (platform === 'darwin') return 'yt-dlp_macos'
  if (platform === 'linux') {
    if (arch === 'arm64') return musl ? 'yt-dlp_musllinux_aarch64' : 'yt-dlp_linux_aarch64'
    if (arch === 'arm') return 'yt-dlp_linux_armv7l'
    return musl ? 'yt-dlp_musllinux' : 'yt-dlp_linux'
  }
  return 'yt-dlp'
}

export function localYtdlpPath() {
  return path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
}

/** Découpe une chaîne d'options (« --proxy http://x --foo "a b" ») en arguments. */
export function splitArgs(str) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(String(str || '')))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/**
 * Lance un programme et récupère sa sortie. Ne lève une erreur que si le programme est introuvable.
 * Le programme est tué (avec ses sous-processus) s'il dépasse timeoutMs.
 */
export function runProcess(cmd, args = [], { timeoutMs = 120_000, input, maxOutput = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32' // groupe de processus : on tue aussi ffmpeg lancé par yt-dlp
    let child
    try {
      child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, detached })
    } catch (err) {
      reject(err)
      return
    }
    const chunks = []
    let size = 0
    let stderr = ''
    let timedOut = false
    const kill = () => {
      try {
        if (detached) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
    }
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true
          kill()
        }, timeoutMs)
      : null
    child.stdout.on('data', (d) => {
      if (size < maxOutput) {
        chunks.push(d)
        size += d.length
      }
    })
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-64_000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const buffer = Buffer.concat(chunks)
      resolve({ code, signal, timedOut, stdout: buffer.toString('utf8'), stdoutBuffer: buffer, stderr })
    })
    if (input) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

/** Première ligne de « <cmd> --version », ou null si le programme ne marche pas. */
export async function commandVersion(cmd, args = ['--version'], timeoutMs = 120_000) {
  if (!cmd) return null
  try {
    const res = await runProcess(cmd, args, { timeoutMs })
    if (res.code !== 0) return null
    return res.stdout.trim().split(/\r?\n/)[0]?.trim() || null
  } catch {
    return null
  }
}

/** Télécharge un fichier (suit les redirections) puis le rend exécutable. */
export async function downloadTo(url, dest, { timeoutMs = 300_000, minBytes = 0, fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'whatsapp-ai-bot' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} pour ${url}`)
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.${process.pid}.${Date.now()}.part`
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp, { mode: 0o755 }))
    const { size } = await fsp.stat(tmp)
    if (size < minBytes) throw new Error(`fichier incomplet (${size} octets)`)
    await fsp.chmod(tmp, 0o755).catch(() => {})
    await fsp.rename(tmp, dest)
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {})
  }
  return dest
}

/** Télécharge la dernière version de yt-dlp dans bin/ et vérifie qu'elle démarre. */
export async function installYtdlp({ dest = localYtdlpPath(), fetchImpl } = {}) {
  const names = [ytdlpAsset()]
  if (process.platform === 'win32') names.push('yt-dlp.exe')
  else names.push(process.platform === 'linux' ? 'yt-dlp_linux' : 'yt-dlp_macos', 'yt-dlp') // « yt-dlp » seul = version Python
  let lastErr = null
  for (const name of [...new Set(names)]) {
    try {
      await downloadTo(RELEASES + name, dest, { minBytes: 1_000_000, fetchImpl })
      const version = await commandVersion(dest)
      if (version) return { path: dest, version, asset: name }
      lastErr = new Error(`${name} ne démarre pas sur cette machine`)
    } catch (err) {
      lastErr = err
    }
  }
  await fsp.rm(dest, { force: true }).catch(() => {})
  throw lastErr || new Error('téléchargement de yt-dlp impossible')
}

/** Chemin de ffmpeg : FFMPEG_PATH, puis le paquet ffmpeg-static, puis celui du système. */
export async function findFfmpeg(preferred) {
  const candidates = []
  if (preferred) candidates.push(preferred)
  try {
    const mod = await import('ffmpeg-static')
    const p = mod?.default ?? mod
    if (typeof p === 'string' && fs.existsSync(p)) candidates.push(p)
  } catch {}
  candidates.push('ffmpeg')
  for (const candidate of candidates) {
    const version = await commandVersion(candidate, ['-hide_banner', '-version'], 60_000)
    if (version && /ffmpeg/i.test(version)) return { path: candidate, version }
  }
  return null
}
