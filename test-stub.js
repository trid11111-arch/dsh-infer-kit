'use strict'
/**
 * Stub tests for dsh-infer-kit host half (checklist step 5).
 * Run: node test-stub.js   (exit 0 = all pass)
 * No DSH, no profile, no working data touched.
 */
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const dir = __dirname

async function main () {
  // 0) syntax of both halves
  execFileSync(process.execPath, ['--check', path.join(dir, 'index.js')])
  execFileSync(process.execPath, ['--check', path.join(dir, 'client.js')])
  console.log('ok  node --check index.js client.js')

  // 1) load host half with a stub ctx
  const registered = { tools: [], routes: [] }
  const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inferkit-')), 'store.json')
  const plugin = require(path.join(dir, 'index.js'))

  let disposerCalled = false
  let firstDisposer = null
  const ctx = {
    effect: (fn) => {
      const inner = fn()
      const d = () => { disposerCalled = true; if (typeof inner === 'function') inner() }
      firstDisposer = d
      return d
    },
    inject: (svcs, cb) => cb({
      tools: { register: (t) => registered.tools.push(t) },
      webServer: { register: (r) => registered.routes.push(r) },
    }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  assert.strictEqual(plugin.name, 'dsh-infer-kit')
  plugin.apply(ctx, { storePath, maxEntries: 8 })
  assert.strictEqual(registered.tools.length, 3, 'expected 3 tools')
  assert.strictEqual(registered.routes.length, 1, 'expected 1 route')
  const toolNames = registered.tools.map((t) => t.name).sort()
  assert.deepStrictEqual(toolNames, ['infer_cache_lookup', 'infer_draft_cascade', 'infer_json_validate'])
  console.log('ok  stub ctx: 3 tools + 1 route registered')

  const byName = Object.fromEntries(registered.tools.map((t) => [t.name, t]))

  // 2) cache: store -> exact hit -> miss -> fuzzy hit
  const cache = byName.infer_cache_lookup
  let r = await cache.execute({ mode: 'store', key_text: 'How to parse YAML config in DSH profiles', value: 'Use single quotes in cordis.patch.yml paths', kind: 'agent' })
  assert.strictEqual(r.ok, true)
  r = await cache.execute({ mode: 'lookup', key_text: 'How to parse YAML config in DSH profiles?' })
  assert.strictEqual(r.hit, true, 'exact text should hit')
  assert.ok(r.value.includes('single quotes'), 'hit value content')
  assert.ok(r.similarity >= 0.99, 'exact similarity ~1, got ' + r.similarity)
  r = await cache.execute({ mode: 'lookup', key_text: 'Completely different topic: make coffee with milk' })
  assert.strictEqual(r.hit, false, 'different topic should miss')
  r = await cache.execute({ mode: 'lookup', key_text: 'how to parse yaml config in dsh profile' })
  assert.strictEqual(r.hit, true, 'near-duplicate should hit after normalization')
  console.log('ok  cache store/lookup: exact hit, fuzzy hit, miss')

  // 3) store without value -> rejected
  r = await cache.execute({ mode: 'store', key_text: 'x' })
  assert.strictEqual(r.ok, false, 'store without value must be rejected')
  console.log('ok  cache store validation (empty value rejected)')

  // 4) cascade without draft endpoint -> graceful fallback
  const cascade = byName.infer_draft_cascade
  r = await cascade.execute({ task: 'triage this list' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.used, false, 'no endpoint -> used:false')
  assert.ok(/UNAVAILABLE/.test(r.message), 'fallback message')
  console.log('ok  cascade graceful fallback (no draft endpoint)')

  // 5) validate tool: valid / invalid / bad JSON
  const val = byName.infer_json_validate
  r = await val.execute({ json: '{"ok":true,"message":"x"}', schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'] } })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  r = await val.execute({ json: '{"ok":true}', schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'] } })
  assert.strictEqual(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('missing required property "message"')), JSON.stringify(r.errors))
  r = await val.execute({ json: '{"x":', schema: {} })
  assert.strictEqual(r.ok, false)
  assert.ok(r.errors[0].startsWith('JSON.parse'))
  r = await val.execute({ json: '[1,2]', schema: { type: 'array', items: { type: 'integer' } } })
  assert.strictEqual(r.ok, true)
  r = await val.execute({ json: '[1,"a"]', schema: { type: 'array', items: { type: 'integer' } } })
  assert.strictEqual(r.ok, false)
  r = await val.execute({ json: '"short"', schema: { type: 'string', minLength: 10 } })
  assert.strictEqual(r.ok, false)
  r = await val.execute({ json: '{"k":"a"}', schema: { type: 'object', properties: { k: { enum: ['x', 'y'] } } } })
  assert.strictEqual(r.ok, false)
  r = await val.execute({ json: '{"k":"x","extra":1}', schema: { type: 'object', additionalProperties: false, properties: { k: { type: 'string' } } } })
  assert.strictEqual(r.ok, false)
  assert.ok(r.errors.some((e) => e.includes('unexpected property "extra"')), JSON.stringify(r.errors))
  console.log('ok  validator: parse, required, items, minLength, enum, additionalProperties')

  // 6) capacity cap: fill beyond maxEntries=2, oldest must be evicted
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'inferkit2-'))
    const storePath2 = path.join(dir2, 'store.json')
    delete require.cache[require.resolve(path.join(dir, 'index.js'))]
    const mod2 = require(path.join(dir, 'index.js'))
    const reg2 = { tools: [] }
    let cleanup = null
    mod2.apply({
      effect: (f) => { const d = f(); cleanup = d; return () => { if (typeof d === 'function') d() } },
      inject: (s, cb) => cb({ tools: { register: (t) => reg2.tools.push(t) }, webServer: { register: () => {} } }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }, { storePath: storePath2, maxEntries: 2 })
    const cache2 = reg2.tools.find((t) => t.name === 'infer_cache_lookup')
    await cache2.execute({ mode: 'store', key_text: 'entry one about apples', value: 'v1', kind: 'agent' })
    await new Promise((res) => setTimeout(res, 20))
    await cache2.execute({ mode: 'store', key_text: 'entry two about pears', value: 'v2', kind: 'agent' })
    await new Promise((res) => setTimeout(res, 20))
    await cache2.execute({ mode: 'store', key_text: 'entry three about plums', value: 'v3', kind: 'agent' })
    if (typeof cleanup === 'function') cleanup() // force flush
    const saved = JSON.parse(fs.readFileSync(storePath2, 'utf8'))
    assert.ok(saved.entries.length <= 2, 'cap enforced, entries=' + saved.entries.length)
    assert.ok(!saved.entries.some((e) => e.value === 'v1'), 'oldest entry evicted')
    assert.ok(saved.entries.some((e) => e.value === 'v3'), 'newest entry kept')
  }
  console.log('ok  capacity cap + eviction + atomic persistence roundtrip')

  // 7) ttl pruning: seed an old entry directly, prune on next flush cycle
  {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'inferkit3-'))
    const storePath3 = path.join(dir3, 'store.json')
    const day = 24 * 3600 * 1000
    fs.writeFileSync(storePath3, JSON.stringify({
      version: 1,
      entries: [
        { hash: 'old', tokens: ['stale', 'topic'], value: 'old-value', kind: 'agent', tags: [], created: Date.now() - 4 * day, hits: 0 },
        { hash: 'new', tokens: ['fresh', 'topic'], value: 'new-value', kind: 'chatbot', tags: [], created: Date.now(), hits: 0 },
      ],
    }))
    delete require.cache[require.resolve(path.join(dir, 'index.js'))]
    const mod3 = require(path.join(dir, 'index.js'))
    const reg3 = { tools: [] }
    let cleanup = null
    mod3.apply({
      effect: (f) => { const d = f(); cleanup = () => { if (typeof d === 'function') d() }; return cleanup },
      inject: (s, cb) => cb({ tools: { register: (t) => reg3.tools.push(t) }, webServer: { register: () => {} } }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }, { storePath: storePath3, maxEntries: 10 })
    const cache3 = reg3.tools.find((t) => t.name === 'infer_cache_lookup')
    r = await cache3.execute({ mode: 'lookup', key_text: 'stale topic question' })
    assert.strictEqual(r.hit, false, 'agent entry older than 3d ttl must be pruned at flush/lookup-time store load')
    // force flush to persist the prune
    if (typeof cleanup === 'function') cleanup()
    const saved = JSON.parse(fs.readFileSync(storePath3, 'utf8'))
    assert.ok(!saved.entries.some((e) => e.hash === 'old'), 'old entry physically removed')
    assert.ok(saved.entries.some((e) => e.hash === 'new'), 'fresh entry kept')
  }
  console.log('ok  ttl pruning (agent 3d) + chatbot kept')

  // 8) client artifact contract (shape checks)
  const clientSrc = fs.readFileSync(path.join(dir, 'client.js'), 'utf8')
  assert.ok(clientSrc.includes("id: 'dsh-infer-kit'"), 'client id = package name')
  assert.ok(clientSrc.includes("exports.inject = ['slots']"), 'client exports.inject slots')
  assert.ok(clientSrc.includes('sidebar.footer.action'), 'client mounts sidebar.footer.action')
  assert.ok(/props\s*&&\s*props\.wide|!.*wide/.test(clientSrc), 'client respects props.wide')
  console.log('ok  client artifact shape (id, slots, wide)')

  // 9) effect cleanup flushes store
  assert.strictEqual(typeof firstDisposer, 'function', 'ctx.effect must return a disposer')
  firstDisposer()
  assert.strictEqual(disposerCalled, true, 'ctx.effect disposer must be callable')
  assert.strictEqual(fs.existsSync(storePath), true, 'disposer flush persisted the store file')
  console.log('ok  effect disposer wired (flush on unload)')

  // 10) cascade with a real local OpenAI-compatible stub server
  {
    const http = require('node:http')
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        assert.ok(Array.isArray(parsed.messages) && parsed.messages[0].role === 'user', 'openai payload shape')
        const out = JSON.stringify({ model: 'stub-draft', choices: [{ message: { role: 'assistant', content: 'DRAFT-OK triage result' } }] })
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) })
        res.end(out)
      })
    })
    await new Promise((res) => server.listen(0, '127.0.0.1', res))
    const port = server.address().port
    const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'inferkit4-'))
    delete require.cache[require.resolve(path.join(dir, 'index.js'))]
    const mod4 = require(path.join(dir, 'index.js'))
    const reg4 = { tools: [] }
    mod4.apply({
      effect: () => () => {},
      inject: (s, cb) => cb({ tools: { register: (t) => reg4reg(t) }, webServer: { register: () => {} } }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }, { storePath: path.join(dir4, 'store.json'), draftEndpoint: 'http://127.0.0.1:' + port + '/v1/chat/completions', draftModel: 'stub-model' })
    function reg4reg (t) { reg4.tools.push(t) }
    const cascade4 = reg4.tools.find((t) => t.name === 'infer_draft_cascade')
    const rr = await cascade4.execute({ task: 'triage a list of 10 items' })
    assert.strictEqual(rr.used, true, 'draft should be used with stub server')
    assert.ok(rr.draft.includes('DRAFT-OK'), 'draft content returned')
    await new Promise((res) => server.close(res))
  }
  console.log('ok  cascade with OpenAI-compatible stub server (used:true)')

  console.log('\nALL STUB TESTS PASSED')
}

main().catch((err) => {
  console.error('STUB TEST FAILED:', err && err.stack ? err.stack : err)
  process.exit(1)
})
