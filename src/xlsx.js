import { unzipSync } from 'fflate'

export const MAX_XLSX_FILE_BYTES = 20 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 40 * 1024 * 1024
const MAX_ZIP_ENTRIES = 500
const MAX_SHEET_ROWS = 10_000

export function assertSafeZip(bytes) {
  if (bytes.length > MAX_XLSX_FILE_BYTES) throw new Error('Tệp Excel vượt quá giới hạn 20 MB.')
  const searchStart = Math.max(0, bytes.length - 65_557)
  let endOffset = -1
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (readUint32(bytes, offset) === 0x06054b50) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) throw new Error('Tệp Excel không phải ZIP hợp lệ.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = view.getUint16(endOffset + 10, true)
  const directorySize = view.getUint32(endOffset + 12, true)
  const directoryOffset = view.getUint32(endOffset + 16, true)
  if (entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('Tệp Excel ZIP64 không được hỗ trợ.')
  }
  if (entries > MAX_ZIP_ENTRIES || directoryOffset + directorySize > endOffset) {
    throw new Error('Tệp Excel có cấu trúc ZIP không hợp lệ.')
  }

  let offset = directoryOffset
  let expandedSize = 0
  for (let index = 0; index < entries; index += 1) {
    if (readUint32(bytes, offset) !== 0x02014b50 || offset + 46 > bytes.length) {
      throw new Error('Tệp Excel có danh sách ZIP không hợp lệ.')
    }
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error('Tệp Excel ZIP64 không được hỗ trợ.')
    }
    expandedSize += uncompressedSize
    if (expandedSize > MAX_UNCOMPRESSED_BYTES) {
      throw new Error('Nội dung giải nén của tệp Excel vượt quá giới hạn 40 MB.')
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  if (offset > directoryOffset + directorySize) throw new Error('Tệp Excel có danh sách ZIP không hợp lệ.')
}

function readUint32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return -1
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
}

function parseXML(text) {
  const document = new DOMParser().parseFromString(text, 'application/xml')
  if (document.getElementsByTagName('parsererror').length) throw new Error('Tệp Excel có XML không hợp lệ.')
  return document
}

function elements(node, name) {
  return [...node.getElementsByTagNameNS('*', name)]
}

function textContents(node) {
  return elements(node, 't').map((item) => item.textContent ?? '').join('')
}

function normalizedZipPath(path) {
  return path.replace(/^\/+/, '').split('/').reduce((result, part) => {
    if (!part || part === '.') return result
    if (part === '..') result.pop()
    else result.push(part)
    return result
  }, []).join('/')
}

function parseSheet(xml, sharedStrings) {
  const document = parseXML(xml)
  const sheetRows = elements(document, 'row')
  if (sheetRows.length > MAX_SHEET_ROWS + 1) throw new Error('Trang tính vượt quá giới hạn 10.000 dòng dữ liệu.')
  return sheetRows.map((row) => {
    const values = []
    for (const cell of [...row.children].filter((child) => child.localName === 'c')) {
      const reference = cell.getAttribute('r') ?? ''
      const letters = reference.match(/[A-Z]+/i)?.[0] ?? ''
      const column = [...letters.toUpperCase()].reduce((number, character) =>
        number * 26 + character.charCodeAt(0) - 64, 0) - 1
      if (column < 0) continue
      if (elements(cell, 'f').length) {
        values[column] = ''
        continue
      }
      const type = cell.getAttribute('t')
      if (type === 'inlineStr') {
        values[column] = textContents(cell)
        continue
      }
      const value = elements(cell, 'v')[0]?.textContent ?? ''
      values[column] = type === 's' ? (sharedStrings[Number(value)] ?? '') : value
    }
    return values
  }).filter((row) => row.some((value) => String(value ?? '').trim()))
}

export function parseXLSX(buffer) {
  const bytes = new Uint8Array(buffer)
  assertSafeZip(bytes)
  const files = unzipSync(bytes)
  const getText = (path) => {
    const file = files[path]
    return file ? new TextDecoder().decode(file) : ''
  }
  const workbook = parseXML(getText('xl/workbook.xml'))
  const relationships = parseXML(getText('xl/_rels/workbook.xml.rels'))
  const targets = new Map(elements(relationships, 'Relationship')
    .map((relationship) => [relationship.getAttribute('Id'), relationship.getAttribute('Target')]))
  const sharedDocument = getText('xl/sharedStrings.xml')
  const sharedStrings = sharedDocument
    ? elements(parseXML(sharedDocument), 'si').map(textContents)
    : []
  const sheets = elements(workbook, 'sheet').map((sheet) => {
    const relationId = sheet.getAttribute('r:id')
      ?? sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
    const target = targets.get(relationId)
    if (!target) throw new Error('Không tìm thấy nội dung trang tính trong tệp Excel.')
    const path = target.startsWith('/') ? normalizedZipPath(target) : normalizedZipPath(`xl/${target}`)
    const xml = getText(path)
    if (!xml) throw new Error(`Không đọc được trang tính “${sheet.getAttribute('name')}”.`)
    return { name: sheet.getAttribute('name') ?? 'Sheet', rows: parseSheet(xml, sharedStrings) }
  })
  if (!sheets.length) throw new Error('Tệp Excel không có trang tính.')
  return sheets
}
