import test from 'node:test'
import assert from 'node:assert/strict'
import { emailAllowed, googleAllowed } from '../src/server/access.js'
import { createApi } from '../src/server/api.js'
import { createD1 } from '../src/server/d1.js'

test('Google login requires a verified email and an explicit allowlist', () => {
  const profile = { sub: '123', email: 'Owner@example.com', email_verified: true }
  assert.equal(googleAllowed(profile, ' owner@example.com,friend@example.com '), true)
  assert.equal(googleAllowed({ ...profile, email_verified: false }, 'owner@example.com'), false)
  assert.equal(googleAllowed({ ...profile, sub: '' }, 'owner@example.com'), false)
  assert.equal(googleAllowed(profile, ''), false)
  assert.equal(googleAllowed(profile, '*'), false)
  assert.equal(emailAllowed('other@example.com', 'owner@example.com'), false)
})

test('API rejects unauthenticated access before reading or writing database', async () => {
  const handle = createApi({ getUser: async () => null, repository: new Proxy({}, { get() { throw new Error('Database must not be accessed') } }) })
  const response = await handle(new Request('https://app.test/api/data'))
  assert.equal(response.status, 401)
  assert.match(response.headers.get('cache-control'), /no-store/)
})

test('API rejects foreign or missing Origin and never trusts a posted owner', async () => {
  const calls = []
  const handle = createApi({ getUser: async () => ({ id: 'real-owner' }), repository: {
    save: async (...args) => { calls.push(args); return { id: 'saved' } },
  } })
  const makeRequest = (origin) => new Request('https://app.test/api/data/words', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify({ owner_id: 'attacker', word: 'bonjour' }),
  })
  assert.equal((await handle(makeRequest('https://evil.test'))).status, 403)
  assert.equal((await handle(makeRequest())) .status, 403)
  assert.equal(calls.length, 0)
  assert.equal((await handle(makeRequest('https://app.test'))).status, 201)
  assert.equal(calls[0][0], 'real-owner')
})

test('API validates content type and body size and hides unexpected errors', async () => {
  const handle = createApi({ getUser: async () => ({ id: 'owner' }), repository: { load: async () => { throw new Error('SECRET_TOKEN sql internal detail') } } })
  const headers = { origin: 'https://app.test', 'content-type': 'application/json' }
  const oversized = new Request('https://app.test/api/data/words', { method: 'POST', headers, body: JSON.stringify({ word: 'x'.repeat(70000) }) })
  assert.equal((await handle(oversized)).status, 413)
  const malformed = new Request('https://app.test/api/data/words', { method: 'POST', headers, body: '{' })
  assert.equal((await handle(malformed)).status, 400)
  const failed = await handle(new Request('https://app.test/api/data'))
  assert.equal(failed.status, 503)
  assert.doesNotMatch(await failed.text(), /SECRET_TOKEN|sql/)
})

test('D1 sends one parameterized batch, disables caching and uses server credentials', async () => {
  const statements = [{ sql: 'SELECT ? AS word', params: ["S'appeler"] }, { sql: 'SELECT 2', params: [] }]
  const execute = createD1({ accountId: 'account', databaseId: 'database', token: 'server-token', fetchImpl: async (url, options) => {
    assert.match(url, /accounts\/account\/d1\/database\/database\/query$/)
    assert.equal(options.headers.Authorization, 'Bearer server-token')
    assert.equal(options.cache, 'no-store')
    assert.deepEqual(JSON.parse(options.body), { batch: statements })
    return Response.json({ success: true, result: [{ success: true, results: [{ word: "S'appeler" }] }, { success: true, results: [] }] })
  } })
  assert.equal((await execute(statements))[0].results[0].word, "S'appeler")
})

test('D1 rejects partial failures and does not retry mutations automatically', async () => {
  let calls = 0
  const execute = createD1({ accountId: 'account', databaseId: 'database', token: 'secret', fetchImpl: async () => {
    calls += 1
    return Response.json({ success: true, result: [{ success: false, error: 'internal sql' }] })
  } })
  await assert.rejects(execute([{ sql: 'INSERT INTO test VALUES (?)', params: ['word'] }]), /database/i)
  assert.equal(calls, 1)
})