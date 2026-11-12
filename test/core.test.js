import test from 'node:test'
import assert from 'node:assert/strict'
import { zipSync } from 'fflate'
import { entryErrors, findDuplicate, mergeImportUpdate, normalizeImportRow, parseCSV, suggestColumnMapping } from '../src/core.js'
import { assertSafeZip } from '../src/xlsx.js'

test('parses quoted CSV fields, embedded commas, newlines and escaped quotes', () => {
  assert.deepEqual(parseCSV('Mot,Meaning,Example\r\nbonjour,"hello, hi","Il dit ""salut""\ntous les jours"'), [
    ['Mot', 'Meaning', 'Example'],
    ['bonjour', 'hello, hi', 'Il dit "salut"\ntous les jours'],
  ])
})

test('detects semicolon-separated CSV and ignores a UTF-8 BOM', () => {
  assert.deepEqual(parseCSV('\uFEFFMot;Sens\r\nété;été, saison chaude'), [
    ['Mot', 'Sens'],
    ['été', 'été, saison chaude'],
  ])
})

test('suggests known column names and normalizes optional values', () => {
  const headers = ['Từ gốc', 'Phiên âm', 'Loại từ/Giống', 'Nghĩa', 'Ví dụ đơn giản']
  const mapping = suggestColumnMapping(headers)
  const entry = normalizeImportRow(['un étudiant', '/e.ty.djɑ̃/', 'nom', 'student', ''], mapping, { category: 'Leçon 1' })
  assert.equal(mapping.term, '0')
  assert.equal(entry.word, 'un étudiant')
  assert.equal(entry.meaning, 'student')
  assert.deepEqual(entry.categories, ['Leçon 1'])
  assert.equal(entry.categoriesProvided, true)
  assert.equal(entry.language, 'fr-FR')
  assert.deepEqual(entryErrors(entry), [])
})

test('preserves explicit empty category columns for update previews', () => {
  const entry = normalizeImportRow(['bonjour', 'hello', ''], { term: '0', meaning: '1', category: '2' })
  const merged = mergeImportUpdate(entry, { categories: ['Leçon 1'] })
  assert.deepEqual(entry.categories, [])
  assert.equal(entry.categoriesProvided, true)
  assert.deepEqual(merged.categories, [])
})

test('preserves existing categories when the import has no category field', () => {
  const entry = normalizeImportRow(['bonjour', 'hello'], { term: '0', meaning: '1' })
  const merged = mergeImportUpdate(entry, {
    word: 'bonjour', pronunciation: '/bɔ̃.ʒuʁ/', part_of_speech: 'interjection',
    meaning: 'xin chào', example: 'bonjour à tous', read_text: 'bonjour',
    language: 'fr-FR', categories: ['Leçon 1'],
  })
  assert.deepEqual(merged.categories, ['Leçon 1'])
  assert.equal(entry.categoriesProvided, false)
  assert.equal(merged.meaning, 'hello')
  assert.equal(merged.pronunciation, '/bɔ̃.ʒuʁ/')
  assert.equal(merged.example, 'bonjour à tous')
})

test('clears fields that are mapped to blank values during an update', () => {
  const entry = normalizeImportRow(['bonjour', 'hello', ''], {
    term: '0', meaning: '1', pronunciation: '2',
  })
  const merged = mergeImportUpdate(entry, { pronunciation: '/bɔ̃.ʒuʁ/', categories: ['Leçon 1'] })
  assert.equal(merged.pronunciation, '')
  assert.deepEqual(merged.categories, ['Leçon 1'])
})

test('identifies duplicates by normalized word and language without conflating languages', () => {
  const existing = [{ word: ' Bonjour ', language: 'fr-FR', id: 'existing' }]
  assert.equal(findDuplicate({ word: 'bonjour', language: 'FR-fr' }, existing).id, 'existing')
  assert.equal(findDuplicate({ word: 'bonjour', language: 'en-US' }, existing), null)
})

test('marks missing required fields for explicit exclusion in import preview', () => {
  assert.deepEqual(entryErrors({ word: 'bonjour', meaning: ' ' }), ['Thiếu nghĩa'])
})

test('accepts a normal zip archive for workbook parsing', () => {
  const archive = zipSync({ 'xl/workbook.xml': new TextEncoder().encode('<workbook/>') })
  assert.doesNotThrow(() => assertSafeZip(archive))
})

test('rejects zip entries whose expanded content exceeds the import limit', () => {
  const archive = zipSync({ 'xl/workbook.xml': new TextEncoder().encode('<workbook/>') })
  const centralDirectory = archive.findIndex((byte, index) =>
    byte === 0x50 && archive[index + 1] === 0x4b && archive[index + 2] === 0x01 && archive[index + 3] === 0x02,
  )
  new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    .setUint32(centralDirectory + 24, 41 * 1024 * 1024, true)
  assert.throws(() => assertSafeZip(archive), /40 MB/)
})
