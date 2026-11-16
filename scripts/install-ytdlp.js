// Télécharge yt-dlp dans bin/ pendant « npm install » (utilisé par .song et .video).
// Ne fait jamais échouer l'installation : en cas de souci, yt-dlp sera téléchargé au premier .song/.video.
import { commandVersion, installYtdlp, localYtdlpPath } from '../src/media/tools.js'

async function main() {
  if (process.env.SKIP_YTDLP_DOWNLOAD) {
    console.log('yt-dlp : téléchargement ignoré (SKIP_YTDLP_DOWNLOAD).')
    return
  }
  const current = await commandVersion(localYtdlpPath()).catch(() => null)
  if (current) {
    console.log(`✅ yt-dlp ${current} déjà présent dans bin/`)
    return
  }
  const bin = await installYtdlp()
  console.log(`✅ yt-dlp ${bin.version} installé dans bin/`)
}

main()
  .catch((err) => {
    console.warn(`⚠️ yt-dlp non téléchargé (${err?.message || err}) : il sera téléchargé au premier .song/.video.`)
  })
  .finally(() => process.exit(0))
