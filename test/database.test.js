import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createRepository, seedStatements } from '../src/server/database.js'
import { lessonEntries } from '../src/server/lesson.js'
import { statementsToSql } from '../scripts/csv-to-sql.js'

const schema = await readFile(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8')

function fixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(schema)
  const execute = async (statements) => {
    sqlite.exec('BEGIN')
    try {
      const results = statements.map(({ sql, params = [] }) => ({ results: sqlite.prepare(sql).all(...params) }))
      sqlite.exec('COMMIT')
      return results
    } catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }
  }
  const repository = createRepository(execute)
  return { sqlite, execute, repository }
}

const vocabulary = { word: "S'appeler", pronunciation: '/s‿a.p(ə).le/', part_of_speech: 'Động từ (Verbe)', meaning: 'gọi tên, tên là', example: "Je m'appelle Marie.", language: 'fr-FR', read_text: '', categories: ['Leçon 1'] }

test('CSV-to-SQL output executes safely and is repeatable', async () => {
  const { repository, sqlite } = fixture()
  try {
    const owner = await repository.ensureUser({ sub: 'google-1', email: 'one@example.com', name: 'One' })
    const entries = await lessonEntries()
    const sql = statementsToSql(seedStatements(owner.id, entries))
    sqlite.exec(sql)
    sqlite.exec(sql)
    assert.equal((await repository.load(owner.id)).words.length, 21)
    assert.equal((await repository.load(owner.id)).words[0].word, "S'appeler")
    const hostile = { ...vocabulary, word: "'); DROP TABLE users; --", meaning: '?;\nquoted "value"' }
    sqlite.exec(statementsToSql(seedStatements(owner.id, [hostile], 'hostile-text')))
    assert.equal((await repository.load(owner.id)).words.length, 22)
  } finally { sqlite.close() }
})

test('composite foreign keys reject cross-account category assignments', async () => {
  const { repository, sqlite } = fixture()
  try {
    const owner = await repository.ensureUser({ sub: 'google-1', email: 'one@example.com', name: 'One' })
    const other = await repository.ensureUser({ sub: 'google-2', email: 'two@example.com', name: 'Two' })
    await repository.save(owner.id, { ...vocabulary, id: 'one-word' })
    await repository.save(other.id, { ...vocabulary, id: 'two-word' })
    const category = sqlite.prepare('SELECT id FROM categories WHERE owner_id = ?').get(other.id)
    assert.throws(() => sqlite.prepare('INSERT INTO vocabulary_categories VALUES (?, ?, ?)').run(owner.id, 'one-word', category.id), /FOREIGN KEY/)
  } finally { sqlite.close() }
})

test('CSV seed preserves all 21 rows, accents, IPA and quoted commas', async () => {
  const entries = await lessonEntries()
  assert.equal(entries.length, 21)
  assert.deepEqual(entries[0], vocabulary)
  assert.equal(entries[1].example, 'Bonjour, comment ça va ?')
})

test('library reads are bounded and paginate without dropping or duplicating words', async () => {
  const { repository, execute, sqlite } = fixture()
  try {
    const owner = await repository.ensureUser({ sub: 'google-pages', email: 'pages@example.com', name: 'Pages' })
    const entries = Array.from({ length: 205 }, (_, index) => ({ ...vocabulary, word: `word-${index}`, meaning: 'x'.repeat(10000), example: 'y'.repeat(10000) }))
    await execute(seedStatements(owner.id, entries))
    const first = await repository.load(owner.id)
    assert.equal(first.words.length, 25)
    assert.ok(first.nextCursor)
    const second = await repository.load(owner.id, first.nextCursor)
    assert.equal(second.words.length, 25)
    const allWords = [...first.words, ...second.words]
    let cursor = second.nextCursor
    while (cursor !== null) {
      const page = await repository.load(owner.id, cursor)
      assert.ok(page.words.length <= 25)
      allWords.push(...page.words)
      cursor = page.nextCursor
    }
    assert.equal(new Set(allWords.map((word) => word.id)).size, 205)
    assert.deepEqual(second.words[0].categories, ['Leçon 1'])
    await assert.rejects(repository.load(owner.id, -1), /cursor/i)
  } finally { sqlite.close() }
})

test('seed is atomic, per-account, idempotent and does not restore deleted words', async () => {
  const { repository, execute, sqlite } = fixture()
  try {
    const owner = await repository.ensureUser({ sub: 'google-1', email: 'one@example.com', name: 'One' })
    const other = await repository.ensureUser({ sub: 'google-2', email: 'two@example.com', name: 'Two' })
    const entries = await lessonEntries()
    await execute(seedStatements(owner.id, entries))
    await execute(seedStatements(owner.id, entries))
    await execute(seedStatements(other.id, entries))
    const data = await repository.load(owner.id)
    assert.equal(data.words.length, 21)
    assert.deepEqual(data.words[0].categories, ['Leçon 1'])
    await repository.remove(owner.id, data.words[0].id)
    await execute(seedStatements(owner.id, entries))
    assert.equal((await repository.load(owner.id)).words.length, 20)
    assert.equal((await repository.load(other.id)).words.length, 21)
  } finally { sqlite.close() }
})

test('Google subject is stable and all reads, updates and deletes enforce ownership', async () => {
  const { repository, sqlite } = fixture()
  try {
    const owner = await repository.ensureUser({ sub: 'google-1', email: 'one@example.com', name: 'One' })
    const again = await repository.ensureUser({ sub: 'google-1', email: 'new@example.com', name: 'New' })
    assert.equal(owner.id, again.id)
    const other = await repository.ensureUser({ sub: 'google-2', email: 'two@example.com', name: 'Two' })
    const saved = await repository.save(owner.id, { ...vocabulary, id: 'word-1', owner_id: other.id })
    assert.equal(saved.word, vocabulary.word)
    assert.equal((await repository.load(other.id)).words.length, 0)
    await assert.rejects(repository.save(other.id, { ...vocabulary, id: 'word-1' }, true), /not found/i)
    await assert.rejects(repository.remove(other.id, 'word-1'), /not found/i)
    await assert.rejects(repository.save(other.id, { ...vocabulary, id: 'word-1' }), /conflict/i)
    assert.equal((await repository.load(owner.id)).words[0].meaning, vocabulary.meaning)
  } finally { sqlite.close() }
})

test('word and category edits roll back together on a database error', async () => {
  const { repository, sqlite } = fixture()
  try {
    const owner = await repository.ensureUser({ sub: 'google-1', email: 'one@example.com', name: 'One' })
    await repository.save(owner.id, { ...vocabulary, id: 'word-1' })
    sqlite.exec("CREATE TRIGGER reject_category BEFORE INSERT ON categories WHEN NEW.name = 'Fail' BEGIN SELECT RAISE(ABORT, 'Category failure'); END")
    await assert.rejects(repository.save(owner.id, { ...vocabulary, id: 'word-1', meaning: 'changed', categories: ['Fail'] }, true), /Category failure/)
    const saved = (await repository.load(owner.id)).words[0]
    assert.equal(saved.meaning, vocabulary.meaning)
    assert.deepEqual(saved.categories, ['Leçon 1'])
    await repository.save(owner.id, { ...saved, categories: [] }, true)
    assert.deepEqual((await repository.load(owner.id)).words[0].categories, [])
  } finally { sqlite.close() }
})

test('validates input and saves settings separately per user', async () => {
  const { repository, sqlite } = fixture()
  try {
    const owner = await repository.ensureUser({ sub: 'google-1', email: 'one@example.com', name: 'One' })
    const other = await repository.ensureUser({ sub: 'google-2', email: 'two@example.com', name: 'Two' })
    await assert.rejects(repository.save(owner.id, { ...vocabulary, meaning: ' ' }), /meaning/)
    await assert.rejects(repository.save(owner.id, { ...vocabulary, categories: ['a'.repeat(101)] }), /categor/)
    await assert.rejects(repository.settings(owner.id, { frontDelay: 11, backDelay: 4, autoSpeak: false }), /settings/)
    await repository.settings(owner.id, { frontDelay: 2, backDelay: 7, autoSpeak: true })
    assert.deepEqual((await repository.load(owner.id)).settings, { frontDelay: 2, backDelay: 7, autoSpeak: true })
    assert.deepEqual((await repository.load(other.id)).settings, { frontDelay: 4, backDelay: 4, autoSpeak: false })
  } finally { sqlite.close() }
})