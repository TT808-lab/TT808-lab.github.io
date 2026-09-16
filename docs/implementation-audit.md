# Course Reader implementation audit

## Baseline and rollback

- Baseline commit: `a883a2820495a29ef5e75e8fa4ebe324c3ed7608`.
- Existing uncommitted bookmarks/voice changes preserved before implementation.
- Exact HTML snapshot: `.local-backups/before-unified-reader-20260916/course-reader.html`.
- SHA256 of snapshot and starting working HTML: `A5F34C5CD1FDE8BD92261AC279C345057B67931ADA1A2979019552A17201F175`.
- Original toolbox snapshot saved alongside. Backups and test artifacts are ignored by Git.
- Product HTML now uses `app.mjs` plus the core modules. A local smoke run opened the new reader and saved a two-paragraph English paste without changing the real study data.
- Restoring the HTML snapshot restores the pre-goal UI. Once the v3 schema is used, the v1 HTML cannot open a v3 DB with an explicit v1 request; rollback after migration must retain the compatible reader. Never delete the DB to downgrade.

## Checkpoint 1 — data / batches

Independent review through the existing ChatGPT tab: first verdict REVISE, second verdict PASS (no remaining model blockers).

Accepted findings:

1. A stable `legacy:<oldId>` mapping commits with the migrated document and page cache in one transaction. Completed migrations read the new records as sole authority; originals remain untouched. Uncompleted mappings use legacy reads.
2. Legacy total page count is unknown (`null`); cached maximum is only a lower bound. Relink compares every informative cached page, requires at least three such pages and a candidate covering the maximum cached page. Insufficient evidence imports separately.
3. Job identity includes document, chosen anchor, and batch index. Atomic claims use owner tokens and expiring leases; stale workers cannot commit. Ready requires every target page. Failed work retains ready pages.

Batch correction: S=17 yields 17–46, 47–76, 77–106, bounded by total pages. Reverse reads do not move S. Unspecified S defaults to 1. Same source hash reuses a document and its existing anchor; a different file never overwrites by title.

Verification: 9 core tests passed with fake-indexeddb. These prove algorithm/storage behavior, not actual PDF rendering or browser migration. CRLF paragraph splitting initially failed and was corrected; rerun passed.

## Checkpoint 2 — translation (review passed)

- Chrome local capability page reports `Translator` present, secure context, en→zh downloadable.
- After user-initiated model preparation, real local translation returned:
  - Source: Alice did not meet Bob yesterday. She will meet him tomorrow.
  - Result: 爱丽丝昨天没有见到鲍勃。 她明天会见他。
- Browser voices include local Microsoft English and Chinese voices; actual TTS playback not verified yet.
- Translator adapter uses the browser API, no API key, fetch proxy or paid service.
- Official API reference: https://developer.chrome.com/docs/ai/translator-api
- Translation-only mock tests are labelled as such; 13 total automated tests currently pass.
- Structural completeness is verifiable; semantic translation fidelity still requires sampling and cannot be guaranteed by counting paragraphs.
- Real local 100-paragraph result: count=100, ready=100, ordered=true, failed=[]; first/last translated chapter numbers were 1/100.
- Independent reviewer requested a strict chunk→unit commit boundary. Added readyText (null unless the entire paragraph is ready), five-chunk retry and late-cancellation tests. Second review: PASS, no remaining model blockers.
- A pre-aborted Web Lock test briefly regressed during the second review submission; corrected and reran all tests. The final 14 translation/core tests passed; later TTS tests brought the total to 20.

## Checkpoint 3 — TTS (design passed; audible device check remains)

- Shared controller and browser provider implemented with language-specific voices, local-only default, stop/pause/resume/rate, retry on error, token fencing, and next-page waiting.
- 20 automated tests pass in total; these are not evidence of audible output.
- Native Chrome calls to Microsoft David and Huihui returned end without start. English request/end: 3492.6/3560.4 ms; Chinese: 3560.6/3643.4 ms. Total ~151 ms cannot substantiate speech for both sentences.
- Repeated native check produced the same missing-start / rapid-completion pattern. No online voice was used to bypass it.
- Controller guards suspicious rapid no-start completion for nontrivial text as an error, retaining position. A missing start event alone for a normally timed utterance is not sufficient to declare failure.
- Independent CP3 reviewer: REVISE, one blocker (missing real audible speech evidence); no additional controller model blocker. Recommended a direct, visible native speech test with separate English/Chinese controls and human listening.
- Test page now includes separate David/Huihui buttons plus pause/resume/stop, independent of the controller. User must report whether both voices are audible and whether Stop works before CP3 can close.
- The integrated UI exposes the shared controller for PDF and pasted text, local Chinese/English voice filtering, independent voice preferences, rate, Play/Pause/Stop, sentence highlighting, and explicit speech errors. A real phone must still confirm audible output because desktop Chrome emitted `end` without `start` during automation.

## Checkpoint 4 — integration and release smoke

- The product page is connected to the repository, batch processor, browser translation provider, and speech controller.
- English pasted text was saved, reopened, displayed as original paragraphs, explicitly translated in Chrome's local Translator API, and shown with the original retained.
- The UI language toggle changed labels while leaving the English body unchanged.
- The PDF path uses PDF.js, stores rendered pages in 30-page anchored batches, prefetches the next batch near the boundary, and exposes an explicit EN→ZH button for extracted English pages. A file-chooser limitation prevented automated browser upload of the generated smoke PDF; core batch tests cover 105 pages across four batches.

## Verification commands

```
npm.cmd install --save-dev fake-indexeddb
npm.cmd install --save-dev playwright pdf-lib pdfjs-dist@4.10.38 --ignore-scripts
npm.cmd run check
npm.cmd test
node scripts/serve.mjs
```

Local capability page: `http://127.0.0.1:4179/tests/capabilities.html`. It uses synthetic text and a unique test database, never the real studyReaderDB.

## Pending

Actual phone audio confirmation remains the only user-device check. No paid API or key is used. Build/lint/typecheck are not configured; syntax checks and node tests are the current checks. Dependencies install cleanly with no reported audit vulnerabilities.
