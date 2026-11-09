/** Nettoie un numéro saisi sur le site -> chiffres uniquement, format international sans "+". */
export function normalizePhone(raw) {
  let digits = String(raw ?? '').trim()
  if (digits.startsWith('+')) digits = digits.slice(1)
  digits = digits.replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (!digits) throw new Error('Entre ton numéro WhatsApp avec l\'indicatif du pays (ex : 33612345678).')
  if (digits.startsWith('0')) {
    throw new Error("Ajoute l'indicatif du pays et enlève le 0 du début (ex : 33612345678 pour un 06 12 34 56 78 en France).")
  }
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Numéro invalide : indicatif pays + numéro, sans espace (ex : 33612345678).')
  }
  return digits
}

/** "33612345678@s.whatsapp.net" -> "+33612345678" */
export function jidToNumber(jid) {
  if (!jid || typeof jid !== 'string') return ''
  const user = jid.split('@')[0].split(':')[0]
  return /^\d+$/.test(user) ? `+${user}` : user
}

/** "33612345678" -> "+33 6•••••78" (affichage public sur le site) */
export function maskNumber(number) {
  const d = String(number ?? '').replace(/\D/g, '')
  if (d.length < 6) return d ? `+${d}` : ''
  return `+${d.slice(0, 3)}${'•'.repeat(Math.max(0, d.length - 5))}${d.slice(-2)}`
}
