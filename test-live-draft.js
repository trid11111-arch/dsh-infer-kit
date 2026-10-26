'use strict'
/**
 * LIVE test of the draft cascade against the real daho provider
 * (https://inference.dahl.global/v1) — not a stub. Requires DAHO_API_KEY
 * in env. Run:  node test-live-draft.js     (exit 0 = all pass)
 * Sends ONE tiny chat completion via the plugin's own buildDraftCaller path.
 */
const assert = require('node:assert')
const path = require('node:path')

const dir = __dirname
const key = process.env.DAHO_API_KEY
if (!key) {
  console.error('SKIP: DAHO_API_KEY not set')
  process.exit(0)
}

async function main () {
  // load plugin host half
  const plugin = require(path.join(dir, 'index.js'))
  const tools = []
  plugin.apply({
    effect: () => () => {},
    inject: (s, cb) => cb({ tools: { register: (t) => tools.push(t) }, webServer: { register: () => {} } }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }, {
    storePath: path.join(require('node:os').tmpdir(), 'inferkit-live-store.json'),
    draftEndpoint: 'https://inference.dahl.global/v1/chat/completions',
    draftModel: 'deepseek-ai/DeepSeek-V4-Flash-0731',
  })

  const cascade = tools.find((t) => t.name === 'infer_draft_cascade')
  assert.ok(cascade, 'cascade tool registered')

  const started = Date.now()
  const r = await cascade.execute({
    task: 'Перечисли три причины, почему стоит использовать кэш в LLM-агентах. Ответ максимум 30 слов.',
  })
  const ms = Date.now() - started
  console.log('cascade result:', JSON.stringify({ used: r.used, draftLen: r.draft ? r.draft.length : 0, ms, message: r.message && r.message.slice(0, 400) }, null, 2))
  console.log('draft text:', (r.draft || '').slice(0, 300))

  assert.strictEqual(r.ok, true, 'cascade returned ok')
  assert.strictEqual(r.used, true, 'draft should be used against live endpoint')
  assert.ok(r.draft && r.draft.trim().length > 0, 'draft has content')
  assert.ok(r.ms >= 0, 'ms reported')
  console.log('\nLIVE DRAFT TEST PASSED (' + ms + 'ms)')
}

main().catch((err) => { console.error('LIVE DRAFT TEST FAILED:', err); process.exit(1) })
