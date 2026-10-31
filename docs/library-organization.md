# Library organization

Approved scope: video tags and a cross-video saved-notes page.

- Add/create/remove tags from a shelf row or reader. Batch tag selected videos; rename a tag or merge it into an existing tag.
- Normalize whitespace and case duplicates; allow 12 tags per video. Batch changes validate ownership and capacity before a single atomic conditional update. Concurrent tag changes return a conflict without partially applying the batch.
- Shelf search and saved notes follow the selected tag, untagged scope and learning status. Scope is stored in the URL.
- All notes lists saved personal notes, including explicitly saved AI-derived notes. Drafts, highlights and unsaved AI answers are excluded. Each entry retains the original quote, source video, timestamp and note link.
- Saved notes use bounded keyset pagination, newest edited first. No schema migration or external service is required.

Entry points:

- `/library`: row tag buttons, Select videos → Edit tags, and the settings icon beside Tags for rename/merge.
- `/library/notes`: keyword, quoted passage, tag and learning-status filters; source buttons reopen the saved note and its passage.
- Reader: Add tag / Edit tags below the player. A source link starts the embedded video at the original timestamp; saved notes on another caption track switch to the retained source snapshot. Notes without captions still open in the learning panel.

Validation (2026-10-31):

- `npm run typecheck`, all 46 tests, and `npm run build` pass.
- Tests cover normalization, unrelated-tag preservation, rename/merge, ownership, capacity rejection, concurrent-edit atomicity, escaped search, scoped results, saved-note-only listing, AI note provenance, deletion, and deterministic 40-note pagination.
- Local Cloudflare runtime + Chromium flows pass: create/remove/deduplicate tags, batch tagging, rename/merge, refreshed filters, scoped keyword search, note quote/source navigation, notes on a video without captions, initial video timestamp, reader tag modal, empty/untagged views, and failed notes request → Retry recovery.
- The existing 10 reader-layout scenarios pass, including drag/keyboard resizing, collapsed notes, preserved reading position, refresh preferences, draft recovery, desktop widths and reset.
- Temporary notes, drafts, tags and the second video were removed after browser checks; pre-existing tags were restored.
- Screenshots: `margin-library-tags.png`, `margin-all-notes.png`.

This implementation is available at `http://127.0.0.1:5178`. Production deployment remains separate.
