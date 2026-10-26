# dsh-infer-kit

**Inference toolkit for DeepSeek Harness — semantic cache, draft cascade, and JSON validation.**

Three model-agnostic tools (work with any provider DSH routes to):

| Tool | What it does |
|---|---|
| `infer_cache_lookup` | Semantic cache for answers and tool results. Jaccard similarity ≥ 0.62 triggers a hit. Retention: agent = 3 days, chatbot = 7 days. |
| `infer_draft_cascade` | Cheap-draft → expensive-verify cascade (client-side analog of speculative decoding). Any OpenAI-compatible endpoint works. |
| `infer_json_validate` | Validate JSON against JSON Schema before presenting structured output. Supports type, properties, required, additionalProperties, items, enum, min/max, minLength/maxLength. |

Built on ideas from [DeepInfer](https://github.com/deepseek-ai/deepseek-infer) (DeepSeek's open-source inference engine, Apache 2.0, October 2026).

## Install

```sh
dsh plugin --profile web add dsh-infer-kit
```

Then restart `dsh web` (or the desktop app). The plugin activates on next start.

For manual / source install:
```sh
dsh plugin --profile web add github:YOUR_USERNAME/dsh-infer-kit
```

## Quick start

After installing and restarting, three tools become available to any model:

### Semantic cache

```json
{
  "mode": "lookup",
  "key_text": "What is the capital of France?",
  "kind": "chatbot"
}
```
```json
{
  "mode": "store",
  "key_text": "What is the capital of France?",
  "value": "Paris is the capital of France.",
  "kind": "chatbot",
  "tags": ["geography", "quick-facts"]
}
```

### Draft cascade

```json
{
  "task": "List all files in the project root",
  "context": "TypeScript monorepo with packages/api, packages/web, packages/shared",
  "accept": true
}
```
Returns a draft (typically 100–600 tokens) from the configured cheap model; you verify and finalize. If the draft endpoint is unavailable, falls back to full-quality self-completion — no errors raised.

Configure the draft endpoint in your profile's `cordis.patch.yml`:

```yaml
config:
  draftEndpoint: 'https://inference.dahl.global/v1/chat/completions'
  draftModel: 'deepseek-ai/DeepSeek-V4-Flash-0731'
  draftTimeoutMs: 90000
```

The API key is read from the `DAHO_API_KEY` credential (set it in **Settings → Models** like any other provider key). It resolves fresh on every draft call — rotating keys are picked up automatically.

### JSON validation

```json
{
  "json": "{\"id\": 42, \"name\": \"Alice\"}",
  "schema": {
    "type": "object",
    "required": ["id", "name"],
    "properties": {
      "id": { "type": "integer" },
      "name": { "type": "string", "minLength": 1 }
    }
  }
}
```

Returns `ok: true` or a list of concrete errors to fix before presenting the output.

## Configuration

All config lives in `cordis.patch.yml` under `config:`:

| Key | Default | Description |
|---|---|---|
| `storePath` | `store.json` next to index.js | Path to the persistent cache file |
| `maxEntries` | `512` | Max cache entries; oldest are evicted on overflow |
| `similarityThreshold` | `0.62` | Jaccard threshold for cache hits (0–1) |
| `ttlAgentDays` | `3` | TTL for kind=agent entries (days) |
| `ttlChatDays` | `7` | TTL for kind=chatbot entries (days) |
| `draftEndpoint` | `null` | OpenAI-compatible draft endpoint URL |
| `draftModel` | `null` | Model name passed to draft endpoint |
| `draftMaxTokens` | `600` | `max_tokens` for draft calls |
| `draftTimeoutMs` | `25000` | Timeout per draft call (ms) |

## Architecture

```
DSH process (host half)              Web GUI (client half)
─────────────────────────            ─────────────────────
index.js                             client.js
├── inject: ['credentials']          ├── inject: ['slots']
├── inject: ['tools']                └── registers ⚡ InferKit
├── inject: ['webServer']                button in sidebar footer
│   └── GET /infer-kit/status
└── ctx.effect() cleanup
```

- **Host half** (`index.js`): Node.js built-ins only (`node:fs`, `node:path`, `node:crypto`, `fetch`). No `@deepseek-ai/*` imports — verified contract.
- **Client half** (`client.js`): React status button, no build step required.
- The store is shared between web and desktop profiles (same `storePath`).

## Live test results

Draft cascade tested against `inference.dahl.global` with `deepseek-ai/DeepSeek-V4-Flash-0731`:

| Run | Draft length | Latency | Notes |
|---|---|---|---|
| 1 | 94 tokens | 2139 ms | First call |
| 2 | 157 tokens | 4627 ms | Survived a 429 retry |
| 3 | 146 tokens | 1369 ms | With credentials resolver |

## Requirements

- DSH `>= 0.2.0-rc.2`
- Node.js built-in `fetch` (available in DSH's Node runtime)
- No external runtime dependencies

## Permissions

- Reads/writes a JSON store file (path configurable, default next to the plugin)
- Makes HTTP calls to the configured draft endpoint only
- No telemetry, no external services beyond the optional draft endpoint

## License

MIT
