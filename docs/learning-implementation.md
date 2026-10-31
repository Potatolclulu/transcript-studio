# Learning library implementation

Approved scope: `../../youtube-learning-mvp-20261031/index.html`.

1. Add private, persistent library, caption tracks, anchored notes, conversations and independent AI budget tables. Existing billed transcription jobs remain separate.
2. Add authenticated, bounded YouTube caption acquisition service, using public metadata and platform captions only. Persist links before importing; deduplicate per user; retain failed imports for retry. Never start ASR implicitly.
3. Build English library and learning reader: embedded source video, timed transcript, selection actions, editable notes, tags, reading/playback positions and personal search.
4. Build queued server-only OpenAI-compatible adapter with explicit model/endpoint/key and cost guards. Save requests before processing, validate quote anchors and citations, preserve failed/cancelled questions, and show unavailable state until configured.
5. Verify privacy, no caption minute charges, deduplication, persistence, search and error paths in tests; verify actual English captions, browser interactions and D1/R2 persistence locally. Do not deploy or charge users.

The Python service requires a separate host in production. Local validation does not establish production YouTube availability. No production LLM calls are authorized by this implementation.
