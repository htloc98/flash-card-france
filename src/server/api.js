import { HttpError } from './database.js'

async function readBody(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Expected application/json')
  const maximum = 65536
  if (Number(request.headers.get('content-length')) > maximum) throw new HttpError(413, 'Request too large')
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, 'Missing JSON body')
  const chunks = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maximum) {
      await reader.cancel()
      throw new HttpError(413, 'Request too large')
    }
    chunks.push(value)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid object')
    return body
  } catch {
    throw new HttpError(400, 'Invalid JSON body')
  }
}

export function createApi({ getUser, repository, origin }) {
  return async (request) => {
    const respond = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' } })
    try {
      const user = await getUser()
      if (!user?.id) throw new HttpError(401, 'Please sign in again')
      const url = new URL(request.url)
      const method = request.method
      if (method !== 'GET' && request.headers.get('origin') !== (origin ? new URL(origin).origin : url.origin)) throw new HttpError(403, 'Invalid request origin')
      const path = url.pathname.replace(/\/$/, '')
      if (method === 'GET' && path === '/api/data') return respond(await repository.load(user.id, Number(url.searchParams.get('after') ?? 0)))
      if (method === 'PUT' && path === '/api/data/settings') return respond(await repository.settings(user.id, await readBody(request)))
      if (method === 'POST' && path === '/api/data/words') return respond(await repository.save(user.id, await readBody(request)), 201)
      const match = path.match(/^\/api\/data\/words\/([a-zA-Z0-9:_-]{1,160})$/)
      if (match && method === 'PUT') return respond(await repository.save(user.id, { ...await readBody(request), id: match[1] }, true))
      if (match && method === 'DELETE') {
        await repository.remove(user.id, match[1])
        return respond({ deleted: true })
      }
      return respond({ error: 'Not found' }, 404)
    } catch (error) {
      return respond({ error: error instanceof HttpError ? error.message : 'Service unavailable. Please try again.' }, error instanceof HttpError ? error.status : 503)
    }
  }
}