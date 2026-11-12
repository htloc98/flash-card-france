'use client'

import React, { useState } from 'react'
import { entryErrors, findDuplicate, mergeImportUpdate, normalizeImportRow, parseCSV, suggestColumnMapping } from '../core.js'
import { MAX_XLSX_FILE_BYTES, parseXLSX } from '../xlsx.js'
import Dialog from './Dialog.jsx'

const columns = [['term', 'Từ gốc'], ['pronunciation', 'Phiên âm'], ['part', 'Loại từ/Giống'], ['meaning', 'Nghĩa'], ['example', 'Ví dụ'], ['readText', 'Văn bản đọc'], ['category', 'Category'], ['language', 'Ngôn ngữ']]

export default function ImportDialog({ words, onSave, onClose }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [page, setPage] = useState(0)
  function selectSheet(sheets, sheet, filename) {
    if (sheet.rows.length < 2) throw new Error('Tệp không có dòng dữ liệu.')
    if (sheet.rows.length > 10001) throw new Error('Tệp vượt quá giới hạn 10.000 dòng.')
    setData({ sheets, sheetName: sheet.name, filename, headers: sheet.rows[0], rows: sheet.rows.slice(1), mapping: suggestColumnMapping(sheet.rows[0]), defaults: { category: '', language: 'fr-FR' }, edits: {}, choices: {}, excluded: {}, completed: {}, ids: {} })
    setPage(0)
    setResult('')
    setError('')
  }
  async function openFile(file) {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      if (file.size > MAX_XLSX_FILE_BYTES) throw new Error('Tệp nhập vượt quá giới hạn 20 MB.')
      const extension = file.name.split('.').pop().toLowerCase()
      const sheets = extension === 'csv' ? [{ name: 'CSV', rows: parseCSV(await file.text()) }]
        : extension === 'xlsx' ? parseXLSX(await file.arrayBuffer()) : null
      if (!sheets) throw new Error('Chỉ hỗ trợ CSV và XLSX.')
      const sheet = sheets.find((item) => item.rows.length > 1)
      if (!sheet) throw new Error('Tệp không có dòng dữ liệu.')
      selectSheet(sheets, sheet, file.name)
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  function legacyImport() {
    try {
      const saved = JSON.parse(localStorage.getItem('mot-flashcards-v1') ?? '{}')
      if (!Array.isArray(saved.words) || !saved.words.length) throw new Error('Không có dữ liệu cũ trên trình duyệt này.')
      const rows = [columns.map(([, title]) => title), ...saved.words.map((word) => [word.word, word.pronunciation, word.part_of_speech, word.meaning, word.example, word.read_text, (word.categories ?? []).map((category) => typeof category === 'string' ? category : category.name).join(';'), word.language || 'fr-FR'])]
      const sheet = { name: 'Thiết bị', rows }
      selectSheet([sheet], sheet, 'Dữ liệu thiết bị')
    } catch (failure) { setError(failure.message) }
  }
  function entryAt(index) {
    return { ...normalizeImportRow(data.rows[index], data.mapping, data.defaults), ...data.edits[index] }
  }
  async function confirm() {
    if (!data || busy) return
    setBusy(true)
    setError('')
    const working = [...words]
    const completed = { ...data.completed }
    const ids = { ...data.ids }
    const counts = { added: 0, updated: 0, skipped: 0 }
    const errors = []
    for (let index = 0; index < data.rows.length; index += 1) {
      if (completed[index] || data.excluded[index]) { counts.skipped += 1; continue }
      const entry = entryAt(index)
      const validation = entryErrors(entry)
      if (validation.length) { errors.push(`Dòng ${index + 2}: ${validation.join(', ')}`); continue }
      const duplicate = findDuplicate(entry, working)
      const choice = duplicate ? data.choices[index] ?? 'skip' : 'add'
      if (choice === 'skip') { counts.skipped += 1; continue }
      try {
        ids[index] ??= crypto.randomUUID()
        const values = choice === 'update' ? { ...duplicate, ...mergeImportUpdate(entry, duplicate) } : { ...entry, id: ids[index] }
        const saved = await onSave(values, choice === 'update')
        if (choice === 'update') { working.splice(working.findIndex((word) => word.id === saved.id), 1, saved); counts.updated += 1 }
        else { working.push(saved); counts.added += 1 }
        completed[index] = true
      } catch (failure) {
        errors.push(`Dòng ${index + 2}: ${failure.message}`)
        break
      }
    }
    setData((current) => ({ ...current, completed, ids }))
    setResult(`Đã thêm ${counts.added}, cập nhật ${counts.updated}, bỏ qua ${counts.skipped}.`)
    setError(errors.slice(0, 5).join(' '))
    setBusy(false)
  }
  return <Dialog title={data ? 'Kiểm tra nội dung' : 'Nhập từ tệp'} onClose={onClose} busy={busy} className={data ? 'import-dialog import-review' : 'import-dialog'}>
    <fieldset disabled={busy} className="import-fieldset">
      <label className="file-picker">Chọn tệp<input type="file" accept=".csv,.xlsx" onChange={(event) => openFile(event.target.files?.[0])} /></label>
      {!data && <button className="text-button" onClick={legacyImport}>Nhập dữ liệu thiết bị</button>}
      {data && <>
        <p className="import-summary">{data.filename} · {data.rows.length} dòng dữ liệu</p>
        {data.sheets.length > 1 && <label className="mapping-label">Trang tính<select value={data.sheetName} onChange={(event) => { try { selectSheet(data.sheets, data.sheets.find((sheet) => sheet.name === event.target.value), data.filename) } catch (failure) { setError(failure.message) } }}>{data.sheets.map((sheet) => <option key={sheet.name}>{sheet.name}</option>)}</select></label>}
        <div className="mapping-grid">
          {columns.map(([field, label]) => <label className="mapping-label" key={field}>{label}<select aria-label={`Cột ${label}`} value={data.mapping[field]} disabled={Object.keys(data.completed).length > 0} onChange={(event) => setData({ ...data, mapping: { ...data.mapping, [field]: event.target.value } })}><option value="">Không nhập</option>{data.headers.map((header, index) => <option key={index} value={index}>{header || `Cột ${index + 1}`}</option>)}</select></label>)}
          <label className="mapping-label">Nhóm mặc định<input value={data.defaults.category} onChange={(event) => setData({ ...data, defaults: { ...data.defaults, category: event.target.value } })} /></label>
          <label className="mapping-label">Ngôn ngữ mặc định<input value={data.defaults.language} onChange={(event) => setData({ ...data, defaults: { ...data.defaults, language: event.target.value } })} /></label>
        </div>
        <div className="preview-list">{data.rows.slice(page * 50, (page + 1) * 50).map((row, offset) => {
          const index = page * 50 + offset
          const entry = entryAt(index)
          const duplicate = findDuplicate(entry, words)
          const choice = data.choices[index] ?? 'skip'
          const errors = entryErrors(entry)
          const merged = duplicate ? mergeImportUpdate(entry, duplicate) : null
          return <div className={`preview-row ${errors.length ? 'invalid' : ''}`} key={index}>
            <label className="include-row"><input type="checkbox" aria-label={`Nhập dòng ${index + 2}`} checked={!data.excluded[index]} disabled={data.completed[index]} onChange={(event) => setData({ ...data, excluded: { ...data.excluded, [index]: !event.target.checked } })} /><input className="preview-edit preview-term" aria-label={`Từ gốc dòng ${index + 2}`} value={entry.word} disabled={data.completed[index]} onChange={(event) => setData({ ...data, edits: { ...data.edits, [index]: { ...data.edits[index], word: event.target.value } } })} /></label>
            <label className="preview-meaning-label">Nghĩa<input className="preview-edit" aria-label={`Nghĩa dòng ${index + 2}`} value={entry.meaning} disabled={data.completed[index]} onChange={(event) => setData({ ...data, edits: { ...data.edits, [index]: { ...data.edits[index], meaning: event.target.value } } })} /></label>
            {errors.length > 0 && <span className="row-error">{errors.join(', ')}</span>}
            {data.completed[index] ? <span>Đã lưu</span> : duplicate && <label className="decision">Đã có từ tương tự<select aria-label={`Xử lý từ trùng dòng ${index + 2}`} value={choice} onChange={(event) => setData({ ...data, choices: { ...data.choices, [index]: event.target.value } })}><option value="skip">Bỏ qua</option><option value="update">Cập nhật bản hiện có</option><option value="add">Thêm bản riêng</option></select></label>}
            {duplicate && choice === 'update' && <div className="compare-list">{['word', 'pronunciation', 'part_of_speech', 'meaning', 'example', 'read_text', 'language', 'categories'].map((field) => <div className="compare" key={field}><b>{field}</b><span>{String(duplicate[field] ?? '')} → {String(merged[field] ?? '')}</span></div>)}</div>}
          </div>
        })}</div>
        {data.rows.length > 50 && <div className="import-actions"><button className="button button-secondary" disabled={!page} onClick={() => setPage(page - 1)}>Trước</button><span>{page + 1} / {Math.ceil(data.rows.length / 50)}</span><button className="button button-secondary" disabled={(page + 1) * 50 >= data.rows.length} onClick={() => setPage(page + 1)}>Sau</button></div>}
        <div className="import-actions"><button className="button button-secondary" onClick={onClose}>Đóng</button><button className="button button-primary" onClick={confirm}>{busy ? 'Đang nhập...' : 'Xác nhận nhập'}</button></div>
      </>}
    </fieldset>
    {result && <p className="import-result" role="status">{result}</p>}
    {error && <p className="detail-error" role="alert">{error}</p>}
  </Dialog>
}