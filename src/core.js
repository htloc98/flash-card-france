const headerAliases = {
  term: ['từ gốc', 'tu goc', 'mot', 'mot français', 'mot francais', 'word', 'term'],
  pronunciation: ['phiên âm', 'phien am', 'pronunciation', 'ipa'],
  part: ['loại từ/giống', 'loai tu/giong', 'loại từ', 'loai tu', 'genre', 'part of speech'],
  meaning: ['nghĩa', 'nghia', 'translation', 'meaning', 'definition'],
  example: ['ví dụ đơn giản', 'vi du don gian', 'ví dụ', 'vi du', 'example', 'note'],
  readText: ['văn bản đọc', 'van ban doc', 'read text', 'spoken text'],
  category: ['category', 'catégorie', 'categorie', 'nhóm', 'nhom', 'bài học', 'bai hoc'],
  language: ['ngôn ngữ', 'ngon ngu', 'language', 'lang'],
}

export function serializeCSV(rows) {
  return '\uFEFF' + rows.map((row) => row.map((value) => {
    const text = String(value ?? '')
    const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text) ? `'${text}` : text
    return `"${safe.replaceAll('"', '""')}"`
  }).join(',')).join('\r\n')
}

export function parseCSV(text) {
  const source = text.replace(/^\uFEFF/, '')
  const firstLine = source.split(/\r?\n/, 1)[0] ?? ''
  const delimiters = [',', ';', '\t']
  const delimiter = delimiters.reduce((best, candidate) => {
    const count = countDelimiter(firstLine, candidate)
    return count > best.count ? { delimiter: candidate, count } : best
  }, { delimiter: ',', count: -1 }).delimiter
  const rows = []
  let row = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === delimiter && !quoted) {
      row.push(cell)
      cell = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1
      row.push(cell)
      if (row.some((value) => value.trim())) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += character
    }
  }

  if (cell || row.length) {
    row.push(cell)
    if (row.some((value) => value.trim())) rows.push(row)
  }
  return rows
}

function countDelimiter(line, delimiter) {
  let quoted = false
  let count = 0
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') {
      if (quoted && line[index + 1] === '"') index += 1
      else quoted = !quoted
    } else if (line[index] === delimiter && !quoted) {
      count += 1
    }
  }
  return count
}

export function suggestColumnMapping(headers) {
  const normalized = headers.map((header) => String(header ?? '').trim().toLocaleLowerCase())
  return Object.fromEntries(Object.entries(headerAliases).map(([field, aliases]) => {
    const index = normalized.findIndex((header) => aliases.includes(header))
    return [field, index < 0 ? '' : String(index)]
  }))
}

export function normalizeImportRow(row, mapping, defaults = {}) {
  const value = (field) => {
    const index = mapping[field]
    return index === '' || index === undefined ? '' : String(row[Number(index)] ?? '').trim()
  }
  const categories = value('category') || defaults.category || ''
  return {
    word: value('term'),
    pronunciation: value('pronunciation'),
    part_of_speech: value('part'),
    meaning: value('meaning'),
    example: value('example'),
    read_text: value('readText'),
    language: (value('language') || defaults.language || 'fr-FR').trim(),
    categories: categories.split(/[|;]/).map((category) => category.trim()).filter(Boolean),
    categoriesProvided: Boolean(mapping.category) || Boolean(defaults.category),
    mapped: {
      word: Boolean(mapping.term),
      pronunciation: Boolean(mapping.pronunciation),
      part_of_speech: Boolean(mapping.part),
      meaning: Boolean(mapping.meaning),
      example: Boolean(mapping.example),
      read_text: Boolean(mapping.readText),
      language: Boolean(mapping.language),
    },
  }
}

export function mergeImportUpdate(entry, existing) {
  const merged = { ...entry }
  for (const field of Object.keys(entry.mapped ?? {})) {
    if (!entry.mapped[field]) merged[field] = existing[field] ?? ''
  }
  if (!entry.categoriesProvided) {
    merged.categories = (existing.categories ?? [])
      .map((category) => typeof category === 'string' ? category : category.name)
      .filter(Boolean)
  }
  return merged
}

export function findDuplicate(entry, entries) {
  const word = entry.word.trim().toLocaleLowerCase()
  const language = entry.language.trim().toLocaleLowerCase()
  return entries.find((candidate) =>
    candidate.word.trim().toLocaleLowerCase() === word &&
    candidate.language.trim().toLocaleLowerCase() === language,
  ) ?? null
}

export function entryErrors(entry) {
  const errors = []
  if (!entry.word.trim()) errors.push('Thiếu từ gốc')
  if (!entry.meaning.trim()) errors.push('Thiếu nghĩa')
  return errors
}
