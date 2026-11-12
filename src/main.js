import { createClient } from '@supabase/supabase-js'
import './style.css'
import { entryErrors, findDuplicate, mergeImportUpdate, normalizeImportRow, parseCSV, suggestColumnMapping } from './core.js'
import { MAX_XLSX_FILE_BYTES, parseXLSX } from './xlsx.js'

const STORAGE_KEY = 'mot-flashcards-v1'
const SETTINGS_DEFAULTS = { frontDelay: 4, backDelay: 4, autoSpeak: false }
const app = document.querySelector('#app')
const env = import.meta.env
const supabase = env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY
  ? createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
  : null
const state = {
  user: null,
  words: [],
  settings: { ...SETTINGS_DEFAULTS },
  deviceVoice: localStorage.getItem('mot-device-voice') ?? '',
  voices: [],
  view: 'study',
  listMode: 'list',
  selectedCategory: '',
  index: 0,
  flipped: false,
  autoRunning: false,
  autoTimer: null,
  detailId: null,
  detailScroll: null,
  detailDraft: null,
  detailError: '',
  detailBusy: false,
  detailDeleting: false,
  settingsOpen: false,
  authOpen: false,
  importData: null,
  importOpen: false,
  importResult: '',
  notice: '',
}

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

function categoriesFor(word) {
  return (word.categories ?? []).map((category) => typeof category === 'string' ? category : category.name)
    .filter(Boolean)
}

function currentWord() {
  return state.words[state.index] ?? null
}

function uniqueCategories() {
  return [...new Set(state.words.flatMap(categoriesFor))].sort((a, b) => a.localeCompare(b))
}

function showNotice(message) {
  state.notice = message
  render()
  window.setTimeout(() => {
    if (state.notice === message) {
      state.notice = ''
      render()
    }
  }, 4500)
}

function stopAuto() {
  state.autoRunning = false
  window.clearTimeout(state.autoTimer)
  state.autoTimer = null
  window.speechSynthesis?.cancel()
}

function localLoad() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return {
      words: Array.isArray(saved.words) ? saved.words : [],
      settings: { ...SETTINGS_DEFAULTS, ...(saved.settings ?? {}) },
    }
  } catch {
    return { words: [], settings: { ...SETTINGS_DEFAULTS } }
  }
}

function localSave(words = state.words) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ words, settings: state.settings }))
}

function fromDatabaseRow(row) {
  return {
    ...row,
    categories: (row.vocabulary_categories ?? []).map((link) => link.categories?.name).filter(Boolean),
  }
}

async function loadData() {
  if (!supabase || !state.user) {
    const saved = localLoad()
    state.words = saved.words
    state.settings = saved.settings
    render()
    return
  }
  const [wordsResult, settingsResult] = await Promise.all([
    supabase.from('vocabularies')
      .select('*, vocabulary_categories(categories(id,name))')
      .order('created_at', { ascending: true }),
    supabase.from('user_settings').select('front_delay,back_delay,auto_speak').maybeSingle(),
  ])
  if (wordsResult.error) throw wordsResult.error
  if (settingsResult.error) throw settingsResult.error
  state.words = (wordsResult.data ?? []).map(fromDatabaseRow)
  if (settingsResult.data) {
    state.settings = {
      frontDelay: settingsResult.data.front_delay,
      backDelay: settingsResult.data.back_delay,
      autoSpeak: settingsResult.data.auto_speak,
    }
  } else {
    state.settings = { ...SETTINGS_DEFAULTS }
  }
  state.index = Math.min(state.index, Math.max(state.words.length - 1, 0))
  render()
}

async function saveSettings() {
  if (supabase && state.user) {
    const { error } = await supabase.from('user_settings').upsert({
      owner_id: state.user.id,
      front_delay: state.settings.frontDelay,
      back_delay: state.settings.backDelay,
      auto_speak: state.settings.autoSpeak,
    }, { onConflict: 'owner_id' })
    if (error) throw error
  } else {
    localSave()
  }
}

async function saveWord(entry, existing = null) {
  const values = existing ? mergeImportUpdate(entry, existing) : entry
  const categories = [...new Set(values.categories ?? [])]
  if (!supabase || !state.user) {
    return { ...existing, ...values, id: existing?.id ?? crypto.randomUUID(), categories }
  }

  const record = {
    word: values.word,
    pronunciation: values.pronunciation,
    part_of_speech: values.part_of_speech,
    meaning: values.meaning,
    example: values.example,
    read_text: values.read_text,
    language: values.language || 'fr-FR',
  }
  let saved
  if (existing) {
    const { data, error } = await supabase.from('vocabularies').update(record)
      .eq('id', existing.id).select().single()
    if (error) throw error
    saved = data
  } else {
    const { data, error } = await supabase.from('vocabularies')
      .insert({ ...record, owner_id: state.user.id }).select().single()
    if (error) throw error
    saved = data
  }

  await saveWordCategories(saved.id, categories)
  return { ...saved, categories }
}

async function saveWordCategories(wordId, categories) {
  const categoryIds = []
  for (const name of categories) {
    const { data, error } = await supabase.from('categories')
      .upsert({ owner_id: state.user.id, name }, { onConflict: 'owner_id,name' })
      .select('id').single()
    if (error) throw error
    categoryIds.push(data.id)
  }
  const { data: links, error: linksError } = await supabase.from('vocabulary_categories')
    .select('category_id').eq('vocabulary_id', wordId)
  if (linksError) throw linksError
  const existingIds = (links ?? []).map((link) => link.category_id)
  const addedIds = categoryIds.filter((categoryId) => !existingIds.includes(categoryId))
  const removedIds = existingIds.filter((categoryId) => !categoryIds.includes(categoryId))
  if (addedIds.length) {
    const { error } = await supabase.from('vocabulary_categories').insert(
      addedIds.map((categoryId) => ({ vocabulary_id: wordId, category_id: categoryId })),
    )
    if (error) throw error
  }
  if (removedIds.length) {
    const { error } = await supabase.from('vocabulary_categories').delete()
      .eq('vocabulary_id', wordId).in('category_id', removedIds)
    if (error) throw error
  }
}

function closeDetail() {
  state.detailId = null
  state.detailDraft = null
  state.detailDeleting = false
  state.detailError = ''
}

async function saveDetail() {
  if (!state.detailDraft || state.detailBusy || state.detailDeleting) return
  const word = state.words.find((item) => item.id === state.detailId)
  if (!word) return
  const meaning = state.detailDraft.meaning.trim()
  if (!meaning) {
    state.detailError = 'Vui lòng nhập nghĩa của từ.'
    render()
    return
  }
  const example = state.detailDraft.example.trim()
  const categories = [...new Set(state.detailDraft.category.split(/[|;]/).map((name) => name.trim()).filter(Boolean))]
  state.detailBusy = true
  state.detailError = ''
  render()
  try {
    if (supabase && state.user) {
      const { error } = await supabase.from('vocabularies').update({ meaning, example })
        .eq('id', word.id).select('id').single()
      if (error) throw error
      const previousCategories = categoriesFor(word)
      if (categories.length !== previousCategories.length || categories.some((name) => !previousCategories.includes(name))) {
        await saveWordCategories(word.id, categories)
      }
    }
    const words = state.words.map((item) => item.id === word.id ? { ...item, meaning, example, categories } : item)
    if (!supabase || !state.user) localSave(words)
    state.words = words
    if (state.selectedCategory !== 'Chưa phân loại' && !uniqueCategories().includes(state.selectedCategory)) state.selectedCategory = ''
    state.detailDraft = null
  } catch (error) {
    state.detailError = error.message || 'Không thể lưu thay đổi. Vui lòng thử lại.'
    if (supabase && state.user) {
      try {
        const { data, error: reloadError } = await supabase.from('vocabularies')
          .select('*, vocabulary_categories(categories(id,name))').eq('id', word.id).single()
        if (reloadError) throw reloadError
        const saved = fromDatabaseRow(data)
        state.words = state.words.map((item) => item.id === word.id ? saved : item)
        state.detailError += ' Kiểm tra lại thông tin và thử lưu lại.'
      } catch {
        state.detailError += ' Không thể tải lại dữ liệu; một số thay đổi có thể đã được lưu. Vui lòng thử lại khi có kết nối.'
      }
    }
  } finally {
    state.detailBusy = false
    render()
  }
}

async function deleteDetail() {
  if (!state.detailDeleting || state.detailBusy) return
  const wordId = state.detailId
  const currentId = currentWord()?.id
  state.detailBusy = true
  state.detailError = ''
  render()
  try {
    if (supabase && state.user) {
      const { error } = await supabase.from('vocabularies').delete().eq('id', wordId).select('id').single()
      if (error) throw error
    }
    const words = state.words.filter((word) => word.id !== wordId)
    if (!supabase || !state.user) localSave(words)
    state.words = words
    const currentIndex = words.findIndex((word) => word.id === currentId)
    state.index = currentIndex >= 0 ? currentIndex : Math.max(0, Math.min(state.index, words.length - 1))
    state.flipped = false
    if (state.selectedCategory !== 'Chưa phân loại' && !uniqueCategories().includes(state.selectedCategory)) state.selectedCategory = ''
    closeDetail()
  } catch (error) {
    state.detailError = error.message || 'Không thể xóa từ vựng. Vui lòng thử lại.'
  } finally {
    state.detailBusy = false
    render()
  }
}

function readWord(word) {
  if (!word || !('speechSynthesis' in window)) {
    showNotice('Trình duyệt này không hỗ trợ đọc văn bản.')
    return
  }
  const voices = window.speechSynthesis.getVoices()
  const language = (word.language || 'fr-FR').toLowerCase()
  const availableVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith(language.split('-')[0]))
  if (!availableVoices.length) {
    showNotice(`Không tìm thấy giọng ${word.language || 'tiếng Pháp'} trên thiết bị này.`)
    return
  }
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(word.read_text?.trim() || word.word)
  utterance.lang = word.language || 'fr-FR'
  utterance.voice = availableVoices.find((voice) => voice.voiceURI === state.deviceVoice)
    ?? availableVoices.find((voice) => voice.lang.toLowerCase() === utterance.lang.toLowerCase())
    ?? availableVoices[0]
  window.speechSynthesis.speak(utterance)
}

function scheduleAutoStep(delay) {
  window.clearTimeout(state.autoTimer)
  state.autoTimer = window.setTimeout(() => {
    if (!state.autoRunning) return
    if (!state.flipped) {
      state.flipped = true
      if (state.settings.autoSpeak) readWord(currentWord())
      render()
      scheduleAutoStep(state.settings.backDelay * 1000)
    } else if (state.index < state.words.length - 1) {
      window.speechSynthesis?.cancel()
      state.index += 1
      state.flipped = false
      render()
      scheduleAutoStep(state.settings.frontDelay * 1000)
    } else {
      stopAuto()
      render()
    }
  }, delay)
}

function toggleAuto() {
  if (!state.words.length) return
  if (state.autoRunning) {
    stopAuto()
  } else {
    state.index = Math.min(state.index, state.words.length - 1)
    state.flipped = false
    state.autoRunning = true
    scheduleAutoStep(state.settings.frontDelay * 1000)
  }
  render()
}

function renderDetail(word) {
  const draft = state.detailDraft
  const disabled = state.detailBusy ? 'disabled' : ''
  return `<div class="overlay" data-action="close-detail" role="presentation">
    <section class="dialog detail-dialog" role="dialog" aria-modal="true" aria-labelledby="detail-title" aria-busy="${state.detailBusy}">
      <button class="icon-button dialog-close" data-action="close-detail" aria-label="Đóng" ${disabled}>×</button>
      <div class="detail-heading"><p class="eyebrow">CHI TIẾT TỪ VỰNG</p>${!draft ? '<button class="icon-button" data-action="edit-detail" aria-label="Chỉnh sửa từ vựng" title="Chỉnh sửa từ vựng">⚙</button>' : ''}</div>
      ${wordFields(word, true, Boolean(draft))}
      ${draft ? `<form id="detail-form">
        <fieldset class="detail-fields" ${disabled}>
          <label for="detail-meaning">Nghĩa <span aria-hidden="true">*</span></label>
          <textarea id="detail-meaning" name="meaning" data-detail-field="meaning" rows="2" required>${escapeHTML(draft.meaning)}</textarea>
          <label for="detail-example">Ví dụ</label>
          <textarea id="detail-example" name="example" data-detail-field="example" rows="3">${escapeHTML(draft.example)}</textarea>
          <label for="detail-category">Category</label>
          <input id="detail-category" name="category" data-detail-field="category" value="${escapeHTML(draft.category)}" list="detail-categories" placeholder="Category 1; Category 2">
          <datalist id="detail-categories">${uniqueCategories().map((name) => `<option value="${escapeHTML(name)}"></option>`).join('')}</datalist>
        </fieldset>
        ${state.detailError ? `<p class="detail-error" role="alert">${escapeHTML(state.detailError)}</p>` : ''}
        ${state.detailDeleting ? `<div class="detail-delete-confirm" role="group" aria-label="Xác nhận xóa từ vựng">
          <p>Xóa “${escapeHTML(word.word)}” khỏi danh sách từ vựng? Không thể hoàn tác.</p>
          <div class="detail-actions"><button type="button" class="button button-secondary" data-action="cancel-delete-detail" ${disabled}>Hủy</button><button type="button" class="button button-danger" data-action="confirm-delete-detail" ${disabled}>${state.detailBusy ? 'Đang xóa…' : 'Xóa từ vựng'}</button></div>
        </div>` : `<div class="detail-actions">
          <button type="button" class="button button-danger detail-delete" data-action="delete-detail" ${disabled}>Xóa từ vựng</button>
          <button type="button" class="button button-secondary" data-action="cancel-detail-edit" ${disabled}>Hủy</button>
          <button type="submit" class="button button-primary" ${disabled}>${state.detailBusy ? 'Đang lưu…' : 'Lưu'}</button>
        </div>`}
      </form>` : `<button class="button button-secondary" data-action="speak" data-id="${escapeHTML(word.id)}">🔊 Nghe phát âm</button>`}
    </section>
  </div>`
}

function wordFields(word, detailed = false, editing = false) {
  const categories = categoriesFor(word)
  return `<article class="word-detail">
    <h2 id="${detailed ? 'detail-title' : ''}">${escapeHTML(word.word)}</h2>
    ${word.pronunciation ? `<p class="pronunciation">${escapeHTML(word.pronunciation)}</p>` : ''}
    ${word.part_of_speech ? `<p class="part">${escapeHTML(word.part_of_speech)}</p>` : ''}
    ${editing ? '' : `<p class="meaning">${escapeHTML(word.meaning)}</p>
    ${word.example ? `<p class="example">${escapeHTML(word.example)}</p>` : ''}
    ${categories.length ? `<p class="tag-row">${categories.map((category) => `<span class="tag">${escapeHTML(category)}</span>`).join('')}</p>` : ''}`}
  </article>`
}

function renderStudy() {
  const word = currentWord()
  if (!word) return `<section class="empty-state"><span class="empty-illustration">✳</span><h2>Bắt đầu với từ đầu tiên</h2><p>Thêm từ vựng hoặc nhập tệp CSV/Excel để tạo bộ thẻ của bạn.</p><button class="button button-primary" data-action="import">Nhập từ vựng</button></section>`
  return `<section class="study-view">
    <div class="study-title"><div><p class="eyebrow">GÓC ÔN TẬP</p><h1>Học một chút,<br><span>nhớ thật lâu.</span></h1></div>
      <span class="count-pill">${state.index + 1} <span>/</span> ${state.words.length} thẻ</span></div>
    <button class="flash-card ${state.flipped ? 'is-flipped' : ''}" data-action="flip" aria-label="${state.flipped ? 'Lật về mặt trước' : 'Lật thẻ'}">
      ${state.flipped ? `<span class="card-topline"><span>MẶT SAU</span><span>${escapeHTML(word.language || 'fr-FR')}</span></span><span class="card-back">${wordFields(word)}</span>` : `<span class="card-word">${escapeHTML(word.word)}</span>`}
    </button>
    ${state.flipped ? `<div class="study-aux"><button class="text-button" data-action="speak" data-id="${escapeHTML(word.id)}">🔊 Nghe phát âm</button><button class="text-button" data-action="detail" data-id="${escapeHTML(word.id)}">Xem chi tiết ↗</button></div>` : ''}
    <div class="study-dock"><div class="dock-inner">
      <button class="button button-secondary nav-button" data-action="previous" ${state.index === 0 ? 'disabled' : ''}>← <span>Trước</span></button>
      <span class="dock-count">${state.index + 1} / ${state.words.length}</span>
      <button class="button button-primary nav-button" data-action="next" ${state.index === state.words.length - 1 ? 'disabled' : ''}><span>Sau</span> →</button>
      <span class="dock-divider"></span>
      <button class="button button-auto ${state.autoRunning ? 'active' : ''}" data-action="auto" aria-pressed="${state.autoRunning}">${state.autoRunning ? 'Ⅱ  Dừng tự động' : '▶  Tự động'}</button>
    </div></div>
  </section>`
}

function renderWordRow(word) {
  return `<button class="word-row" data-action="detail" data-id="${escapeHTML(word.id)}">
    <span class="row-word">${escapeHTML(word.word)}</span>
    <span class="row-pronunciation">${escapeHTML(word.pronunciation || '—')}</span>
    <span class="row-meaning">${escapeHTML(word.meaning)}</span>
    <span class="row-arrow">↗</span>
  </button>`
}

function renderLibrary() {
  const categories = uniqueCategories()
  const selected = state.listMode === 'category' && state.selectedCategory
  const words = state.listMode === 'category' && selected === 'Chưa phân loại'
    ? state.words.filter((word) => !categoriesFor(word).length)
    : state.listMode === 'category' && selected
      ? state.words.filter((word) => categoriesFor(word).includes(state.selectedCategory))
      : state.words
  return `<section class="library-view">
    <div class="library-heading"><div><p class="eyebrow">VOTRE COLLECTION</p><h1>Les mots, <span>en clair.</span></h1></div>
      <button class="button button-primary" data-action="import">＋ <span>Nhập tệp</span></button></div>
    <div class="library-tools"><div class="segmented" role="tablist" aria-label="Cách xem từ">
      <button data-action="list-mode" data-mode="list" class="${state.listMode === 'list' ? 'selected' : ''}">☷ &nbsp; Danh sách</button>
      <button data-action="list-mode" data-mode="category" class="${state.listMode === 'category' ? 'selected' : ''}">▦ &nbsp; Category</button>
    </div><span class="library-count">${state.words.length} từ</span></div>
    ${state.listMode === 'category' ? `<div class="category-filter">
      <button class="category-chip ${!selected ? 'selected' : ''}" data-action="category" data-category="">Tất cả</button>
      ${categories.map((category) => `<button class="category-chip ${selected === category ? 'selected' : ''}" data-action="category" data-category="${escapeHTML(category)}">${escapeHTML(category)}</button>`).join('')}
      <button class="category-chip ${selected === 'Chưa phân loại' ? 'selected' : ''}" data-action="category" data-category="Chưa phân loại">Chưa phân loại</button>
    </div>` : ''}
    ${state.listMode === 'category' && !selected && categories.length ? categories.map((category) => {
      const group = state.words.filter((word) => categoriesFor(word).includes(category))
      return `<section class="category-group"><button class="category-heading" data-action="category" data-category="${escapeHTML(category)}"><span>${escapeHTML(category)}</span><span>${group.length} từ　↗</span></button><div class="word-list">${group.map(renderWordRow).join('')}</div></section>`
    }).join('') + (state.words.some((word) => !categoriesFor(word).length) ? `<section class="category-group"><button class="category-heading" data-action="category" data-category="Chưa phân loại"><span>Chưa phân loại</span></button><div class="word-list">${state.words.filter((word) => !categoriesFor(word).length).map(renderWordRow).join('')}</div></section>` : '')
      : `<div class="word-list">${(selected === 'Chưa phân loại' ? state.words.filter((word) => !categoriesFor(word).length) : words).map(renderWordRow).join('')}</div>`}
    ${!words.length && !(state.listMode === 'category' && !selected && categories.length) ? `<div class="empty-small">Chưa có từ nào ở đây.</div>` : ''}
  </section>`
}

function renderSettings() {
  const frenchVoices = state.voices.filter((voice) => voice.lang.toLowerCase().startsWith('fr'))
  return `<div class="overlay" data-action="close-settings" role="presentation"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <button class="icon-button dialog-close" data-action="close-settings" aria-label="Đóng">×</button>
    <p class="eyebrow">PRÉFÉRENCES</p><h2 id="settings-title">Tự động & âm thanh</h2>
    <label class="setting-row"><span><strong>Mặt trước</strong><small>Chờ trước khi tự lật thẻ</small></span><select data-setting="frontDelay">${[1,2,3,4,5,6,7,8,9,10].map((number) => `<option value="${number}" ${state.settings.frontDelay === number ? 'selected' : ''}>${number} giây</option>`).join('')}</select></label>
    <label class="setting-row"><span><strong>Mặt sau</strong><small>Chờ trước khi chuyển từ tiếp</small></span><select data-setting="backDelay">${[1,2,3,4,5,6,7,8,9,10].map((number) => `<option value="${number}" ${state.settings.backDelay === number ? 'selected' : ''}>${number} giây</option>`).join('')}</select></label>
    <label class="toggle-row"><span><strong>Tự đọc khi lật sang mặt sau</strong><small>Chỉ đọc từ gốc hoặc văn bản đọc riêng</small></span><input type="checkbox" data-setting="autoSpeak" ${state.settings.autoSpeak ? 'checked' : ''}></label>
    <label class="setting-row"><span><strong>Giọng đọc trên thiết bị</strong><small>Chọn riêng cho laptop hoặc điện thoại này</small></span><select data-setting="deviceVoice"><option value="">Mặc định theo từ</option>${frenchVoices.map((voice) => `<option value="${escapeHTML(voice.voiceURI)}" ${state.deviceVoice === voice.voiceURI ? 'selected' : ''}>${escapeHTML(voice.name)} · ${escapeHTML(voice.lang)}</option>`).join('')}</select></label>
    <p class="dialog-note">${frenchVoices.length ? 'Giọng tiếng Pháp được cung cấp bởi thiết bị.' : 'Chưa tìm thấy giọng tiếng Pháp. Hãy cài đặt giọng Pháp trên thiết bị.'}</p>
  </section></div>`
}

function renderAuth() {
  return `<div class="overlay" data-action="close-auth" role="presentation"><form class="dialog auth-dialog" id="auth-form" role="dialog" aria-modal="true" aria-labelledby="auth-title">
    <button type="button" class="icon-button dialog-close" data-action="close-auth" aria-label="Đóng">×</button>
    <p class="eyebrow">VOTRE ESPACE</p><h2 id="auth-title">Đăng nhập để đồng bộ</h2>
    <label>Email<input type="email" name="email" required autocomplete="email"></label>
    <label>Mật khẩu<input type="password" name="password" required minlength="6" autocomplete="current-password"></label>
    <div class="auth-actions"><button class="button button-primary" name="auth-mode" value="login">Đăng nhập</button><button class="button button-secondary" name="auth-mode" value="signup">Tạo tài khoản</button></div>
    <p class="dialog-note">Tạo tài khoản mới sẽ gửi liên kết xác nhận nếu dự án bật xác thực email.</p>
  </form></div>`
}

function renderImport() {
  const data = state.importData
  if (!data) return `<div class="overlay" data-action="close-import" role="presentation"><section class="dialog import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
    <button class="icon-button dialog-close" data-action="close-import" aria-label="Đóng">×</button>
    <p class="eyebrow">AJOUTER DES MOTS</p><h2 id="import-title">Nhập từ tệp</h2>
    <p class="dialog-note">Tệp CSV UTF-8 hoặc Excel .xlsx · Nội dung được xem trước trước khi lưu.</p>
    <label class="file-picker">Chọn tệp<input id="import-file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
    ${state.importResult ? `<p class="import-result">${escapeHTML(state.importResult)}</p>` : ''}
  </section></div>`
  const mapping = data.mapping
  const fields = [['term','Từ gốc *'],['pronunciation','Phiên âm'],['part','Loại từ/Giống'],['meaning','Nghĩa *'],['example','Ví dụ/Giải thích'],['readText','Văn bản đọc'],['category','Category'],['language','Ngôn ngữ']]
  const rows = data.rows.slice(1)
  const previews = rows.map((row, rowIndex) => {
    const entry = normalizeImportRow(row, mapping, data.defaults)
    entry.word = data.edits[rowIndex]?.word ?? entry.word
    entry.meaning = data.edits[rowIndex]?.meaning ?? entry.meaning
    const duplicate = findDuplicate(entry, state.words)
    const incoming = duplicate ? mergeImportUpdate(entry, duplicate) : entry
    const errors = entryErrors(entry)
    const choice = data.choices[rowIndex] ?? (duplicate ? 'skip' : 'add')
    const included = data.included[rowIndex] !== false
    const compareFields = [
      ['Từ gốc', duplicate?.word, incoming.word],
      ['Phiên âm', duplicate?.pronunciation, incoming.pronunciation],
      ['Loại từ/Giống', duplicate?.part_of_speech, incoming.part_of_speech],
      ['Nghĩa', duplicate?.meaning, incoming.meaning],
      ['Ví dụ', duplicate?.example, incoming.example],
      ['Văn bản đọc', duplicate?.read_text, incoming.read_text],
      ['Ngôn ngữ', duplicate?.language, incoming.language],
      ['Category', categoriesFor(duplicate ?? {}).join(', '), incoming.categories.join(', ')],
    ]
    const compare = duplicate && choice === 'update'
      ? `<div class="compare-list">${compareFields.map(([label, oldValue, newValue]) => `<small class="compare"><b>${label}</b><span>${escapeHTML(oldValue || '(trống)')} → ${escapeHTML(newValue || '(trống)')}</span></small>`).join('')}</div>` : ''
    return `<article class="preview-row ${errors.length ? 'invalid' : ''}">
      <label class="include-row"><input type="checkbox" data-include="${rowIndex}" ${included ? 'checked' : ''}><input class="preview-edit preview-term" data-row-edit="${rowIndex}" data-field="word" value="${escapeHTML(entry.word)}" placeholder="Từ gốc" aria-label="Từ gốc ở dòng ${rowIndex + 2}"></label>
      <label class="preview-meaning-label">Nghĩa<input class="preview-edit" data-row-edit="${rowIndex}" data-field="meaning" value="${escapeHTML(entry.meaning)}" placeholder="Nghĩa" aria-label="Nghĩa ở dòng ${rowIndex + 2}"></label>
      ${errors.length ? `<small class="row-error">${escapeHTML(errors.join(' · '))} — sửa nội dung hoặc bỏ chọn dòng này.</small>` : ''}
      ${duplicate ? `<label class="decision">Đã có từ tương tự<select data-choice="${rowIndex}"><option value="update" ${choice === 'update' ? 'selected' : ''}>Cập nhật bản hiện có</option><option value="skip" ${choice === 'skip' ? 'selected' : ''}>Bỏ qua</option><option value="add" ${choice === 'add' ? 'selected' : ''}>Thêm bản riêng</option></select></label>` : ''}
      ${compare}
    </article>`
  }).join('')
  return `<div class="overlay import-overlay" data-action="close-import" role="presentation"><section class="dialog import-dialog import-review" role="dialog" aria-modal="true" aria-labelledby="import-title">
    <button class="icon-button dialog-close" data-action="close-import" aria-label="Đóng">×</button>
    <p class="eyebrow">IMPORT · ${escapeHTML(data.filename)}</p><h2 id="import-title">Kiểm tra nội dung</h2>
    ${data.sheets.length > 1 ? `<label class="mapping-label">Trang tính<select id="sheet-select">${data.sheets.map((sheet) => `<option value="${escapeHTML(sheet.name)}" ${data.sheetName === sheet.name ? 'selected' : ''}>${escapeHTML(sheet.name)}</option>`).join('')}</select></label>` : ''}
    <div class="mapping-grid">${fields.map(([field, label]) => `<label class="mapping-label">${label}<select data-map="${field}"><option value="">— Không nhập —</option>${data.headers.map((header, index) => `<option value="${index}" ${mapping[field] === String(index) ? 'selected' : ''}>${escapeHTML(header || `Cột ${index + 1}`)}</option>`).join('')}</select></label>`).join('')}
      <label class="mapping-label">Nhóm mặc định<input id="default-category" value="${escapeHTML(data.defaults.category)}" placeholder="Ví dụ: Leçon 1"></label>
      <label class="mapping-label">Ngôn ngữ mặc định<input id="default-language" value="${escapeHTML(data.defaults.language)}" placeholder="fr-FR"></label>
    </div>
    <p class="import-summary">${rows.length} dòng dữ liệu · Từ mới được thêm; từ trùng cần chọn cách xử lý.</p>
    <div class="preview-list">${previews || '<p class="empty-small">Không tìm thấy dòng dữ liệu.</p>'}</div>
    <div class="import-actions"><button class="button button-secondary" data-action="close-import">Hủy</button><button class="button button-primary" data-action="confirm-import">Xác nhận nhập</button></div>
  </section></div>`
}

function render() {
  const wordCount = state.words.length
  const restoreDetailScroll = state.detailId === null && state.detailScroll !== null
  const modal = state.detailId ? renderDetail(state.words.find((word) => word.id === state.detailId) ?? currentWord())
    : state.settingsOpen ? renderSettings()
      : state.authOpen ? renderAuth()
        : state.importOpen ? renderImport() : ''
  app.innerHTML = `<div class="app-shell">
    <header class="topbar"><a class="brand" href="#" data-action="home"><span class="brand-mark">m.</span><span>mot<span class="brand-dot">.</span></span></a>
      <nav class="main-nav" aria-label="Điều hướng"><button data-action="view" data-view="study" class="${state.view === 'study' ? 'active' : ''}">Ôn tập</button><button data-action="view" data-view="library" class="${state.view === 'library' ? 'active' : ''}">Từ vựng <span>${wordCount}</span></button></nav>
      <div class="top-actions">${supabase ? (state.user ? `<span class="account-email">${escapeHTML(state.user.email)}</span><button class="text-button account-action" data-action="signout">Đăng xuất</button>` : `<button class="button button-secondary sign-in" data-action="auth">Đăng nhập</button>`) : `<span class="local-badge" title="Thiết lập Supabase để đồng bộ tài khoản">● Chỉ lưu trên thiết bị</span>`}<button class="icon-button settings-button" data-action="settings" aria-label="Cài đặt">⚙</button></div>
    </header>
    <main>${state.view === 'study' ? renderStudy() : renderLibrary()}</main>
    <footer class="site-footer"><span>mot. <i>un mot à la fois.</i></span><span>${supabase && state.user ? 'Đã đồng bộ tài khoản' : 'Dữ liệu được lưu trên thiết bị này'}</span></footer>
    ${state.notice ? `<div class="toast" role="status">${escapeHTML(state.notice)}</div>` : ''}
    ${modal}
  </div>`
  if (restoreDetailScroll) {
    const scrollPosition = state.detailScroll
    state.detailScroll = null
    window.requestAnimationFrame(() => window.scrollTo(0, scrollPosition))
  }
}

async function openImportFile(file) {
  if (file.size > MAX_XLSX_FILE_BYTES) throw new Error('Tệp nhập vượt quá giới hạn 20 MB.')
  const extension = file.name.split('.').pop().toLowerCase()
  let sheets
  let selectedSheet
  if (extension === 'csv') {
    sheets = [{ name: 'CSV', rows: parseCSV(await file.text()) }]
    selectedSheet = sheets[0]
  } else if (extension === 'xlsx') {
    sheets = parseXLSX(await file.arrayBuffer())
    selectedSheet = sheets.find((sheet) => sheet.rows.length) ?? sheets[0]
  } else {
    throw new Error('Chỉ hỗ trợ tệp .csv và .xlsx.')
  }
  if (!selectedSheet?.rows.length) throw new Error('Tệp không có dữ liệu.')
  if (selectedSheet.rows.length > 10_001) throw new Error('Tệp vượt quá giới hạn 10.000 dòng dữ liệu.')
  state.importResult = ''
  state.importData = {
    filename: file.name,
    sheets,
    sheetName: selectedSheet.name,
    rows: selectedSheet.rows,
    headers: selectedSheet.rows[0]?.map((header) => String(header ?? '').trim()) ?? [],
    mapping: suggestColumnMapping(selectedSheet.rows[0]),
    defaults: { category: '', language: 'fr-FR' },
    choices: {},
    included: {},
    edits: {},
  }
  state.importOpen = true
  render()
}

function updateImportSheet(sheetName) {
  const sheet = state.importData.sheets.find((item) => item.name === sheetName)
  if (!sheet) return
  state.importData.sheetName = sheet.name
  state.importData.rows = sheet.rows
  state.importData.headers = sheet.rows[0]?.map((header) => String(header ?? '').trim()) ?? []
  state.importData.mapping = suggestColumnMapping(sheet.rows[0] ?? [])
  state.importData.choices = {}
  state.importData.included = {}
  state.importData.edits = {}
  render()
}

async function confirmImport() {
  const data = state.importData
  if (!data) return
  const counts = { added: 0, updated: 0, skipped: 0 }
  const errors = []
  for (const [rowIndex, row] of data.rows.slice(1).entries()) {
    if (data.included[rowIndex] === false) {
      counts.skipped += 1
      continue
    }
    const entry = normalizeImportRow(row, data.mapping, data.defaults)
    entry.word = data.edits[rowIndex]?.word ?? entry.word
    entry.meaning = data.edits[rowIndex]?.meaning ?? entry.meaning
    const validationErrors = entryErrors(entry)
    if (validationErrors.length) {
      errors.push(`Dòng ${rowIndex + 2}: ${validationErrors.join(', ')}`)
      continue
    }
    const duplicate = findDuplicate(entry, state.words)
    const choice = duplicate ? data.choices[rowIndex] ?? 'skip' : 'add'
    if (choice === 'skip') {
      counts.skipped += 1
      continue
    }
    try {
      const saved = await saveWord(entry, choice === 'update' ? duplicate : null)
      if (choice === 'update') {
        state.words = state.words.map((word) => word.id === saved.id ? saved : word)
        counts.updated += 1
      } else {
        state.words.push(saved)
        counts.added += 1
      }
      if (!supabase || !state.user) localSave()
    } catch (error) {
      errors.push(`Dòng ${rowIndex + 2}: ${error.message}`)
    }
  }
  state.importData = null
  state.importResult = `Đã thêm ${counts.added}, cập nhật ${counts.updated}, bỏ qua ${counts.skipped}.${errors.length ? ` ${errors.length} dòng lỗi: ${errors.slice(0, 3).join(' · ')}` : ''}`
  state.index = 0
  state.flipped = false
  render()
}

app.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]')
  if (!target) return
  // Keep dialog controls mounted when their clicks bubble to the backdrop.
  if (target.matches('.overlay') && target !== event.target) return
  const action = target.dataset.action
  if (state.detailBusy) return
  try {
    if (action === 'view' || action === 'home') {
      stopAuto()
      state.view = action === 'home' ? 'study' : target.dataset.view
      state.importData = null
      state.importResult = ''
      state.importOpen = false
    } else if (action === 'flip') {
      stopAuto()
      state.flipped = !state.flipped
      if (state.flipped && state.settings.autoSpeak) readWord(currentWord())
    } else if (action === 'previous' || action === 'next') {
      stopAuto()
      state.index = Math.max(0, Math.min(state.words.length - 1, state.index + (action === 'next' ? 1 : -1)))
      state.flipped = false
    } else if (action === 'auto') {
      toggleAuto()
      return
    } else if (action === 'detail') {
      stopAuto()
      state.detailScroll = window.scrollY
      state.detailId = target.dataset.id
      state.detailDraft = null
      state.detailError = ''
      state.detailDeleting = false
    } else if (action === 'edit-detail') {
      const word = state.words.find((item) => item.id === state.detailId)
      if (!word) return
      state.detailDraft = { meaning: word.meaning, example: word.example ?? '', category: categoriesFor(word).join('; ') }
      state.detailError = ''
    } else if (action === 'cancel-detail-edit') {
      state.detailDraft = null
      state.detailDeleting = false
      state.detailError = ''
    } else if (action === 'delete-detail' && state.detailDraft) {
      state.detailDeleting = true
      state.detailError = ''
    } else if (action === 'cancel-delete-detail') {
      state.detailDeleting = false
      state.detailError = ''
    } else if (action === 'confirm-delete-detail') {
      await deleteDetail()
      return
    } else if (action === 'close-detail') {
      if (target === event.target || target.matches('button')) closeDetail()
    } else if (action === 'settings') {
      stopAuto()
      state.settingsOpen = true
    } else if (action === 'close-settings') {
      if (target === event.target || target.matches('button')) state.settingsOpen = false
    } else if (action === 'auth') {
      state.authOpen = true
    } else if (action === 'close-auth') {
      if (target === event.target || target.matches('button')) state.authOpen = false
    } else if (action === 'signout') {
      stopAuto()
      const { error } = await supabase.auth.signOut()
      if (error) throw error
      state.user = null
      await loadData()
    } else if (action === 'speak') {
      readWord(state.words.find((word) => word.id === target.dataset.id))
    } else if (action === 'list-mode') {
      state.listMode = target.dataset.mode
      state.selectedCategory = ''
    } else if (action === 'category') {
      state.selectedCategory = target.dataset.category
    } else if (action === 'import') {
      stopAuto()
      state.view = 'library'
      state.importData = null
      state.importResult = ''
      state.importOpen = true
    } else if (action === 'close-import') {
      if (target === event.target || target.matches('button')) {
        state.importData = null
        state.importResult = ''
        state.importOpen = false
      }
    } else if (action === 'confirm-import') {
      target.disabled = true
      await confirmImport()
      return
    }
    render()
  } catch (error) {
    showNotice(error.message || 'Đã xảy ra lỗi. Vui lòng thử lại.')
  }
})

app.addEventListener('change', async (event) => {
  const { target } = event
  try {
    if (target.id === 'import-file' && target.files?.[0]) {
      try {
        await openImportFile(target.files[0])
      } catch (error) {
        state.importResult = error.message || 'Không thể đọc tệp.'
        render()
      }
    } else if (target.id === 'sheet-select') {
      updateImportSheet(target.value)
    } else if (target.dataset.map) {
      state.importData.mapping[target.dataset.map] = target.value
      render()
    } else if (target.id === 'default-category' || target.id === 'default-language') {
      const active = document.activeElement?.id
      state.importData.defaults[target.id === 'default-category' ? 'category' : 'language'] = target.value
      render()
      document.getElementById(active)?.focus()
    } else if (target.dataset.choice !== undefined) {
      state.importData.choices[Number(target.dataset.choice)] = target.value
      render()
    } else if (target.dataset.include !== undefined) {
      state.importData.included[Number(target.dataset.include)] = target.checked
      render()
    } else if (target.dataset.setting) {
      const key = target.dataset.setting
      if (key === 'deviceVoice') {
        state.deviceVoice = target.value
        localStorage.setItem('mot-device-voice', state.deviceVoice)
      } else {
        state.settings[key] = target.type === 'checkbox' ? target.checked : Number(target.value)
      }
      if (key === 'autoSpeak' && !state.settings.autoSpeak) window.speechSynthesis?.cancel()
      if (key !== 'deviceVoice') await saveSettings()
      render()
    } else if (target.dataset.rowEdit !== undefined) {
      const index = Number(target.dataset.rowEdit)
      state.importData.edits[index] = {
        ...state.importData.edits[index],
        [target.dataset.field]: target.value,
      }
      render()
    }
  } catch (error) {
    showNotice(error.message || 'Không thể lưu thay đổi.')
  }
})

app.addEventListener('input', (event) => {
  const field = event.target.dataset.detailField
  if (state.detailDraft && !state.detailBusy && ['meaning', 'example', 'category'].includes(field)) {
    state.detailDraft[field] = event.target.value
  }
})

app.addEventListener('submit', async (event) => {
  if (event.target.id === 'detail-form') {
    event.preventDefault()
    await saveDetail()
    return
  }
  if (event.target.id !== 'auth-form') return
  event.preventDefault()
  if (!supabase) return
  const form = new FormData(event.target)
  const email = String(form.get('email'))
  const password = String(form.get('password'))
  const mode = event.submitter?.value ?? 'login'
  try {
    const response = mode === 'signup'
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password })
    if (response.error) throw response.error
    if (mode === 'signup' && !response.data.session) {
      state.authOpen = false
      showNotice('Kiểm tra email để xác nhận tài khoản.')
      return
    }
    state.user = response.data.user
    state.authOpen = false
    await loadData()
  } catch (error) {
    showNotice(error.message || 'Không thể xác thực tài khoản.')
  }
})

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.autoRunning) {
    stopAuto()
    render()
  }
})

if (supabase) {
  supabase.auth.getSession().then(({ data, error }) => {
    if (error) showNotice(error.message)
    state.user = data?.session?.user ?? null
    loadData().catch((loadError) => showNotice(loadError.message))
  })
  supabase.auth.onAuthStateChange((_event, session) => {
    state.user = session?.user ?? null
  })
} else {
  const saved = localLoad()
  state.words = saved.words
  state.settings = saved.settings
}

if ('speechSynthesis' in window) {
  state.voices = window.speechSynthesis.getVoices()
  window.speechSynthesis.addEventListener('voiceschanged', () => {
    state.voices = window.speechSynthesis.getVoices()
    if (state.settingsOpen) render()
  })
}
render()
