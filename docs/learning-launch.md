# Margin learning library

The English P0 learning experience replaces the transcription-first home page. “Margin” is a working name, not a purchased domain or a finalized brand. Legacy transcription routes remain at `/app`.

Local evidence and practical limits: [validation record](learning-validation.md).

## Run locally

Use the existing `npm start` action. It builds the client, applies **local-only** D1 migrations, starts Wrangler at `http://127.0.0.1:5178`, starts the private caption helper at port 8791, and opens the website. The development-only “Open local preview” account retains its library between visits; it does not receive billable minutes.

Requirements: installed project dependencies, Python 3, Node.js and yt-dlp with a supported JavaScript runtime. The launcher prefers the existing qiaomu-clipper yt-dlp if installed, otherwise uses `yt-dlp` from PATH; `YT_DLP` can override this. Separate local helper credentials are generated in ignored `.dev.vars`, never in client files.

## Implemented flow

- Single public recorded YouTube videos, up to four hours. No playlist imports or automatic ASR.
- Per-user collection deduplication, background caption import, manual and automatic source labels, explicit translated track labels, partial/no-caption/error states and retries.
- Source player, timed reader, follow playback, timestamp jumps, separate reading and playback positions.
- Precise text-span highlights, anchored or whole-video notes, revision checks on edits, navigation warning for unsaved notes, independent cloud records with no 30-day job expiry.
- Topic labels, manual completion, personal search across titles/tags, available transcript, user notes and saved questions.
- Selecting text opens nearby actions: Highlight, Add annotation and Ask AI. Anchored notes are edited and displayed beside the original passage. Clicking saved highlights reopens the actions. Video-level notes remain available in Learning records.
- AI conversations open at their original passage. Queued questions, conversation history, relevant source snippets, validated source IDs, distinct video explanation and general supplement, stop and explicit retry. No fabricated answers if the model is absent.

## Production caption service

`probe/captions.py` must run on a separate HTTPS host/container with Python, Node.js and yt-dlp. Cloudflare Workers cannot execute yt-dlp themselves. Configure `CAPTION_SERVICE_URL` with the complete `/extract` endpoint and set `CAPTION_SERVICE_SECRET` as a Worker secret and service environment secret.

The helper allows only a canonical YouTube ID, keeps two extraction slots, bounds downloads and execution time, ignores host yt-dlp config, requires authorization and does not download audio or use user cookies. The Worker refuses redirects. Successful local imports do not establish availability from the production host; test real user videos there before inviting external users.

Runtime detail verified against Cloudflare's [Request documentation](https://developers.cloudflare.com/workers/runtime-apis/request/): Workers accepts `redirect: 'manual'` or `'follow'`; `'error'` throws before a request is sent. This implementation uses `manual` and rejects redirect responses.

D1 migration `0002_learning.sql` adds independent learning objects. Caption JSON is stored privately in R2. Each caption track retains its first saved snapshot so existing anchors cannot be silently rewritten. No automatic retention expiry is applied during this prototype; formal capacity, backup and retention policy remain to be decided.

## Model configuration

DeepSeek is configured for the current local preview using the user's supplied key in ignored, permission-restricted `.dev.vars`. Model: `deepseek-flash`; endpoint: `https://api.deepseek.com/chat/completions`. Keys never enter the browser bundle. Production configuration remains separate.

Local budget guards: USD 0.50 per day across the site, USD 0.20 per account, conservative USD 0.05 reserved per request. This corresponds to at most 10/4 requests respectively under these guards; it does not mean every request costs five cents. Request reservations remain counted after failures that may be billable.

For another environment use server-only settings, keeping budgets at zero until pricing and authorization are confirmed:

```dotenv
LLM_API_URL=https://YOUR_APPROVED_ENDPOINT/chat/completions
LLM_MODEL=YOUR_APPROVED_MODEL
LLM_API_KEY=SERVER_SECRET
LLM_DAILY_BUDGET_CENTS=0
LLM_USER_DAILY_BUDGET_CENTS=0
LLM_REQUEST_BUDGET_CENTS=0
```

The adapter expects an OpenAI-compatible chat endpoint with JSON response support. A question is saved before sending. Only selected text, up to 16,000 characters of retrieved captions and up to four short turns from that video conversation are sent. Limit: 2,200 output tokens. No tool execution. For the official DeepSeek endpoint, thinking is disabled for short explanations; answers follow the question's language.

Both daily limits and a positive conservative per-request USD-cent estimate must be configured to enable requests. This estimate is an operational guard, not an invoice reconciler or user payment plan. Reservations remain counted after upstream timeouts and cancellation because the supplier may still charge. Official [pricing](https://api-docs.deepseek.com/quick_start/pricing), [JSON output](https://api-docs.deepseek.com/guides/json_mode) and [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode) were checked on 2026-10-31; recheck pricing before changing model or limits.

Structured answers have valid clickable evidence IDs, but this validates references rather than the truth of every claim. Users must still compare AI answers with the original source.

## Before external use

Deployments and payment remain closed; real DeepSeek requests are enabled only in the local preview. Configure production email sign-in, private HTTPS caption hosting and model secrets. Then validate remote D1/R2/Queues, production video extraction and source-player access, and decide retention and pricing. Never deploy the local preview account endpoint as an enabled development environment.
