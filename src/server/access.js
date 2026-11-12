export function emailAllowed(email, allowlist = process.env.ALLOWED_EMAILS ?? '') {
  return typeof email === 'string' && allowlist.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean).includes(email.toLowerCase())
}

export function googleAllowed(profile, allowlist) {
  return Boolean(profile?.sub && profile.email_verified === true && emailAllowed(profile.email, allowlist))
}

export function configured() {
  return ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL', 'ALLOWED_EMAILS', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_DATABASE_ID', 'CLOUDFLARE_D1_TOKEN']
    .every((key) => Boolean(process.env[key]?.trim()))
}