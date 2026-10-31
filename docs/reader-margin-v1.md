# PC reader margin — first version

Approved direction: keep the transcript stable, preview saved notes on hover, and open one note or AI conversation in the right margin. Mobile interaction design is deferred.

- On desktop, place video on the left, transcript in the middle and notes on the right. The latest approved revision replaces the reserved empty margin with a collapsible notes rail and adjustable columns.
- Each passage shows a note count and a separate conversation count. Multiple notes retain their exact text selections, dates and IDs. Notes spanning passages appear in the group at their first cue.
- Hovering a saved selection or count for 350 ms previews up to three note excerpts. Clicking opens the corresponding passage group. Editing and writing happen only in the right margin.
- Closing or pressing Escape hides the panel. Note drafts persist in the account separately from saved notes; a saved note count excludes drafts.
- AI answers stay in conversation history until the user chooses “Save as note”, edits a draft, and explicitly saves. The saved note retains its question ID and can reopen the source conversation.
- Opening a note or conversation pauses transcript follow. “Back to playback” resumes following without discarding an open draft.
- For ordinary transcripts, AI receives the complete available caption track in a stable prompt prefix, followed by the selected quote, nearby captions and the current conversation. Larger tracks use relevant passages and disclose reduced coverage. Input is bounded by a conservative 50,000 UTF-8-byte budget, which is an upper bound rather than an exact token count. No speculative AI call runs when opening a video.
- Store the provider’s reported cache hit/miss counts and actual prompt token count. Do not assume that a cache hit will occur.

Validation covers preservation of the reading position while columns change width, hover-to-preview, multiple independent notes, draft recovery, explicit AI-to-note conversion, ownership of source questions/drafts, stable prompt prefixes, multilingual context selection, valid citations and existing accounting checks.

Initial margin validation: 41 tests, TypeScript and production build passed. Browser checks at 1280, 1440 and 1728 px verified the original fixed geometry, separate notes at one selection, editing, hover previews, recovery of account drafts, explicit AI conversion and reopening the source conversation. A real DeepSeek request used the complete TED transcript (9,720 provider-reported input tokens, zero cache hits on that first request) and returned valid citations. Closing while it ran did not reopen the panel. Existing user notes were retained and temporary verification notes were removed. The D1 migration was applied locally; production deployment is not part of this version.

## Adjustable PC layout

- Notes start collapsed as a 36 px rail. The top “Learning records” button toggles the panel; the rail button, note markers and selection actions open it. Closing preserves account drafts and lets the player and transcript use the released space.
- The default video/transcript split is 50/50 after accounting for dividers and notes. Open notes start at 320 px. Pointer dragging adjusts either divider; the second divider holds the video width until minimum reading width requires a clamp.
- Both dividers support arrow keys (16 px), Shift + arrow keys (50 px), Home/End limits and double-click to reset. Pointer capture and temporarily disabled iframe pointer events keep dragging reliable over the player.
- `margin.reader-layout.v1` in browser localStorage stores only video ratio and notes width. Closing/reopening restores them; a new visit starts with notes collapsed. Account notes, drafts and AI history continue to use their existing server storage.
- ResizeObserver clamps columns to the available desktop width. Width changes retain the first visible transcript passage and its vertical offset. Native paragraph selections that end at a cue boundary are supported; newline-only selections are ignored.

Revision validation: TypeScript and production build passed. Ten browser scenarios verified the larger default player, both pointer dividers, keyboard adjustment, collapse/reopen, reading-position preservation, preference recovery after reload, account draft recovery, desktop sizing and reset. Both open and closed layouts fit 761, 900, 1024, 1280, 1440, 1728 and 2048 px without horizontal overflow. Temporary draft was discarded. No additional AI request was made.

Preview images: `margin-resizable-closed.png` and `margin-resizable-open.png`.
