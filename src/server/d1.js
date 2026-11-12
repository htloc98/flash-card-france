import { HttpError } from './database.js'

export function createD1({ accountId, databaseId, token, fetchImpl = fetch }) {
  return async (statements) => {
    if (!accountId || !databaseId || !token) throw new HttpError(503, 'Cloud database is not configured')
    let response
    let payload
    try {
      response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch: statements }),
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      })
      payload = await response.json()
    } catch {
      throw new HttpError(503, 'Cloud database is unavailable. Please reload before retrying a save.')
    }
    if (!response.ok || !payload.success || !Array.isArray(payload.result) || payload.result.length !== statements.length || payload.result.some((result) => !result.success)) {
      throw new HttpError(503, 'Cloud database request failed. Check configuration or usage limits, then reload.')
    }
    return payload.result.map((result) => ({ ...result, results: result.results ?? [] }))
  }
}

export const execute = (statements) => createD1({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  databaseId: process.env.CLOUDFLARE_DATABASE_ID,
  token: process.env.CLOUDFLARE_D1_TOKEN,
})(statements)