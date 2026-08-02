# Cloudflare Worker

This is the single production Cloudflare deployment. It uses the DeepL
`oneshot-free` protocol used by current DLX and does not call the legacy
`www2.deepl.com/jsonrpc` endpoint.

## Routes

- `POST /translate` — DeepLX-compatible response.
- `POST /v2/translate` — official API-compatible response.
- `GET /v2/usage` — compatibility usage response.
- `POST /jobs?response_type=deeplx|official` — create a translation job.
- `GET /jobs/{job_id}` — poll a job.

Synchronous requests accept at most 3,000 Unicode characters and wait at most
five seconds. Jobs accept at most 100,000 Unicode characters and 512 KiB and
must finish within 60 seconds. Temporary congestion and upstream failures return
HTTP 503 with `Retry-After`; the Worker never forwards an upstream HTTP 429.

## Production resources

- D1: `deeplx-cache`
- Queue: `deeplx-jobs`
- Dead-letter queue: `deeplx-jobs-dlq`
- SQLite Durable Object: `TranslationCoordinator`

There is no staging environment or staging resource configuration.

Set optional authentication without committing the value:

```sh
pnpm exec wrangler secret put token
```

The token may be supplied as `Bearer`, `DeepL-Auth-Key`, or the `token` query
parameter. Multiple configured tokens are comma-separated.

## Checks and deployment

```sh
pnpm test
pnpm run typecheck
pnpm exec wrangler deploy --dry-run
pnpm run deploy
```

The source text and result segment cache is stored in D1 for 30 days. Do not
enable this deployment for text that must not be stored in plaintext.
