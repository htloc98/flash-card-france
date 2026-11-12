'use client'

import React, { useEffect, useState } from 'react'
import { signIn, signOut } from 'next-auth/react'
import { ArrowLeft, ArrowRight, BookOpen, Download, Folder, List, LogIn, LogOut, Pause, Pencil, Play, RotateCw, Settings, Upload, Volume2 } from 'lucide-react'
import Dialog from './Dialog.jsx'
import ImportDialog from './ImportDialog.jsx'
import { serializeCSV } from '../core.js'

const defaults = { frontDelay: 4, backDelay: 4, autoSpeak: false }

async function request(path = '', method = 'GET', body, signal) {
  const response = await fetch(`/api/data${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Không thể lưu dữ liệu cloud.')
  return data
}

function WordFields({ word }) {
  return <div className="word-detail"><h2>{word.word}</h2>{word.pronunciation && <p className="pronunciation">{word.pronunciation}</p>}{word.part_of_speech && <p className="part">{word.part_of_speech}</p>}<p className="meaning">{word.meaning}</p>{word.example && <p className="example">{word.example}</p>}<div className="tag-row">{word.categories.map((name) => <span className="tag" key={name}>{name}</span>)}</div></div>
}

function Detail({ word, onSave, onDelete, onClose, speak }) {
  const [draft, setDraft] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save(event) {
    event.preventDefault()
    if (!draft.meaning.trim()) { setError('Vui lòng nhập nghĩa của từ.'); return }
    setBusy(true)
    setError('')
    try {
      await onSave({ ...word, meaning: draft.meaning.trim(), example: draft.example.trim(), categories: [...new Set(draft.category.split(/[;|]/).map((name) => name.trim()).filter(Boolean))] }, true)
      setDraft(null)
    } catch (failure) { setError(failure.message) }
    finally { setBusy(false) }
  }
  async function remove() {
    setBusy(true)
    setError('')
    try { await onDelete(word.id); onClose() }
    catch (failure) { setError(failure.message); setBusy(false) }
  }
  return <Dialog title="Chi tiết từ vựng" onClose={onClose} busy={busy} className="detail-dialog">
    {!draft ? <><WordFields word={word} /><div className="detail-actions"><button className="button button-secondary" onClick={() => speak(word)}><Volume2 size={16} /> Nghe phát âm</button><button className="icon-button" aria-label="Chỉnh sửa từ vựng" title="Chỉnh sửa từ vựng" onClick={() => setDraft({ meaning: word.meaning, example: word.example, category: word.categories.join('; ') })}><Pencil size={16} /></button></div></> : <form onSubmit={save}>
      <h3>{word.word}</h3><fieldset className="detail-fields" disabled={busy || deleting}>
        <label htmlFor="meaning">Nghĩa</label><textarea id="meaning" required rows={2} value={draft.meaning} onChange={(event) => setDraft({ ...draft, meaning: event.target.value })} />
        <label htmlFor="example">Ví dụ</label><textarea id="example" rows={3} value={draft.example} onChange={(event) => setDraft({ ...draft, example: event.target.value })} />
        <label htmlFor="category">Category</label><input id="category" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} />
      </fieldset>
      {deleting ? <div className="detail-delete-confirm"><p>Xóa “{word.word}”? Không thể hoàn tác.</p><div className="detail-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setDeleting(false)}>Hủy</button><button type="button" className="button button-danger" disabled={busy} onClick={remove}>Xác nhận xóa</button></div></div> : <div className="detail-actions"><button type="button" className="button button-danger detail-delete" disabled={busy} onClick={() => setDeleting(true)}>Xóa từ vựng</button><button type="button" className="button button-secondary" disabled={busy} onClick={() => { setDraft(null); setError('') }}>Hủy</button><button className="button button-primary" disabled={busy}>{busy ? 'Đang lưu...' : 'Lưu'}</button></div>}
    </form>}
    {error && <p className="detail-error" role="alert">{error}</p>}
  </Dialog>
}

function SettingsDialog({ settings, voices, deviceVoice, onVoice, onSave, onClose }) {
  const [draft, setDraft] = useState(settings)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    try { await onSave(draft); onClose() }
    catch (failure) { setError(failure.message); setBusy(false) }
  }
  return <Dialog title="Tự động & âm thanh" busy={busy} onClose={onClose}><form onSubmit={submit}><fieldset disabled={busy} className="import-fieldset">
    {[['frontDelay', 'Mặt trước'], ['backDelay', 'Mặt sau']].map(([key, title]) => <label className="setting-row" key={key}>{title}<select value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })}>{Array.from({ length: 10 }, (_, index) => <option key={index} value={index + 1}>{index + 1} giây</option>)}</select></label>)}
    <label className="toggle-row">Tự đọc mặt sau<input type="checkbox" checked={draft.autoSpeak} onChange={(event) => setDraft({ ...draft, autoSpeak: event.target.checked })} /></label>
    <label className="setting-row">Giọng đọc<select value={deviceVoice} onChange={(event) => onVoice(event.target.value)}><option value="">Mặc định</option>{voices.filter((voice) => voice.lang.startsWith('fr')).map((voice) => <option value={voice.voiceURI} key={voice.voiceURI}>{voice.name}</option>)}</select></label>
    <div className="detail-actions"><button className="button button-primary">Lưu cài đặt</button></div>
  </fieldset></form>{error && <p role="alert" className="detail-error">{error}</p>}</Dialog>
}

export default function FlashcardApp({ user, ready, authError = '' }) {
  const [words, setWords] = useState([])
  const [settings, setSettings] = useState(defaults)
  const [loading, setLoading] = useState(Boolean(user))
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [view, setView] = useState('study')
  const [grouped, setGrouped] = useState(false)
  const [category, setCategory] = useState('')
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [running, setRunning] = useState(false)
  const [modal, setModal] = useState(null)
  const [notice, setNotice] = useState('')
  const [voices, setVoices] = useState([])
  const [deviceVoice, setDeviceVoice] = useState('')
  const word = words[Math.min(index, Math.max(0, words.length - 1))]
  const categories = [...new Set(words.flatMap((item) => item.categories))].sort((first, second) => first.localeCompare(second))

  useEffect(() => {
    if (!user) return
    const controller = new AbortController()
    setLoading(true)
    setLoadError('')
    async function loadPages() {
      const first = await request('', 'GET', undefined, controller.signal)
      const allWords = [...first.words]
      let cursor = first.nextCursor
      while (cursor != null) {
        const page = await request(`?after=${cursor}`, 'GET', undefined, controller.signal)
        allWords.push(...page.words)
        if (page.nextCursor != null && page.nextCursor <= cursor) throw new Error('Invalid cloud pagination')
        cursor = page.nextCursor
      }
      return { words: allWords, settings: first.settings }
    }
    loadPages().then((data) => {
      if (controller.signal.aborted) return
      setWords(data.words); setSettings(data.settings); setIndex(0); setFlipped(false); setLoading(false)
    }).catch((failure) => { if (!controller.signal.aborted) { setLoadError(failure.message); setLoading(false) } })
    return () => controller.abort()
  }, [user?.id, reload])

  useEffect(() => {
    try { setDeviceVoice(localStorage.getItem('mot-device-voice') ?? '') } catch {}
    const update = () => setVoices(window.speechSynthesis?.getVoices() ?? [])
    update()
    window.speechSynthesis?.addEventListener('voiceschanged', update)
    const visibility = () => { if (document.hidden) { setRunning(false); window.speechSynthesis?.cancel() } }
    document.addEventListener('visibilitychange', visibility)
    return () => { window.speechSynthesis?.removeEventListener('voiceschanged', update); window.speechSynthesis?.cancel(); document.removeEventListener('visibilitychange', visibility) }
  }, [])

  function speak(entry) {
    const available = voices.filter((voice) => voice.lang.toLowerCase().startsWith((entry.language || 'fr-FR').split('-')[0].toLowerCase()))
    if (!window.speechSynthesis || !available.length) { setNotice('Không tìm thấy giọng đọc phù hợp trên thiết bị.'); return }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(entry.read_text || entry.word)
    utterance.lang = entry.language
    utterance.voice = available.find((voice) => voice.voiceURI === deviceVoice) ?? available[0]
    window.speechSynthesis.speak(utterance)
  }

  useEffect(() => {
    if (!running || !word) return
    const timer = setTimeout(() => {
      if (!flipped) { setFlipped(true); if (settings.autoSpeak) speak(word) }
      else if (index < words.length - 1) { window.speechSynthesis?.cancel(); setIndex(index + 1); setFlipped(false) }
      else setRunning(false)
    }, (flipped ? settings.backDelay : settings.frontDelay) * 1000)
    return () => clearTimeout(timer)
  }, [running, flipped, index, words, settings, deviceVoice, voices])

  function pause() { setRunning(false); window.speechSynthesis?.cancel() }
  function open(value) { pause(); setModal(value); setNotice('') }
  async function save(entry, update = false) {
    const saved = await request(update ? `/words/${entry.id}` : '/words', update ? 'PUT' : 'POST', entry)
    setWords((current) => update ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved])
    return saved
  }
  async function remove(id) {
    await request(`/words/${id}`, 'DELETE')
    setWords((current) => current.filter((item) => item.id !== id))
    setIndex(0); setFlipped(false)
  }
  function exportCSV() {
    const rows = [['Từ gốc', 'Phiên âm', 'Loại từ/Giống', 'Nghĩa', 'Ví dụ đơn giản', 'Văn bản đọc', 'Category', 'Ngôn ngữ'], ...words.map((item) => [item.word, item.pronunciation, item.part_of_speech, item.meaning, item.example, item.read_text, item.categories.join(';'), item.language])]
    const content = serializeCSV(rows)
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'mot-vocabulary.csv'; anchor.click(); URL.revokeObjectURL(url)
  }
  const filtered = category === '__none' ? words.filter((item) => !item.categories.length) : category ? words.filter((item) => item.categories.includes(category)) : words
  const row = (item) => <button key={item.id} className="word-row" onClick={() => open(item.id)}><span className="row-word">{item.word}</span><span className="row-pronunciation">{item.pronunciation}</span><span className="row-meaning">{item.meaning}</span><ArrowRight className="row-arrow" size={16} /></button>
  const selected = words.find((item) => item.id === modal)
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/" aria-label="mot."><span className="brand-mark">m.</span><span>mot<span className="brand-dot">.</span></span></a>
      {user && <><nav className="main-nav" aria-label="Điều hướng">{[['study', 'Ôn tập'], ['library', 'Từ vựng']].map(([key, title]) => <button key={key} className={view === key ? 'active' : ''} onClick={() => { pause(); setView(key) }}>{title}</button>)}</nav><div className="top-actions"><span className="account-email">{user.email}</span><button className="icon-button" aria-label="Nhập tệp" title="Nhập tệp" disabled={loading || Boolean(loadError)} onClick={() => open('import')}><Upload size={17} /></button><button className="icon-button" aria-label="Cài đặt" title="Cài đặt" disabled={loading || Boolean(loadError)} onClick={() => open('settings')}><Settings size={17} /></button><button className="icon-button" aria-label="Đăng xuất" title="Đăng xuất" onClick={() => { pause(); signOut({ callbackUrl: '/' }) }}><LogOut size={17} /></button></div></>}
    </header>
    <main>
      {!user ? <section className="empty-state sign-in-view"><BookOpen size={42} strokeWidth={1.3} /><h1>mot.</h1><p>Votre carnet de français</p><button className="button button-primary" disabled={!ready} onClick={() => signIn('google', { callbackUrl: '/' })}><LogIn size={17} /> Đăng nhập Google</button>{!ready && <p role="alert" className="detail-error">Chưa cấu hình kết nối Google và Cloudflare D1.</p>}{authError && <p role="alert" className="detail-error">{authError === 'AccessDenied' ? 'Tài khoản này chưa được cấp quyền truy cập.' : 'Không thể đăng nhập. Kiểm tra cấu hình và thử lại.'}</p>}</section>
        : loading ? <section className="empty-state" role="status">Đang tải từ vựng...</section>
          : loadError ? <section className="empty-state"><p role="alert">{loadError}</p><button className="button button-secondary" onClick={() => setReload(reload + 1)}><RotateCw size={16} /> Thử lại</button></section>
            : !words.length ? <section className="empty-state"><BookOpen size={40} /><h2>Chưa có từ vựng</h2><button className="button button-primary" onClick={() => open('import')}>Nhập từ vựng</button></section>
              : view === 'study' ? <section className="study-view"><div className="study-title"><div><p className="eyebrow">GÓC ÔN TẬP</p><h1>Học một chút,<br /><span>nhớ thật lâu.</span></h1></div><span className="count-pill">{Math.min(index + 1, words.length)} / {words.length} thẻ</span></div>
                <button className={`flash-card ${flipped ? 'is-flipped' : ''}`} aria-label={flipped ? 'Lật về mặt trước' : 'Lật thẻ'} onClick={() => { pause(); setFlipped(!flipped); if (!flipped && settings.autoSpeak) speak(word) }}>{flipped ? <span className="card-back"><WordFields word={word} /></span> : <span className="card-word">{word.word}</span>}</button>
                {flipped && <div className="study-aux"><button className="text-button" onClick={() => speak(word)}><Volume2 size={16} /> Nghe phát âm</button><button className="text-button" onClick={() => open(word.id)}>Xem chi tiết</button></div>}
                <div className="study-dock"><div className="dock-inner"><button className="button button-secondary nav-button" aria-label="Trước" disabled={!index} onClick={() => { pause(); setIndex(index - 1); setFlipped(false) }}><ArrowLeft size={17} /></button><span className="dock-count">{index + 1} / {words.length}</span><button className="button button-primary nav-button" aria-label="Sau" disabled={index >= words.length - 1} onClick={() => { pause(); setIndex(index + 1); setFlipped(false) }}><ArrowRight size={17} /></button><span className="dock-divider" /><button className={`button button-auto ${running ? 'active' : ''}`} aria-pressed={running} onClick={() => { if (running) pause(); else { setFlipped(false); setRunning(true) } }}>{running ? <Pause size={16} /> : <Play size={16} />}{running ? 'Dừng' : 'Tự động'}</button></div></div>
              </section> : <section className="library-view"><div className="library-heading"><div><p className="eyebrow">VOTRE COLLECTION</p><h1>Les mots, <span>en clair.</span></h1></div><button className="icon-button" aria-label="Xuất CSV" title="Xuất CSV" onClick={exportCSV}><Download size={18} /></button></div><div className="library-tools"><div className="segmented"><button className={!grouped ? 'selected' : ''} onClick={() => { setGrouped(false); setCategory('') }}><List size={15} /> Danh sách</button><button className={grouped ? 'selected' : ''} onClick={() => { setGrouped(true); setCategory('') }}><Folder size={15} /> Category</button></div><span className="library-count">{words.length} từ</span></div>
                {grouped && <div className="category-filter">{[['', 'Tất cả'], ...categories.map((name) => [name, name]), ['__none', 'Chưa phân loại']].map(([value, name]) => <button className={`category-chip ${category === value ? 'selected' : ''}`} key={value} onClick={() => setCategory(value)}>{name}</button>)}</div>}
                {grouped && !category ? [...categories, ...(words.some((item) => !item.categories.length) ? ['__none'] : [])].map((name) => <section key={name} className="category-group"><h2 className="category-heading">{name === '__none' ? 'Chưa phân loại' : name}</h2><div className="word-list">{words.filter((item) => name === '__none' ? !item.categories.length : item.categories.includes(name)).map(row)}</div></section>) : <div className="word-list">{filtered.map(row)}</div>}
                {!filtered.length && <p className="empty-small">Chưa có từ nào ở đây.</p>}
              </section>}
    </main>
    <footer className="site-footer"><span>mot. <i>un mot à la fois.</i></span><span>{user && !loading && !loadError ? 'Cloudflare D1' : ''}</span></footer>
    {modal === 'import' && <ImportDialog words={words} onSave={save} onClose={() => setModal(null)} />}
    {modal === 'settings' && <SettingsDialog settings={settings} voices={voices} deviceVoice={deviceVoice} onVoice={(value) => { setDeviceVoice(value); try { localStorage.setItem('mot-device-voice', value) } catch { setNotice('Không thể lưu giọng đọc trên thiết bị.') } }} onSave={async (value) => { const saved = await request('/settings', 'PUT', value); setSettings(saved) }} onClose={() => setModal(null)} />}
    {selected && <Detail key={selected.id} word={selected} onSave={save} onDelete={remove} speak={speak} onClose={() => setModal(null)} />}
    {notice && <div className="toast" role="status">{notice}<button className="text-button toast-close" onClick={() => setNotice('')}>Đóng</button></div>}
  </div>
}