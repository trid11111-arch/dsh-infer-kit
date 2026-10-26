'use strict'
/**
 * dsh-infer-kit — host half.
 *
 * Three universal model-facing tools, model-agnostic (works with any provider
 * DSH routes to, because everything happens client-side in the DSH process):
 *
 *   1. infer_cache_lookup  — semantic cache of final answers/results.
 *      Idea from DeepInfer's KV-store: "hot prefixes are read many times";
 *      retention policies agent=3d / chatbot=7d adapted as ttlDays.
 *   2. infer_draft_cascade — cheap-draft -> expensive-verify cascade
 *      (client-side analog of DeepInfer's DSpark confidence-scheduled
 *      speculative decoding: don't spend expensive tokens on work a cheap
 *      model does for pennies).
 *   3. infer_json_validate — validate-and-retry against JSON Schema
 *      (client-side analog of structured output / constrained decoding).
 *
 * No imports from @deepseek-ai/* — only node: builtins (verified contract).
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const PLUGIN_NAME = 'dsh-infer-kit'

// ---------- tiny utils ----------

function nowMs () { return Date.now() }

function normText (s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
}

function tokenize (s) {
  return normText(s).split(' ').filter((w) => w.length > 2)
}

function jaccard (a, b) {
  const A = new Set(a); const B = new Set(b)
  if (A.size === 0 && B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

function hashKey (text) {
  return crypto.createHash('sha256').update(normText(text)).digest('hex').slice(0, 16)
}

function utf8Len (s) { return Buffer.byteLength(String(s || ''), 'utf8') }

// ---------- store (persistence) ----------

function loadStore (storePath) {
  try {
    const raw = fs.readFileSync(storePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) return parsed
  } catch (_) { /* first run or corrupted -> fresh */ }
  return { version: 1, entries: [] }
}

function saveStoreAtomic (storePath, store) {
  const tmp = storePath + '.tmp'
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(store), 'utf8')
  fs.renameSync(tmp, storePath)
}

function pruneStore (store, cfg, now) {
  const ttlAgent = (cfg.ttlAgentDays || 3) * 24 * 3600 * 1000
  const ttlChat = (cfg.ttlChatDays || 7) * 24 * 3600 * 1000
  let removed = 0
  // ttl per kind
  store.entries = store.entries.filter((e) => {
    const ttl = e.kind === 'agent' ? ttlAgent : ttlChat
    if (now - e.created > ttl) { removed++; return false }
    return true
  })
  // capacity cap: drop oldest
  if (store.entries.length > cfg.maxEntries) {
    store.entries.sort((a, b) => a.created - b.created)
    const excess = store.entries.length - cfg.maxEntries
    removed += excess
    store.entries = store.entries.slice(excess)
  }
  return removed
}

// ---------- draft providers (per config, none bundled by default) ----------

function buildDraftCaller (config) {
  const url = config && config.draftEndpoint
  if (!url || !/^https?:/i.test(url)) return null
  // OpenAI chat-completions compatible call: works with OpenRouter workers,
  // LM Studio, ollama /v1, any provider exposing /chat/completions.
  // Fallback parse also accepts {reply|content|text} simple JSON.
  return async function draft (prompt, timeoutMs) {
    const effectiveTimeout = timeoutMs || config.draftTimeoutMs || 25000
    const maxRetries = 3
    let lastErr = null
    const apiKey = typeof config.draftApiKeyResolver === 'function'
      ? await config.draftApiKeyResolver()
      : (config.draftApiKey || '')
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), effectiveTimeout)
      try {
        const headers = { 'content-type': 'application/json' }
        if (apiKey) headers.authorization = 'Bearer ' + apiKey
        const res = await fetch(url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({
            model: config.draftModel || undefined,
            max_tokens: config.draftMaxTokens || 600,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: controller.signal,
        })
        if (res.status === 429 || res.status >= 500) {
          // rate limited / transient overload — retry with backoff.
          // 429 (model_concurrency) часто держится дольше — пробуем дольше.
          const body = await res.text().catch(() => '')
          lastErr = 'draft endpoint HTTP ' + res.status + (body ? ' ' + body.slice(0, 120) : '')
          const retries429 = 5
          if (res.status === 429 && attempt < retries429) {
            clearTimeout(t)
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
            continue
          }
          if (attempt < maxRetries) {
            clearTimeout(t)
            await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)))
            continue
          }
          return { ok: false, error: lastErr }
        }
        if (!res.ok) return { ok: false, error: 'draft endpoint HTTP ' + res.status }
        const data = await res.json()
        const msg = data && data.choices && data.choices[0] && data.choices[0].message
        // reasoning-модели (deepseek/glm) могут отдать ответ в .reasoning либо
        // .reasoning_content, а .content оставить пустым — берём content, затем reasoning.
        const text = (msg && (msg.content || msg.reasoning || msg.reasoning_content)) ||
          (data && (data.reply || data.content || data.text)) || ''
        if (!String(text).trim()) return { ok: false, error: 'draft endpoint returned empty content' }
        return { ok: true, text: String(text), model: (data && data.model) || config.draftModel || 'draft' }
      } catch (err) {
        lastErr = 'draft endpoint failed: ' + (err && err.message ? err.message : String(err))
        if (attempt < maxRetries) {
          clearTimeout(t)
          await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)))
          continue
        }
        return { ok: false, error: lastErr }
      } finally {
        clearTimeout(t)
      }
    }
    return { ok: false, error: lastErr || 'draft endpoint failed' }
  }
}

// ---------- tool: cache ----------

function makeCacheTool (cfg, state) {
  return {
    name: 'infer_cache_lookup',
    description: [
      'Semantic cache lookup/store for answers and tool results. BEFORE doing expensive or repeated work (long analysis, fetching the same page, computing something heavy), call this with mode=lookup and the task text. If a hit is returned, reuse it instead of redoing the work. AFTER finishing an expensive task worth reuse, call with mode=store and kind=agent (repeatable within days) or kind=chatbot (long-lived, read many times).',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['lookup', 'store'] },
        key_text: { type: 'string', description: 'The task/question/result identity text' },
        value: { type: 'string', description: 'mode=store only: the reusable result' },
        kind: { type: 'string', enum: ['agent', 'chatbot'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['mode', 'key_text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          hit: { type: 'boolean' },
          message: { type: 'string' },
          value: { type: ['string', 'null'] },
          similarity: { type: 'number' },
          cachedAt: { type: ['string', 'null'] },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute (args) {
      const now = nowMs()
      const kTokens = tokenize(args.key_text)
      const kHash = hashKey(args.key_text)
      if (args.mode === 'store') {
        if (!args.value || !String(args.value).trim()) {
          return { ok: false, hit: false, value: null, similarity: 0, cachedAt: null, message: 'store rejected: value is empty' }
        }
        // prune AFTER mutation so the cap/ ttl holds even before the debounced flush
        const entry = {
          hash: kHash,
          tokens: kTokens.slice(0, 64),
          value: String(args.value),
          kind: args.kind === 'agent' ? 'agent' : 'chatbot',
          tags: Array.isArray(args.tags) ? args.tags.slice(0, 8) : [],
          created: now,
          hits: 0,
        }
        const idx = state.store.entries.findIndex((e) => e.hash === kHash)
        if (idx >= 0) state.store.entries.splice(idx, 1)
        state.store.entries.push(entry)
        pruneStore(state.store, cfg, now)
        state.dirty = true
        flushSoon(cfg, state)
        return { ok: true, hit: false, value: null, similarity: 1, cachedAt: null, message: 'stored: "' + normText(args.key_text).slice(0, 80) + '" kind=' + entry.kind + ' entries=' + state.store.entries.length }
      }
      // lookup — expired entries are never served (ttl enforced at read time)
      const ttlAgent = (cfg.ttlAgentDays || 3) * 24 * 3600 * 1000
      const ttlChat = (cfg.ttlChatDays || 7) * 24 * 3600 * 1000
      let expiredSeen = false
      let best = null; let bestSim = 0
      for (const e of state.store.entries) {
        const ttl = e.kind === 'agent' ? ttlAgent : ttlChat
        if (now - e.created > ttl) { expiredSeen = true; continue }
        const sim = jaccard(kTokens, e.tokens)
        if (sim > bestSim) { bestSim = sim; best = e }
      }
      if (expiredSeen) { pruneStore(state.store, cfg, now); state.dirty = true; flushSoon(cfg, state) }
      const threshold = typeof cfg.similarityThreshold === 'number' ? cfg.similarityThreshold : 0.62
      if (best && bestSim >= threshold) {
        best.hits++
        state.hits++
        state.dirty = true
        flushSoon(cfg, state)
        return {
          ok: true,
          hit: true,
          value: best.value,
          similarity: Number(bestSim.toFixed(3)),
          cachedAt: new Date(best.created).toISOString(),
          message: 'CACHE HIT (' + Number(bestSim.toFixed(2)) + '): return value below was stored ' + new Date(best.created).toISOString() + '; reuse it instead of redoing the work unless the user says things changed.\nVALUE:\n' + best.value,
        }
      }
      state.misses++
      state.dirty = true
      return { ok: true, hit: false, value: null, similarity: Number(bestSim.toFixed(3)), cachedAt: null, message: 'miss (' + Number(bestSim.toFixed(2)) + ' vs threshold ' + threshold + '). Do the work, then store the result if reusable.' }
    },
  }
}

// flushSoon — debounced write (max once per 3s) so many store calls per turn
// don't hammer the disk; flush() inside apply() covers the tail.
let flushTimer = null
function flushSoon (cfg, state) {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      const now = nowMs()
      if (pruneStore(state.store, cfg, now) > 0) { /* compacted */ }
      saveStoreAtomic(cfg.storePath, state.store)
      state.dirty = false
    } catch (_) { /* retried on next flush */ }
  }, 3000)
  if (typeof flushTimer.unref === 'function') flushTimer.unref()
}

function flush (cfg, state) {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  if (!state.dirty) return
  try {
    saveStoreAtomic(cfg.storePath, state.store)
    state.dirty = false
  } catch (_) { /* non-fatal on shutdown */ }
}

// ---------- tool: draft cascade ----------

function makeCascadeTool (cfg, state, draft) {
  return {
    name: 'infer_draft_cascade',
    description: [
      'Cheap-draft -> expensive-verify cascade (client-side analog of speculative decoding with confidence scheduling). For a task the MAIN model finds tedious/repetitive (triage, long routine listing, first-pass extraction), fetch a DRAFT from a cheap model and use it as raw material; you verify and finalize. This saves expensive tokens. If the draft fails or is disabled, that is fine — do the work yourself and mention it.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: 'What the cheap model should draft' },
        context: { type: 'string', description: 'Optional material for the draft' },
        kind: { type: 'string', enum: ['agent', 'chatbot'] },
        accept: { type: 'boolean', description: 'Also cache the draft if good' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          used: { type: 'boolean' },
          message: { type: 'string' },
          draft: { type: ['string', 'null'] },
          ms: { type: 'integer' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute (args) {
      const started = nowMs()
      if (!draft) {
        state.cascadeFallbacks++
        return { ok: true, used: false, draft: null, ms: 0, message: 'DRAFT UNAVAILABLE (no draft endpoint configured). Do the task yourself at full quality.' }
      }
      const prompt = args.task + (args.context ? '\n\nMATERIAL:\n' + args.context : '')
      const r = await draft(prompt, cfg.draftTimeoutMs || 25000)
      const ms = nowMs() - started
      if (!r || !r.ok) {
        state.cascadeFallbacks++
        return { ok: true, used: false, draft: null, ms: ms, message: 'DRAFT FAILED (' + (r && r.error ? r.error : 'unknown') + ') after ' + ms + 'ms. Do the task yourself at full quality.' }
      }
      state.cascadeUses++
      const tail = args.accept ? ' If the draft is usable, store the final result via infer_cache_lookup mode=store.' : ''
      return { ok: true, used: true, draft: r.text, ms: ms, message: 'DRAFT READY in ' + ms + 'ms from ' + r.model + '. Verify, correct, finalize at full quality.\nDRAFT:\n' + r.text }
    },
  }
}

// ---------- tool: json validate ----------

function validateAgainstSchema (value, schema, out) {
  // returns array of error strings (empty = valid). Supports the subset of
  // JSON Schema the validator advertises: type, properties, required,
  // additionalProperties, items, enum, min/max constraints.
  out = out || []
  const types = Array.isArray(schema.type) ? schema.type : [schema.type].filter(Boolean)
  function typeOk (v, t) {
    switch (t) {
      case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v)
      case 'array': return Array.isArray(v)
      case 'string': return typeof v === 'string'
      case 'number': return typeof v === 'number' && Number.isFinite(v)
      case 'integer': return typeof v === 'number' && Number.isInteger(v)
      case 'boolean': return typeof v === 'boolean'
      case 'null': return v === null
      default: return true
    }
  }
  if (types.length > 0) {
    const ok = types.some((t) => typeOk(value, t))
    if (!ok) {
      out.push('expected type ' + types.join('|') + ', got ' + (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value))
      return out
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    out.push('value not in enum: ' + JSON.stringify(schema.enum).slice(0, 120))
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) out.push('below minimum ' + schema.minimum)
    if (typeof schema.maximum === 'number' && value > schema.maximum) out.push('above maximum ' + schema.maximum)
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) out.push('shorter than minLength ' + schema.minLength)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) out.push('longer than maxLength ' + schema.maxLength)
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      const sub = []
      validateAgainstSchema(item, schema.items, out)
      if (out.length === 0) return
      // keep at most the first error per item, prefixed
      const last = out[out.length - 1]
      out[out.length - 1] = 'items[' + i + ']: ' + sublabel(sub)
      function sublabel () { return '' }
      out[out.length - 1] = 'items[' + i + ']: ' + (last.startsWith('items[') ? last : last)
    })
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties || {}
    if (schema.required) {
      for (const r of schema.required) {
        if (!(r in value)) out.push('missing required property "' + r + '"')
      }
    }
    if (schema.additionalProperties === false && props) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) out.push('unexpected property "' + k + '"')
      }
    }
    for (const k of Object.keys(props || {})) {
      if (k in value) validateAgainstSchema(value[k], props[k], out)
    }
  }
  return out
}

// tiny helper used above to trim nested prefixes (kept trivial on purpose)
function sub () { return '' }

function makeValidateTool () {
  return {
    name: 'infer_json_validate',
    description: [
      'Validate a JSON string against a JSON Schema (subset: type/properties/required/additionalProperties/items/enum/min/max/length). Use BEFORE presenting structured output the user or another tool expects in a schema. Returns ok:true or a list of concrete errors; on failure, fix the JSON and validate again instead of shipping it broken.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        json: { type: 'string', description: 'The JSON text to validate' },
        schema: { type: 'object', description: 'JSON Schema to validate against' },
      },
      required: ['json', 'schema'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          errors: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute (args) {
      let value
      try {
        value = JSON.parse(args.json)
      } catch (e) {
        return { ok: false, errors: ['JSON.parse: ' + (e && e.message ? e.message : String(e))], message: 'INVALID JSON: not parseable. Fix the syntax.' }
      }
      const errors = validateAgainstSchema(value, args.schema || {}, [])
      if (errors.length === 0) return { ok: true, errors: [], message: 'VALID: JSON matches the schema.' }
      return { ok: false, errors: errors.slice(0, 20), message: 'INVALID (' + errors.length + '):\n- ' + errors.slice(0, 20).join('\n- ') }
    },
  }
}

// ---------- apply ----------

exports.name = PLUGIN_NAME
exports.inject = ['credentials']
exports.apply = function apply (ctx, config) {
  // Resolve DAHO_API_KEY at call time (not startup), so GUI-entered / rotated
  // keys are picked up without restarting the plugin.
  async function resolveDraftKey () {
    try {
      if (ctx && ctx.credentials && typeof ctx.credentials.resolve === 'function') {
        const hit = await ctx.credentials.resolve('DAHO_API_KEY')
        if (hit && hit.value && typeof hit.value === 'string') return hit.value
      }
    } catch (_) { /* fall through to env */ }
    return process.env.DAHO_API_KEY || process.env.INFER_KIT_DRAFT_API_KEY || (config && config.draftApiKey) || ''
  }

  const cfg = {
    storePath: (config && config.storePath) || path.join(__dirname, 'store.json'),
    maxEntries: (config && config.maxEntries) || 512,
    similarityThreshold: typeof (config && config.similarityThreshold) === 'number' ? config.similarityThreshold : 0.62,
    ttlAgentDays: (config && config.ttlAgentDays) != null ? config.ttlAgentDays : 3,
    ttlChatDays: (config && config.ttlChatDays) != null ? config.ttlChatDays : 7,
    draftEndpoint: (config && config.draftEndpoint) || null,
    draftModel: (config && config.draftModel) || null,
    draftApiKey: '', // resolved fresh per-call via resolveDraftKey()
    draftApiKeyResolver: resolveDraftKey,
    draftMaxTokens: (config && config.draftMaxTokens) || 600,
    draftTimeoutMs: (config && config.draftTimeoutMs) || 25000,
  }

  const state = { store: loadStore(cfg.storePath), dirty: false, hits: 0, misses: 0, cascadeUses: 0, cascadeFallbacks: 0, startedAt: nowMs() }

  // cleanup FIRST so it exists even if the rest falls (checklist rule)
  ctx.effect(() => () => {
    flush(cfg, state)
  })

  const draft = buildDraftCaller(cfg)

  ctx.inject(['tools'], (c) => {
    c.tools.register(makeCacheTool(cfg, state))
    c.tools.register(makeCascadeTool(cfg, state, draft))
    c.tools.register(makeValidateTool())
  })

  ctx.inject(['webServer'], (c) => {
    c.webServer.register({
      kind: 'exact',
      path: '/infer-kit/status',
      handler: (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        const body = Buffer.from(JSON.stringify({
          ok: true,
          plugin: PLUGIN_NAME,
          entries: state.store.entries.length,
          hits: state.hits,
          misses: state.misses,
          cascadeUses: state.cascadeUses,
          cascadeFallbacks: state.cascadeFallbacks,
          draftConfigured: !!cfg.draftEndpoint,
          storePath: cfg.storePath,
        }), 'utf8')
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(body.length),
          'cache-control': 'no-store',
        })
        res.end(body)
      },
    })
  })
}
