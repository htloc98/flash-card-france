import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React from 'react'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:3000' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.localStorage = dom.window.localStorage
globalThis.IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
const { render, screen, fireEvent, cleanup, waitFor, act } = await import('@testing-library/react')
const { default: FlashcardApp } = await import('../src/components/FlashcardApp.jsx')

afterEach(() => { cleanup(); localStorage.clear() })

const original = { id: 'word-1', word: 'Bonjour', pronunciation: '/bɔ̃.ʒuʁ/', part_of_speech: 'Thán từ', meaning: 'xin chào', example: 'Bonjour !', read_text: '', language: 'fr-FR', categories: ['Greeting'] }

function fixture({ failLoad = false, failSave = false, paginated = false } = {}) {
  const words = [structuredClone(original)]
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, ...options })
    const body = options.body ? JSON.parse(options.body) : null
    if (url === '/api/data') return failLoad ? Response.json({ error: 'Cloud unavailable' }, { status: 503 }) : Response.json({ words, settings: { frontDelay: 4, backDelay: 4, autoSpeak: false }, nextCursor: paginated ? 1 : null })
    if (url === '/api/data?after=1') return Response.json({ words: [{ ...original, id: 'word-2', word: 'Salut' }], nextCursor: null })
    if (failSave) return Response.json({ error: 'Save failed' }, { status: 503 })
    if (options.method === 'POST') { const saved = { ...body, id: body.id || 'new-word' }; words.push(saved); return Response.json(saved, { status: 201 }) }
    if (options.method === 'DELETE') { words.splice(words.findIndex((word) => url.endsWith(word.id)), 1); return Response.json({ deleted: true }) }
    if (options.method === 'PUT' && url.includes('/words/')) { const word = words.find((item) => url.endsWith(item.id)); Object.assign(word, body); return Response.json(word) }
    return Response.json(body)
  }
  render(React.createElement(FlashcardApp, { user: { id: 'owner', email: 'owner@example.com' }, ready: true }))
  return { words, calls, recover() { failLoad = false; failSave = false } }
}

async function openDetail() {
  await screen.findByText('Bonjour')
  fireEvent.click(screen.getByRole('button', { name: 'Lật thẻ' }))
  fireEvent.click(screen.getByRole('button', { name: 'Xem chi tiết' }))
}

test('unauthenticated view offers Google and does not expose local vocabulary', () => {
  localStorage.setItem('mot-flashcards-v1', JSON.stringify({ words: [original] }))
  render(React.createElement(FlashcardApp, { user: null, ready: true }))
  assert.ok(screen.getByRole('button', { name: 'Đăng nhập Google' }))
  assert.equal(screen.queryByText('Bonjour'), null)
  assert.equal(screen.queryByLabelText('Mật khẩu'), null)
})

test('missing configuration disables login instead of silently using local storage', () => {
  render(React.createElement(FlashcardApp, { user: null, ready: false }))
  assert.equal(screen.getByRole('button', { name: 'Đăng nhập Google' }).disabled, true)
  assert.ok(screen.getByRole('alert'))
})

test('loads cloud words and flips locally without another API request', async () => {
  const { calls } = fixture()
  await screen.findByText('Bonjour')
  fireEvent.click(screen.getByRole('button', { name: 'Lật thẻ' }))
  assert.ok(screen.getByText('xin chào'))
  assert.equal(calls.length, 1)
})

test('loads every cloud page before enabling study navigation', async () => {
  const cloud = fixture({ paginated: true })
  await screen.findByText('Bonjour')
  fireEvent.click(screen.getByRole('button', { name: 'Sau' }))
  await screen.findByText('Salut')
  assert.equal(cloud.calls.length, 2)
})

test('auto review flips on schedule, stops at the last card, and pauses for manual actions', async (context) => {
  fixture()
  await screen.findByText('Bonjour')
  context.mock.timers.enable({ apis: ['setTimeout'] })
  fireEvent.click(screen.getByRole('button', { name: 'Tự động' }))
  await act(async () => { context.mock.timers.tick(4000) })
  assert.ok(screen.getByText('xin chào'))
  await act(async () => { context.mock.timers.tick(4000) })
  assert.equal(screen.getByRole('button', { name: 'Tự động' }).getAttribute('aria-pressed'), 'false')
  fireEvent.click(screen.getByRole('button', { name: 'Tự động' }))
  fireEvent.click(screen.getByRole('button', { name: 'Lật thẻ' }))
  assert.equal(screen.getByRole('button', { name: 'Tự động' }).getAttribute('aria-pressed'), 'false')
})

test('review settings persist to cloud and are reused when reopening settings', async () => {
  const cloud = fixture()
  await screen.findByText('Bonjour')
  fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }))
  fireEvent.change(screen.getByLabelText('Mặt trước'), { target: { value: '2' } })
  fireEvent.change(screen.getByLabelText('Mặt sau'), { target: { value: '7' } })
  fireEvent.click(screen.getByLabelText('Tự đọc mặt sau'))
  fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }))
  await waitFor(() => assert.equal(screen.queryByRole('dialog') === null, true))
  const saved = cloud.calls.find((call) => call.url === '/api/data/settings')
  assert.deepEqual(JSON.parse(saved.body), { frontDelay: 2, backDelay: 7, autoSpeak: true })
  fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }))
  assert.equal(screen.getByLabelText('Mặt trước').value, '2')
  assert.equal(screen.getByLabelText('Tự đọc mặt sau').checked, true)
})

test('cloud load errors offer retry and never fall back to local vocabulary', async () => {
  const cloud = fixture({ failLoad: true })
  await screen.findByText('Cloud unavailable')
  assert.equal(screen.queryByText('Bonjour'), null)
  cloud.recover()
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
  await screen.findByText('Bonjour')
})

test('detail edits preserve other fields and clear categories through the API', async () => {
  const cloud = fixture()
  await openDetail()
  fireEvent.click(screen.getByRole('button', { name: 'Chỉnh sửa từ vựng' }))
  fireEvent.change(screen.getByLabelText('Nghĩa'), { target: { value: 'hello' } })
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Lưu' }))
  await waitFor(() => assert.equal(cloud.words[0].meaning, 'hello'))
  await waitFor(() => assert.equal(screen.queryByRole('button', { name: 'Lưu' }), null))
  assert.equal(cloud.words[0].pronunciation, original.pronunciation)
  assert.deepEqual(cloud.words[0].categories, [])
  assert.equal(localStorage.getItem('mot-flashcards-v1'), null)
})

test('failed save retains the draft and allows retry', async () => {
  const cloud = fixture({ failSave: true })
  await openDetail()
  fireEvent.click(screen.getByRole('button', { name: 'Chỉnh sửa từ vựng' }))
  fireEvent.change(screen.getByLabelText('Nghĩa'), { target: { value: 'draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Lưu' }))
  await screen.findByText('Save failed')
  assert.equal(screen.getByLabelText('Nghĩa').value, 'draft')
  assert.equal(cloud.words[0].meaning, original.meaning)
  cloud.recover()
  fireEvent.click(screen.getByRole('button', { name: 'Lưu' }))
  await waitFor(() => assert.equal(screen.queryByRole('button', { name: 'Lưu' }), null))
})

test('delete requires confirmation and leaves the empty state', async () => {
  const cloud = fixture()
  await openDetail()
  fireEvent.click(screen.getByRole('button', { name: 'Chỉnh sửa từ vựng' }))
  fireEvent.click(screen.getByRole('button', { name: 'Xóa từ vựng' }))
  assert.equal(cloud.words.length, 1)
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận xóa' }))
  await screen.findByText('Chưa có từ vựng')
  assert.equal(cloud.words.length, 0)
})

test('CSV import previews accents and saves quoted fields to cloud', async () => {
  const cloud = fixture()
  await screen.findByText('Bonjour')
  fireEvent.click(screen.getByRole('button', { name: 'Nhập tệp' }))
  fireEvent.change(screen.getByLabelText('Chọn tệp'), { target: { files: [{ name: 'lesson.csv', size: 200, text: async () => 'Từ gốc,Nghĩa,Ví dụ đơn giản\nété,mùa hè,"Oui, été !"' }] } })
  await screen.findByDisplayValue('été')
  assert.equal(cloud.words.length, 1)
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận nhập' }))
  await screen.findByText('Đã thêm 1, cập nhật 0, bỏ qua 0.')
  assert.equal(cloud.words[1].word, 'été')
  assert.equal(cloud.words[1].example, 'Oui, été !')
})

test('duplicate CSV import can update mapped fields without clearing unmapped fields', async () => {
  const cloud = fixture()
  await screen.findByText('Bonjour')
  fireEvent.click(screen.getByRole('button', { name: 'Nhập tệp' }))
  fireEvent.change(screen.getByLabelText('Chọn tệp'), { target: { files: [{ name: 'lesson.csv', size: 100, text: async () => 'Từ gốc,Nghĩa\nBonjour,hello' }] } })
  await screen.findByDisplayValue('hello')
  fireEvent.change(screen.getByLabelText('Xử lý từ trùng dòng 2'), { target: { value: 'update' } })
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận nhập' }))
  await screen.findByText('Đã thêm 0, cập nhật 1, bỏ qua 0.')
  assert.equal(cloud.words.length, 1)
  assert.equal(cloud.words[0].meaning, 'hello')
  assert.equal(cloud.words[0].pronunciation, original.pronunciation)
  assert.deepEqual(cloud.words[0].categories, ['Greeting'])
})