import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeImportRow, parseCSV, suggestColumnMapping } from '../core.js'

export async function lessonEntries() {
  const source = await readFile(path.join(process.cwd(), 'data', 'Mots_nouveaux_Lecon_1_v2.csv'), 'utf8')
  const [headers, ...rows] = parseCSV(source)
  const mapping = suggestColumnMapping(headers)
  return rows.map((row) => {
    const { mapped, categoriesProvided, ...entry } = normalizeImportRow(row, mapping, { category: 'Leçon 1', language: 'fr-FR' })
    return entry
  })
}