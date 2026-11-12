import { randomUUID } from 'node:crypto'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const fields = ['word', 'pronunciation', 'part_of_speech', 'meaning', 'example', 'read_text', 'language']
const limits = { word: 500, pronunciation: 1000, part_of_speech: 500, meaning: 10000, example: 10000, read_text: 500, language: 35 }
const statement = (sql, params = []) => ({ sql, params })

export function validateWord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Invalid vocabulary')
  const entry = {}
  for (const field of fields) {
    const value = input[field] ?? (field === 'language' ? 'fr-FR' : '')
    if (typeof value !== 'string' || value.length > limits[field]) throw new HttpError(400, `Invalid ${field}`)
    entry[field] = value.trim()
  }
  if (!entry.word || !entry.meaning) throw new HttpError(400, 'word and meaning are required')
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(entry.language)) throw new HttpError(400, 'Invalid language')
  if (!Array.isArray(input.categories) || input.categories.length > 20 || input.categories.some((name) => typeof name !== 'string' || !name.trim() || name.length > 100)) {
    throw new HttpError(400, 'Invalid categories (maximum 20, 100 characters each)')
  }
  entry.categories = [...new Set(input.categories.map((name) => name.trim()))]
  return entry
}

export function validateSettings(input) {
  if (!input || ![input.frontDelay, input.backDelay].every((value) => Number.isInteger(value) && value >= 1 && value <= 10) || typeof input.autoSpeak !== 'boolean') {
    throw new HttpError(400, 'Invalid settings')
  }
  return { frontDelay: input.frontDelay, backDelay: input.backDelay, autoSpeak: input.autoSpeak }
}

function categoryStatements(ownerId, wordId, categories) {
  return categories.flatMap((name) => [
    statement('INSERT INTO categories (id, owner_id, name) VALUES (?, ?, ?) ON CONFLICT(owner_id, name) DO NOTHING', [randomUUID(), ownerId, name]),
    statement(`INSERT OR IGNORE INTO vocabulary_categories (owner_id, vocabulary_id, category_id)
      SELECT ?, vocabularies.id, categories.id FROM categories JOIN vocabularies ON vocabularies.owner_id = categories.owner_id
      WHERE categories.owner_id = ? AND categories.name = ? AND vocabularies.id = ?`, [ownerId, ownerId, name, wordId]),
  ])
}

export function createRepository(execute) {
  async function get(ownerId, id) {
    const [result] = await execute([statement('SELECT * FROM vocabularies WHERE owner_id = ? AND id = ?', [ownerId, id])])
    return result.results[0]
  }
  return {
    async ensureUser(profile) {
      const results = await execute([
        statement(`INSERT INTO users (id, google_sub, email, name) VALUES (?, ?, ?, ?)
          ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name`, [randomUUID(), profile.sub, profile.email, profile.name ?? '']),
        statement('SELECT id, email, name FROM users WHERE google_sub = ?', [profile.sub]),
      ])
      return results[1].results[0]
    },
    async load(ownerId, after = 0) {
      if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'Invalid cursor')
      const [words, links, settings] = await execute([
        statement('SELECT rowid AS page_cursor, * FROM vocabularies WHERE owner_id = ? AND rowid > ? ORDER BY rowid LIMIT 25', [ownerId, after]),
        statement(`SELECT links.vocabulary_id, categories.name FROM vocabulary_categories links
          JOIN categories ON categories.id = links.category_id AND categories.owner_id = links.owner_id
          WHERE links.owner_id = ? AND links.vocabulary_id IN
          (SELECT id FROM vocabularies WHERE owner_id = ? AND rowid > ? ORDER BY rowid LIMIT 25)
          ORDER BY categories.name`, [ownerId, ownerId, after]),
        statement('SELECT * FROM user_settings WHERE owner_id = ?', [ownerId]),
      ])
      const categories = new Map()
      for (const link of links.results) {
        if (!categories.has(link.vocabulary_id)) categories.set(link.vocabulary_id, [])
        categories.get(link.vocabulary_id).push(link.name)
      }
      const saved = settings.results[0]
      return {
        words: words.results.map(({ owner_id, page_cursor, ...word }) => ({ ...word, categories: categories.get(word.id) ?? [] })),
        nextCursor: words.results.length === 25 ? words.results.at(-1).page_cursor : null,
        settings: saved ? { frontDelay: saved.front_delay, backDelay: saved.back_delay, autoSpeak: Boolean(saved.auto_speak) } : { frontDelay: 4, backDelay: 4, autoSpeak: false },
      }
    },
    async save(ownerId, input, update = false) {
      const entry = validateWord(input)
      const id = input.id ?? randomUUID()
      if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(id)) throw new HttpError(400, 'Invalid id')
      if (update && !await get(ownerId, id)) throw new HttpError(404, 'Vocabulary not found')
      const statements = update ? [
        statement(`UPDATE vocabularies SET ${fields.map((field) => `${field} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE owner_id = ? AND id = ?`, [...fields.map((field) => entry[field]), ownerId, id]),
        statement('DELETE FROM vocabulary_categories WHERE owner_id = ? AND vocabulary_id = ?', [ownerId, id]),
      ] : [
        statement(`INSERT INTO vocabularies (id, owner_id, ${fields.join(', ')}) VALUES (${Array(9).fill('?').join(', ')})`, [id, ownerId, ...fields.map((field) => entry[field])]),
      ]
      if (!update) {
        const [existing] = await execute([statement('SELECT owner_id FROM vocabularies WHERE id = ?', [id])])
        if (existing.results.length) throw new HttpError(409, 'Vocabulary id conflict')
      }
      await execute([...statements, ...categoryStatements(ownerId, id, entry.categories)])
      const saved = await get(ownerId, id)
      if (!saved) throw new HttpError(404, 'Vocabulary not found')
      const { owner_id, ...word } = saved
      return { ...word, categories: entry.categories }
    },
    async remove(ownerId, id) {
      const [result] = await execute([statement('DELETE FROM vocabularies WHERE owner_id = ? AND id = ? RETURNING id', [ownerId, id])])
      if (!result.results.length) throw new HttpError(404, 'Vocabulary not found')
    },
    async settings(ownerId, input) {
      const settings = validateSettings(input)
      await execute([statement(`INSERT INTO user_settings (owner_id, front_delay, back_delay, auto_speak) VALUES (?, ?, ?, ?)
        ON CONFLICT(owner_id) DO UPDATE SET front_delay = excluded.front_delay, back_delay = excluded.back_delay, auto_speak = excluded.auto_speak`,
      [ownerId, settings.frontDelay, settings.backDelay, Number(settings.autoSpeak)])])
      return settings
    },
  }
}

export function seedStatements(ownerId, entries, seedKey = 'lesson-1-v2') {
  const pending = 'NOT EXISTS (SELECT 1 FROM seed_imports WHERE owner_id = ? AND seed_key = ?)'
  const statements = []
  for (const [index, input] of entries.entries()) {
    const entry = validateWord(input)
    const wordId = `${ownerId}:${seedKey}:${index}`
    statements.push(statement(`INSERT INTO vocabularies (id, owner_id, ${fields.join(', ')}) SELECT ${Array(9).fill('?').join(', ')} WHERE ${pending}`,
      [wordId, ownerId, ...fields.map((field) => entry[field]), ownerId, seedKey]))
    for (const name of entry.categories) {
      statements.push(statement(`INSERT INTO categories (id, owner_id, name) SELECT ?, ?, ? WHERE ${pending} ON CONFLICT(owner_id, name) DO NOTHING`,
        [randomUUID(), ownerId, name, ownerId, seedKey]))
      statements.push(statement(`INSERT INTO vocabulary_categories (owner_id, vocabulary_id, category_id)
        SELECT ?, ?, id FROM categories WHERE owner_id = ? AND name = ? AND ${pending}`,
      [ownerId, wordId, ownerId, name, ownerId, seedKey]))
    }
  }
  statements.push(statement('INSERT INTO seed_imports (owner_id, seed_key) VALUES (?, ?) ON CONFLICT DO NOTHING', [ownerId, seedKey]))
  return statements
}