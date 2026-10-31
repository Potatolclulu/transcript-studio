# Chapters, bilingual reading and playback follow

Implemented for the approved PC reader in the local Margin application. No deployment or commit was made.

## Reader behavior

- The video has a thin chapter timeline. Hover or keyboard focus displays a floating preview with chapter start time and topic; a click seeks the embedded YouTube player and locates the matching transcript passage. The current chapter and playback position update together. The expanded directory and chapter heading were removed after user review.
- Creator chapters are preferred and cached. Videos without creator chapters offer an explicit AI outline action. AI chapter boundaries must refer to real original cue IDs; AI outlines are labeled and summarize sampled transcript passages.
- The transcript view offers Original, English + 中文 and 中文. Translation lines share original cue IDs and timestamps. Switching views preserves the visible reading position. Untranslated passages keep their original text.
- Chinese caption retrieval is attempted first. If the advertised track cannot be downloaded or aligned to every original passage, AI translates batches of up to 32 passages from the immutable saved original. The current chapter is prioritized, including any gaps left in it, followed by remaining passages.
- Translation results are cached, with visible completed/total passage counts, background status and explicit resume controls. Returning to a saved translation does not generate it again.
- Selecting Chinese opens a note anchored to the whole corresponding original passage. Existing highlights, citations and note offsets continue to refer to the original caption snapshot.

## Follow correction

Opening the reader previously disabled follow unconditionally. Clicking a timestamp also disabled follow. Both now leave follow enabled during ordinary reading and playback.

The player reports position on state changes, seeks and a 300ms timer. Paused seeks still update the current passage. The reader uses a binary search over original cue starts, scrolls only when the current cue changes and updates the displayed playhead once per second.

Manual scrolling, text selection and note editing pause automatic scrolling. The current playback passage remains highlighted. “Back to playback” recenters the transcript; an open notes panel displays “Follow paused for notes”.

## Processing and accounting

- Local migration: `0004_reading_tools.sql`.
- `reading_tasks` stores source, status, progress, stable track ID, chapter/translation data and a conditional lease.
- Queue messages use `kind: reading`; the existing outbox and scheduled sweep recover undelivered messages. Interrupted requests require explicit retry, so ambiguous provider calls are not silently repeated.
- Only one reading-tool request runs per account at a time. Conditional updates protect running tasks from duplicate queue messages and repeated start requests.
- Production AI batches and questions share conservative reservations and global/account daily caps. Provider failures retain reservations and completed passages. Reaching a production cap pauses the job without calling the provider.
- Local testing with `APP_ENV=development` skips the application budget caps for translation, chapter outlines and AI questions. Provider credentials, a model and an HTTPS endpoint remain required. Reservations are still recorded; absent request-budget configuration records zero cents. These are accounting estimates, not actual provider charges. Production configuration is unchanged.
- Chinese captions are preferred; if retrieval or alignment fails, the current local AI fallback calls the server-configured DeepSeek model (`deepseek-flash`). Partial translation progress remains visible until all passages complete.
- The caption helper accepts authenticated metadata/Chinese-caption requests. Metadata retrieval does not download audio or captions. Chinese tracks remain visible when many automatic translations are advertised.

Files: `src/reading-tools.tsx`, `src/learning.tsx`, `src/learning-ui.css`, `worker/reading-tools.ts`, queue/store/routes integration and `probe/captions.py`.

## Real source validation

Video: `https://www.youtube.com/watch?v=7xTGNNLPyMI`, “Deep Dive into LLMs like ChatGPT”, Andrej Karpathy.

- Original transcript: 5,761 English passages; creator directory: 24 chapters.
- Clicked tokenization at 7:47 in a real embedded YouTube player. At 470s the player was playing, passage 214 was active and transcript scrollTop was 11,963px.
- Confirmed follow remained active across subsequent polling/detail refreshes. At passage 219 the passage remained inside the visible transcript viewport.
- Verified a paused seek updated the chapter, manual scrolling exposed the resume control and resume restored follow.
- Chinese track retrieval failed under YouTube rate limiting. The AI fallback returned 28 real translated opening passages, beginning “大家好，我早就想做这个视频了”.
- Verified bilingual/Chinese/original switching and a Chinese selection opening its original source in the note panel.
- Existing note interaction regression passed: selection, highlighting, multiple notes, previews, draft recovery, explicit AI-answer conversion, source navigation and transcript search. Temporary interaction records were cleaned up; the long public video remains in the local preview library for review.
- Final typecheck, 56 JavaScript tests, 5 Python caption-helper tests and production build passed. The 10 resize checks also passed, including saved reading position, refresh preferences, drafts, keyboard controls and desktop widths from 761px to 2048px, without page overflow.
- Verified the actual development daily-limit state: the job paused with all 28 completed passages intact. A hot-reload-interrupted lease was recovered through the normal scheduled sweep, followed by an explicit resume that stopped at the shared cap without another provider request.

Captures at 1440 × 1000:

- [Playing chapter with synchronized transcript](reading-chapters-live.png)
- [Bilingual transcript](reading-bilingual.png)
- [Bilingual reader with notes panel](reading-bilingual-notes.png)

Review the original account at `http://127.0.0.1:5178/library/d5cbf3c7-cd39-4cba-a0bf-62de5b203b58`. The local preview account has the same public video at `http://127.0.0.1:5178/library/a55fd8ec-afe5-43f6-af65-3c6f4359ae26`.

## Follow-up fixes after reported failures

The reader's visible “Add tag” row was removed. Tags remain editable through Video settings and the library.

Expanded chapter navigation now reserves 240px, including a directory of at least 144px. The player can give up height before the directory collapses. The directory opens at the current chapter and its rows display both time and topic. Hovering a timeline segment immediately previews its start time and topic, including when the directory is collapsed.

The reported translation task failed with 0 / 5,761 passages because the old response contract required every global cue ID and an exact array count. A partial response or a model using local numbering invalidated the whole batch. The exact failed model response was not retained, so the specific mismatch cannot be reconstructed.

The new request sends opaque local passage IDs (`p0`, `p1`, …), never database cue indexes. The server maps those IDs to the immutable batch snapshot. Valid identified passages are saved even if other IDs are omitted or invalid; future batches include only missing passages. Unknown IDs are ignored. A completely unusable response still fails explicitly, retaining previous work. This does not relax timestamp or note-anchor validation.

Real retry of the affected original-account task succeeded: 32 passages at cue 1560 onward were saved, beginning at 59:24 with “对事情的简要总结”, corresponding to “the kind of brief summary of the things”. The next batch paused at the existing daily cap; the 32 saved translations remained intact. No daily limits were increased.

Typecheck, 58 tests and build passed. Added regressions cover local-to-global ID mapping, partially missing responses, ignoring unknown/invalid IDs, preserving previous translations and retrying only missing passages.

Browser validation confirmed that the expanded directory displays three complete timestamp/topic rows at 1280 × 800, 1440 × 900, 1440 × 1000 and 1920 × 1080, without horizontal page overflow. Collapsed timeline hover previews, expand/collapse and tag editing through settings passed.
The updated capture was taken after clicking the creator chapter at 59:23 and confirming the real YouTube player was playing past 59:24.

[Updated chapter preview](chapter-preview-fixed.png)

## Local budget bypass requested for testing

`APP_ENV=development` now bypasses application AI budget caps through the shared reservation helper used by questions, translation and chapter outlines. Missing local budget values no longer disable an otherwise configured AI provider. Calls still create reservation records, and production continues to require positive finite budget values and enforce global/account caps.

Typecheck, 64 tests and build passed. New checks cover exhausted and missing development budgets, retained saved passages and reservation records, production account/global limits, and required provider credentials.

The original-account translation was resumed through the local queue without clearing saved work or spend records. Live verification showed 170 / 5,761 passages saved, `status=running`, no error, and the original cue 1560 translation retained. This exceeds the former cap; remaining batches continue in the background. The configured provider is `https://api.deepseek.com/chat/completions`, model `deepseek-flash`.

## Approved compact chapters and centered playback follow

The user chose hover previews instead of an expandable chapter directory. The timeline is now a 4px visual rail with 24px pointer targets directly below the video. Previews float outside document flow and stay visible while the transcript automatically scrolls. Keyboard focus provides the same preview, Escape dismisses it, and previews stay inside the window at either end of the timeline. AI-generated outlines retain their source label in the preview.

The player keeps its intrinsic 16:9 aspect ratio; the chapter directory's 240px reservation and the player's shrinking/max-height rules are gone. Duration, learning status, resume and the YouTube link share one compact utility row. Reader-column heights use the actual grid content position and available viewport height.

Playback centering now scrolls only the transcript container. It runs after the current bilingual passage renders and recalculates after translations, caption-view changes and container/content resizing. Normal passages are centered as a whole; unusually tall passages start inside the visible region. Bottom spacing permits the last passage to be centered. Small incidental or horizontal wheel events do not exit follow mode; deliberate vertical reading gestures still pause it. The paused state is explicit, and “Back to playback” immediately recenters and resumes following. Opening notes retains the existing pause behavior.

Validation: typecheck, 64 tests and build passed. Browser regression checks cover six consecutive bilingual passages, late translation reflow, manual pause/resume, hover persistence during automatic scrolling, keyboard previews, unchanged page scroll, notes-panel interaction, 16:9 video at 1280×800, 1440×900, 1920×1080 and 2048×956, and mobile width/ratio. Stable playback-boundary tests keep center error below 6px. Real YouTube chapter playback was also verified; separate deterministic playback controls were used for repeatable resize/reflow checks because the upstream embed occasionally refuses headless playback. Existing selection, highlighting, independent notes, draft recovery, AI-answer conversion, source conversation and search regression passed.

The original-account translation subsequently completed: 5,761 / 5,761 passages, `status=complete`, no error.

Current captures: [Chapter hover preview](chapter-hover-preview.png) and [Centered bilingual reader](reader-follow-centered.png).

## Resume subtitle follow after closing notes

Opening a note disabled playback follow, but the common panel-close handler did not enable it again. Closing with X therefore left the highlighted passage updating while subtitle scrolling stayed paused.

After draft protection succeeds, closing the learning panel now clears the source selection, resets incidental wheel state and enables follow. The existing centering effect returns to the currently playing passage after the panel collapses. It does not seek the video back to the note's source. Failed draft saving keeps the editor open and following paused.

The browser regression reproduced the original failure before the fix and passed afterwards for X closing a draft, saving a note then closing, closing an edited note, Escape closing, and a failed draft save followed by a successful close retry. Each successful close was checked for immediate centering and continued follow through the next passage; temporary notes/drafts were removed and original records verified intact. Typecheck, 64 tests and build passed.
