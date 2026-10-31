# Margin UI refinement

Requested scope: install unslop globally and refine the existing home, library, saved notes and three-column reader. User authorization covers implementation.

Unslop by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), [source](https://github.com/heydamir/unslop), CC BY 4.0. Installed unchanged at `/Users/bytedance/.trae-cn/skills/unslop`, commit `4652254daff586ff4739849395a127b56f7f8cc7`; all 13 files matched the staged SHA-256 manifest.

Direction:

- Product: an English learning library for reading YouTube transcripts and saving personal notes.
- Character: calm, attentive, scholarly.
- World: an open book and its margins; neutral paper, readable ink and a restrained green accent.
- Moments: the video and the selected passage; yellow highlights carry meaning while navigation remains quiet.
- Signature: a thin vertical margin rule links a saved thought to its original passage.

Audit:

- Header: 82px tall; controls and reader toolbar use much more vertical space than the task needs.
- Library: 210px sidebar in a 1350px centered shell; 52/55px page padding, loose navigation groups and repeated active backgrounds.
- Text: source and timestamps at 9px, video metadata at 10px, navigation at 12px; many low-contrast olive variations.
- Labels: decorative uppercase kickers and repeated sentences compete with page titles; repeated book icons add little distinction.
- Rows: oversized decorative book tile; tag and metadata alignment varies with selection controls.
- Notes: originals and personal thoughts need clearer type roles and a comfortable line length.
- Reader: useful three-column layout, drag controls and margins already work; retain them and recover vertical space.
- Home: useful split preview and original example text; refine the product-specific headline, remove rotation and italic emphasis, raise preview metadata legibility.

Implementation passes:

1. Use a 4px spacing rhythm, 64px header, compact 36px navigation and 32px page edges.
2. Keep the existing paper/green identity; consolidate primary, secondary and muted text and improve contrast.
3. Keep Lucide at a consistent stroke; remove ornamental icons and use distinct status cues where meaningful.
4. Use sentence-case labels and concise task descriptions; keep all original content and features.
5. Keep system sans for controls and Georgia for editorial headings/transcript. Interface metadata starts at 12px; text roles use a small, consistent scale.
6. Use a fluid desktop library shell, preserve the resizable reader and constrain long note lines instead of shrinking the whole app.
7. Unify controls, focus, active states and source rules; ensure modal/editor readability.
8. Retain the existing code preview and real YouTube player; no generated decoration.
9. Use short color/opacity feedback and reduced-motion support; no animated layout resizing.

Verification: compare screenshots of all four views; typecheck/build; exercise tags, note sources, selection actions, panel dismissal, drafts and drag/keyboard resizing. Temporary browser test data stays outside the workspace and is removed after checks.

## Delivered

The shared visual layer lives in `src/learning-ui.css`, loaded after the existing reader styles. The home, library and reader copy was updated in `src/learning.tsx` and `src/library.tsx`.

- Kept the paper surface, green margin rule, yellow highlights and editorial serif.
- Replaced the generic landing headline with “A reading room for YouTube” and retained the original example passage.
- Removed the rotated preview, ornamental shelf headings and repeated caption-source labels.
- Used a filled state only for the current library destination; status and tag filters use quieter text states.
- Aligned video duration, titles and tag rows, including bulk selection.
- Made notes and source passages distinct through sans/serif type, stronger contrast and a thin source rule.
- Retained short color feedback and reduced-motion support.

Measured at 1440 × 1000, with the same video and 320px notes panel:

| Measurement | Before | After |
| --- | ---: | ---: |
| Header height | 82px | 64px |
| Library sidebar | 210px | 240px |
| Library content padding | 55px | 32px |
| Navigation text | 12px | 14px |
| Video metadata | 10px | 12px |
| Reader source metadata | 9px | 12px |
| Transcript text | 17px | 18px |
| Reader column start | 187px | 144px |
| Reader column height | 780px | 832px |

The three shared text colors have contrast ratios of 11.47:1, 6.01:1 and 4.61:1 against the paper surface.

## Validation

- `npm run verify`: typecheck, 46 tests and production build passed. Typecheck and build were rerun after the caption-label correction; the final CSS build also passed.
- Existing resize regression: 10 checks passed, including pointer and keyboard resizing, collapsed/open states, reading position, saved widths after refresh, draft recovery and reset. No page overflow at 761, 900, 1024, 1280, 1440, 1728 or 2048px.
- Existing organization regression: tag creation, deduplication, removal, batch operations, rename/merge, scoped search, saved-note filtering, quoted/unanchored source navigation, reader tags and recovery from a temporary notes error passed.
- Interaction regression: native selection and highlighting, dragging across highlighted words, multiple notes, hover preview, isolated editing, draft recovery after reload, editable AI-answer conversion, source-conversation navigation and transcript search passed.
- Temporary records, drafts, videos and tags were cleaned up. Original record bodies, question IDs and drafts were compared after interaction checks.
- Browser captures reported no application errors. The third-party YouTube frame can be black while its own media loads; screenshots are layout evidence, not a playback-quality check.

Final captures:

- [Home](unslop-after-home.png)
- [Library](unslop-after-library.png)
- [All notes](unslop-after-notes.png)
- [Reader](unslop-after-reader.png)

Local preview: <http://127.0.0.1:5178/library>.
