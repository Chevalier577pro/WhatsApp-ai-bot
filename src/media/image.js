import { runProcess } from './tools.js'

/** Taille max (base64) d'une image envoyée directement dans la requête : certains modèles NVIDIA refusent au-delà. */
export const INLINE_MAX_B64 = 180_000
const SUPPORTED = /^image\/(jpeg|png|webp)$/
const STEPS = [
  [1280, 4],
  [1024, 6],
  [768, 8],
  [512, 10],
]

const b64Length = (buf) => Math.ceil(buf.length / 3) * 4
const isJpeg = (buf) => buf?.length > 3 && buf[0] === 0xff && buf[1] === 0xd8

async function toJpeg(ffmpeg, input, size, quality) {
  try {
    const scale = `scale='min(${size},iw)':'min(${size},ih)':force_original_aspect_ratio=decrease`
    const res = await runProcess(
      ffmpeg.path,
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', scale, '-q:v', String(quality), '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
      { input, timeoutMs: 30_000 },
    )
    return res.code === 0 && isJpeg(res.stdoutBuffer) ? res.stdoutBuffer : null
  } catch {
    return null
  }
}

/**
 * Prépare une image pour un modèle de vision : JPEG/PNG/WebP sous INLINE_MAX_B64.
 * Réduite avec ffmpeg si besoin ; sans ffmpeg, elle part telle quelle.
 */
export async function fitImage(buffer, mimetype = 'image/jpeg', ffmpeg = null) {
  const mime = String(mimetype || '').split(';')[0].trim().toLowerCase() || 'image/jpeg'
  if (SUPPORTED.test(mime) && b64Length(buffer) <= INLINE_MAX_B64) return { image: buffer, mimetype: mime }
  let best = null
  if (ffmpeg?.path) {
    for (const [size, quality] of STEPS) {
      const out = await toJpeg(ffmpeg, buffer, size, quality)
      if (!out) break
      best = out
      if (b64Length(out) <= INLINE_MAX_B64) break
    }
  }
  if (best) return { image: best, mimetype: 'image/jpeg' }
  return { image: buffer, mimetype: SUPPORTED.test(mime) ? mime : 'image/jpeg' }
}
