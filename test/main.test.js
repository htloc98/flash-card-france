import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import * as core from '../src/core.js'
import * as xlsx from '../src/xlsx.js'

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8')

function createApp(words = [], { cloud = null, failStorage = false } = {}) {
  const listeners = {}
  const storage = new Map([['mot-flashcards-v1', JSON.stringify({ words })]])
  let renders = 0
  let html = ''
  const app = {
    addEventListener: (type, listener) => { listeners[type] = listener },
    set innerHTML(value) { html = value; renders += 1 },
  }
  // Run the browser entry point with its real import helpers and a minimal DOM shell.
  const environment = cloud ? '{ VITE_SUPABASE_URL: "https://example.test", VITE_SUPABASE_ANON_KEY: "test-key" }' : '{}'
  runInNewContext(source.replace(/^import .+$/gm, '').replace('import.meta.env', environment), {
    ...core,
    ...xlsx,
    crypto,
    createClient: () => cloud.client,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        if (failStorage) throw new Error('Storage unavailable')
        storage.set(key, value)
      },
    },
    document: { querySelector: () => app, addEventListener() {} },
    window: { clearTimeout, setTimeout: () => 0, requestAnimationFrame: (callback) => callback(), scrollTo() {}, scrollY: 120 },
  })
  return { listeners, storage, get renders() { return renders }, get html() { return html } }
}

function actionTarget(action, selector = 'button') {
  const target = {
    dataset: { action },
    matches: (value) => value === selector,
    closest: () => target,
  }
  return target
}

for (const action of ['close-import', 'close-settings', 'close-auth', 'close-detail']) {
  test(`clicking inside ${action} does not replace the active controls`, async () => {
    const app = createApp()
    const overlay = actionTarget(action, '.overlay')
    const input = { closest: () => overlay }
    const before = app.renders
    await app.listeners.click({ target: input })
    assert.equal(app.renders, before)
  })
}

for (const selector of ['.overlay', 'button']) {
  test(`import can still be closed by ${selector}`, async () => {
    const app = createApp()
    await app.listeners.click({ target: actionTarget('import') })
    assert.match(app.html, /id="import-file"/)
    await app.listeners.click({ target: actionTarget('close-import', selector) })
    assert.doesNotMatch(app.html, /id="import-file"/)
  })
}

test('CSV selection previews and saves accented vocabulary to local storage', async () => {
  const app = createApp()
  await app.listeners.click({ target: actionTarget('import') })
  await app.listeners.change({
    target: {
      id: 'import-file',
      files: [{
        name: 'lesson.csv',
        size: 200,
        text: async () => '\uFEFFTừ gốc,Phiên âm,Loại từ/Giống,Nghĩa,Ví dụ đơn giản\nBonjour,/bɔ̃.ʒuʁ/,Thán từ,xin chào,"Bonjour, comment ça va ?"',
      }],
    },
  })
  assert.match(app.html, /1 dòng dữ liệu/)
  assert.match(app.html, /value="Bonjour"/)
  await app.listeners.click({ target: actionTarget('confirm-import') })
  const saved = JSON.parse(app.storage.get('mot-flashcards-v1'))
  assert.equal(saved.words.length, 1)
  assert.equal(saved.words[0].word, 'Bonjour')
  assert.equal(saved.words[0].meaning, 'xin chào')
  assert.equal(saved.words[0].example, 'Bonjour, comment ça va ?')
})

const detailWord = {
  id: 'word-1', word: 'Bonjour', pronunciation: '/bonjour/', part_of_speech: 'interjection',
  meaning: 'hello', example: 'Bonjour !', categories: ['Greeting'], read_text: 'Bonjour', language: 'fr-FR',
}

async function openDetail(app) {
  const target = actionTarget('detail')
  target.dataset.id = detailWord.id
  await app.listeners.click({ target })
}

async function editDetail(app, changes) {
  await app.listeners.click({ target: actionTarget('edit-detail') })
  for (const [field, value] of Object.entries(changes)) {
    await app.listeners.input({ target: { dataset: { detailField: field }, value } })
  }
}

async function submitDetail(app) {
  await app.listeners.submit({ target: { id: 'detail-form' }, preventDefault() {} })
}

test('detail edit offers only meaning, example, and category fields', async () => {
  const app = createApp([detailWord])
  await openDetail(app)
  assert.match(app.html, /data-action="edit-detail"/)
  await app.listeners.click({ target: actionTarget('edit-detail') })
  assert.deepEqual([...app.html.matchAll(/data-detail-field="([^"]+)"/g)].map((match) => match[1]), ['meaning', 'example', 'category'])
  assert.match(app.html, /data-action="delete-detail"/)
})

test('detail save changes only permitted fields and replaces categories', async () => {
  const app = createApp([detailWord])
  await openDetail(app)
  await editDetail(app, { meaning: '  xin chao  ', example: '', category: 'New; Second; New', word: 'changed', language: 'en-US' })
  await submitDetail(app)
  const saved = JSON.parse(app.storage.get('mot-flashcards-v1')).words[0]
  assert.deepEqual(saved, { ...detailWord, meaning: 'xin chao', example: '', categories: ['New', 'Second'] })
  assert.doesNotMatch(app.html, /id="detail-form"/)
  assert.match(app.html, /xin chao/)
})

test('detail save can clear all categories', async () => {
  const app = createApp([detailWord])
  await openDetail(app)
  await editDetail(app, { category: '' })
  await submitDetail(app)
  assert.deepEqual(JSON.parse(app.storage.get('mot-flashcards-v1')).words[0].categories, [])
})

test('detail save rejects blank meaning and retains the draft', async () => {
  const app = createApp([detailWord])
  await openDetail(app)
  await editDetail(app, { meaning: '   ', example: 'Draft example' })
  await submitDetail(app)
  assert.deepEqual(JSON.parse(app.storage.get('mot-flashcards-v1')).words, [detailWord])
  assert.match(app.html, /role="alert"/)
  assert.match(app.html, /Draft example/)
  assert.match(app.html, /id="detail-form"/)
})

test('cancel detail edit discards changes', async () => {
  const app = createApp([detailWord])
  await openDetail(app)
  await editDetail(app, { meaning: 'Discard me' })
  await app.listeners.click({ target: actionTarget('cancel-detail-edit') })
  assert.doesNotMatch(app.html, /Discard me|id="detail-form"/)
  assert.deepEqual(JSON.parse(app.storage.get('mot-flashcards-v1')).words, [detailWord])
})

test('delete requires confirmation and can be cancelled', async () => {
  const app = createApp([detailWord])
  await openDetail(app)
  await editDetail(app, {})
  await app.listeners.click({ target: actionTarget('delete-detail') })
  assert.match(app.html, /data-action="confirm-delete-detail"/)
  assert.deepEqual(JSON.parse(app.storage.get('mot-flashcards-v1')).words, [detailWord])
  await app.listeners.click({ target: actionTarget('cancel-delete-detail') })
  assert.doesNotMatch(app.html, /data-action="confirm-delete-detail"/)
  assert.match(app.html, /id="detail-form"/)
})

test('deleting the last vocabulary closes detail and shows the empty state', async () => {
  const app = createApp([detailWord])
  await openDetail(app)
  await editDetail(app, {})
  await app.listeners.click({ target: actionTarget('delete-detail') })
  await app.listeners.click({ target: actionTarget('confirm-delete-detail') })
  assert.deepEqual(JSON.parse(app.storage.get('mot-flashcards-v1')).words, [])
  assert.doesNotMatch(app.html, /class="dialog detail-dialog"/)
  assert.match(app.html, /class="empty-state"/)
})

function createCloud(words, failure = '') {
  const calls = []
  const savedWords = structuredClone(words)
  let activeFailure = failure
  return {
    calls,
    words: savedWords,
    clearFailure() { activeFailure = '' },
    client: {
      auth: {
        getSession: async () => ({ data: { session: { user: { id: 'owner-1', email: 'test@example.test' } } } }),
        onAuthStateChange() {},
      },
      from(table) {
        const call = { table, operation: 'select', filters: [] }
        calls.push(call)
        const result = () => {
          if (`${table}:${call.operation}` === activeFailure) return { error: new Error('Request failed') }
          if (table === 'user_settings') return { data: null }
          if (table === 'categories') return { data: { id: `category-${call.values.name}` } }
          const wordId = call.filters.find(([field]) => field === 'id' || field === 'vocabulary_id')?.[1] ?? call.values?.[0]?.vocabulary_id
          const word = savedWords.find((item) => item.id === wordId)
          if (table === 'vocabulary_categories') {
            if (call.operation === 'select') return { data: word.categories.map((name) => ({ category_id: `category-${name}` })) }
            if (call.operation === 'insert') word.categories.push(...call.values.map((link) => link.category_id.slice('category-'.length)))
            if (call.operation === 'delete') word.categories = call.removedIds ? word.categories.filter((name) => !call.removedIds.includes(`category-${name}`)) : []
            return { data: null }
          }
          if (call.operation === 'update') Object.assign(word, call.values)
          if (call.operation === 'delete') savedWords.splice(savedWords.indexOf(word), 1)
          const rows = savedWords.filter((item) => !wordId || item.id === wordId).map((word) => ({
            ...word, vocabulary_categories: word.categories.map((name) => ({ categories: { name } })),
          }))
          if (call.operation === 'select') return { data: call.single ? rows[0] : rows }
          return { data: { id: 'word-1' } }
        }
        const query = {
          select() { return query },
          order() { return query },
          update(values) { Object.assign(call, { operation: 'update', values }); return query },
          upsert(values) { Object.assign(call, { operation: 'upsert', values }); return query },
          insert(values) { Object.assign(call, { operation: 'insert', values }); return query },
          delete() { call.operation = 'delete'; return query },
          eq(field, value) { call.filters.push([field, value]); return query },
          in(field, values) { assert.equal(field, 'category_id'); call.removedIds = values; return query },
          single() { call.single = true; return query },
          maybeSingle() { return query },
          then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject) },
        }
        return query
      },
    },
  }
}

async function openCloudDetail(cloud) {
  const app = createApp([], { cloud })
  await new Promise(setImmediate)
  await openDetail(app)
  return app
}

test('signed-in detail save sends only meaning and example and replaces category links', async () => {
  const cloud = createCloud([detailWord])
  const app = await openCloudDetail(cloud)
  await editDetail(app, { meaning: 'updated', example: '', category: 'New; Second', pronunciation: 'changed' })
  await submitDetail(app)
  const update = cloud.calls.find((call) => call.operation === 'update')
  assert.deepEqual(JSON.parse(JSON.stringify(update.values)), { meaning: 'updated', example: '' })
  assert.deepEqual(update.filters, [['id', detailWord.id]])
  const links = cloud.calls.filter((call) => call.table === 'vocabulary_categories')
  assert.deepEqual(links.map((call) => call.operation), ['select', 'insert', 'delete'])
  assert.deepEqual(links[0].filters, [['vocabulary_id', detailWord.id]])
  assert.deepEqual(JSON.parse(JSON.stringify(links[1].values)), [
    { vocabulary_id: detailWord.id, category_id: 'category-New' },
    { vocabulary_id: detailWord.id, category_id: 'category-Second' },
  ])
  assert.match(app.html, /updated/)
  assert.doesNotMatch(app.html, /id="detail-form"/)
  assert.deepEqual(cloud.words[0].categories, ['New', 'Second'])
})

test('meaning-only cloud edits leave category links untouched', async () => {
  const cloud = createCloud([detailWord], 'vocabulary_categories:insert')
  const app = await openCloudDetail(cloud)
  await editDetail(app, { meaning: 'Changed meaning' })
  await submitDetail(app)
  assert.equal(cloud.calls.some((call) => call.table === 'vocabulary_categories'), false)
  assert.deepEqual(cloud.words[0].categories, ['Greeting'])
  assert.doesNotMatch(app.html, /id="detail-form"/)
})

test('failed category addition preserves old links, reconciles saved fields, and can retry', async () => {
  const cloud = createCloud([detailWord], 'vocabulary_categories:insert')
  const app = await openCloudDetail(cloud)
  await editDetail(app, { meaning: 'Saved meaning', category: 'New' })
  await submitDetail(app)
  assert.deepEqual(cloud.words[0].categories, ['Greeting'])
  await app.listeners.click({ target: actionTarget('cancel-detail-edit') })
  assert.match(app.html, /class="meaning">Saved meaning/)
  assert.match(app.html, /class="tag">Greeting/)
  cloud.clearFailure()
  await editDetail(app, { category: 'New' })
  await submitDetail(app)
  assert.deepEqual(cloud.words[0].categories, ['New'])
  assert.doesNotMatch(app.html, /id="detail-form"/)
})

for (const failure of ['vocabularies:update', 'vocabulary_categories:insert']) {
  test(`signed-in save failure at ${failure} retains the draft and allows retry`, async () => {
    const app = await openCloudDetail(createCloud([detailWord], failure))
    await editDetail(app, { meaning: 'Draft meaning', category: 'New' })
    await submitDetail(app)
    assert.match(app.html, /role="alert">Request failed/)
    assert.match(app.html, /Draft meaning/)
    assert.match(app.html, /aria-busy="false"/)
    assert.match(app.html, /id="detail-form"/)
  })
}

for (const failure of ['', 'vocabularies:delete']) {
  test(`signed-in delete ${failure ? 'failure preserves the word' : 'removes only the selected word'}`, async () => {
    const cloud = createCloud([detailWord], failure)
    const app = await openCloudDetail(cloud)
    await editDetail(app, {})
    await app.listeners.click({ target: actionTarget('delete-detail') })
    await app.listeners.click({ target: actionTarget('confirm-delete-detail') })
    const deletion = cloud.calls.find((call) => call.operation === 'delete')
    assert.equal(deletion.table, 'vocabularies')
    assert.deepEqual(deletion.filters, [['id', detailWord.id]])
    if (failure) {
      assert.match(app.html, /role="alert">Request failed/)
      assert.match(app.html, /data-action="confirm-delete-detail"/)
      assert.match(app.html, /aria-busy="false"/)
    } else {
      assert.doesNotMatch(app.html, /class="dialog detail-dialog"/)
      assert.match(app.html, /class="empty-state"/)
    }
  })
}

test('failed local storage save leaves the original word and draft intact', async () => {
  const app = createApp([detailWord], { failStorage: true })
  await openDetail(app)
  await editDetail(app, { meaning: 'Unsaved meaning' })
  await submitDetail(app)
  assert.match(app.html, /role="alert">Storage unavailable/)
  assert.match(app.html, /Unsaved meaning/)
  assert.deepEqual(JSON.parse(app.storage.get('mot-flashcards-v1')).words, [detailWord])
  await app.listeners.click({ target: actionTarget('cancel-detail-edit') })
  assert.match(app.html, /class="meaning">hello/)
})

test('deleting an earlier vocabulary preserves the current study word', async () => {
  const secondWord = { ...detailWord, id: 'word-2', word: 'Merci' }
  const app = createApp([detailWord, secondWord])
  await app.listeners.click({ target: actionTarget('next') })
  await openDetail(app)
  await editDetail(app, {})
  await app.listeners.click({ target: actionTarget('delete-detail') })
  await app.listeners.click({ target: actionTarget('confirm-delete-detail') })
  assert.match(app.html, /class="card-word">Merci/)
  assert.deepEqual(JSON.parse(app.storage.get('mot-flashcards-v1')).words, [secondWord])
})

for (const operation of ['save', 'delete']) {
  test(`${operation} preserves the uncategorized filter`, async () => {
    const app = createApp([{ ...detailWord, categories: [] }, { ...detailWord, id: 'word-2' }])
    const view = actionTarget('view')
    view.dataset.view = 'library'
    await app.listeners.click({ target: view })
    const mode = actionTarget('list-mode')
    mode.dataset.mode = 'category'
    await app.listeners.click({ target: mode })
    const category = actionTarget('category')
    category.dataset.category = 'Chưa phân loại'
    await app.listeners.click({ target: category })
    await openDetail(app)
    await editDetail(app, { meaning: 'updated' })
    if (operation === 'save') {
      await submitDetail(app)
    } else {
      await app.listeners.click({ target: actionTarget('delete-detail') })
      await app.listeners.click({ target: actionTarget('confirm-delete-detail') })
    }
    assert.match(app.html, /class="category-chip selected" data-action="category" data-category="Chưa phân loại"/)
    assert.doesNotMatch(app.html, /class="word-row"[^>]+data-id="word-2"/)
  })
}
