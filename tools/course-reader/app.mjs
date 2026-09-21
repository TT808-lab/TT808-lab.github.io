import { openDatabase } from './core/storage.mjs';
import { BatchProcessor } from './core/batches.mjs';
import { batchForPage, nextBatch, normalizeReadingText, paragraphs } from './core/model.mjs';
import { BrowserTranslationProvider, TranslationController } from './core/translation.mjs';
import { HybridSpeechProvider, MINIMAX_VOICES, SpeechController, languageOf, speechItems } from './core/speech.mjs';
import { BrowserOcrProvider, OCR_VERSION } from './core/ocr.mjs';

// PDF.js ships a web worker for off-main-thread parsing. Without workerSrc,
// large PDFs parse synchronously on the main thread and the import button
// appears frozen. The CDN ships pdf.min.js + pdf.worker.min.js side-by-side.
if (globalThis.pdfjsLib && !globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc) {
  globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

const $ = id => document.getElementById(id);
const text = (zh, en) => uiLanguage === 'zh' ? zh : en;
let uiLanguage = localStorage.getItem('course-reader-ui') || 'zh';
let repo, batcher, translation, speech, pdfDocument, ocr;
let speechProvider;
let current = null, currentUnits = [], currentPdfPage = null, currentTranslation = new Map();
let pdfSourceCache = new Map();
let pageImageUrl = null;
const ocrInFlight = new Map();
const PUBLIC_MINIMAX_ENDPOINT = 'https://tt808-course-reader-relay.vercel.app/api/minimax-tts';

function setStatus(id, message, error = false) { const el = $(id); el.textContent = message || ''; el.classList.toggle('error', error); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function applyLanguage() {
  document.documentElement.lang = uiLanguage === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-zh][data-en]').forEach(el => { el.textContent = el.dataset[uiLanguage]; });
  $('langZh').classList.toggle('active', uiLanguage === 'zh'); $('langEn').classList.toggle('active', uiLanguage === 'en');
  if (current && !$('reader').classList.contains('hidden')) {
    $('readerMeta').textContent = current.type === 'pdf' ? text(`PDF · 起始页 ${current.anchor || 1} · 每批约 30 页`, `PDF · anchor ${current.anchor || 1} · batches of about 30 pages`) : text(`${currentUnits.length} 个原始段落 · 翻译默认关闭`, `${currentUnits.length} original paragraphs · translation is off by default`);
    if (current.type === 'pdf' && currentPdfPage) { const page = current.position?.page || current.anchor || 1; const batch = batchForPage(current, page); setStatus('pageStatus', text(`第 ${page} 页 · 当前批次 ${batch.start}–${batch.end}`, `Page ${page} · batch ${batch.start}–${batch.end}`)); renderContent(); }
  }
}
function setScreen(name) { $('home').classList.toggle('hidden', name !== 'home'); $('reader').classList.toggle('hidden', name !== 'reader'); $('playerDeck').classList.toggle('hidden', name !== 'reader'); }
function setTab(tab) { $('pdfForm').classList.toggle('hidden', tab !== 'pdf'); $('textForm').classList.toggle('hidden', tab !== 'text'); $('pdfTab').classList.toggle('active', tab === 'pdf'); $('textTab').classList.toggle('active', tab === 'text'); }
function syncQuickPager(doc, page) { const visible = doc?.type === 'pdf'; $('quickPager').classList.toggle('hidden', !visible); if (!visible) return; $('quickPage').textContent = `${page} / ${doc.totalPages}`; $('quickPrev').disabled = page <= 1; $('quickNext').disabled = page >= doc.totalPages; }
function defaultMiniMaxEndpoint() {
  if (location.port === '4179') return `${location.origin}/api/minimax-tts`;
  return location.hostname === 'tt808-lab.github.io' ? PUBLIC_MINIMAX_ENDPOINT : '';
}
function applyMiniMaxSetupLink() {
  const url = new URL(location.href); const secret = url.searchParams.get('minimax_setup');
  if (!secret || secret.length < 16 || location.hostname !== 'tt808-lab.github.io') return false;
  localStorage.setItem('course-reader-minimax-endpoint', PUBLIC_MINIMAX_ENDPOINT);
  localStorage.setItem('course-reader-minimax-relay-secret', secret);
  url.searchParams.delete('minimax_setup'); history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  return true;
}
function miniMaxEndpointIsReady(endpoint, secret) { return endpoint !== PUBLIC_MINIMAX_ENDPOINT || Boolean(secret); }

async function renderPdfPage(blob, pageNum, signal, { ocr: runOcr = false, onProgress } = {}) {
  const abort = () => { if (signal?.aborted) throw new DOMException('OCR cancelled.', 'AbortError'); };
  abort();
  const key = await blob.arrayBuffer();
  const cacheKey = `${blob.size}:${blob.lastModified || 0}`;
  let pdf = pdfSourceCache.get(cacheKey);
  if (!pdf) { pdf = await pdfjsLib.getDocument({ data: key }).promise; pdfSourceCache.set(cacheKey, pdf); }
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: runOcr ? 1.6 : 1.25 });
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const image = await new Promise((resolve, reject) => canvas.toBlob(blobValue => blobValue ? resolve(blobValue) : reject(new Error('Could not create page image.')), 'image/jpeg', .82));
  const content = await page.getTextContent();
  let previousY = null; let extracted = '';
  for (const item of content.items) {
    const y = Math.round(item.transform?.[5] || 0);
    if (previousY !== null) extracted += Math.abs(y - previousY) > 4 ? '\n' : ' ';
    extracted += item.str || ''; previousY = y;
  }
  const textValue = normalizeReadingText(extracted);
  const meaningful = textValue.length >= 12 && /[\p{L}\p{N}\p{Script=Han}]/u.test(textValue);
  if (meaningful || !runOcr) return { image, text: meaningful ? textValue : '', extractionVersion: 'pdfjs-3-line-v1', textSource: meaningful ? 'pdfjs' : 'image', ocrStatus: meaningful ? 'skipped' : 'pending', ocrVersion: OCR_VERSION, ocrError: null };
  const capability = ocr.capability();
  if (capability.state !== 'available') return { image, text: '', extractionVersion: 'pdfjs-3-line-v1', textSource: 'image', ocrStatus: 'unavailable', ocrVersion: OCR_VERSION, ocrError: capability.error };
  try {
    const result = await ocr.recognize(image, { language: 'auto', signal, onProgress });
    return { image, text: result.text, extractionVersion: result.version, textSource: 'ocr', ocrStatus: 'ready', ocrVersion: result.version, ocrError: null };
  } catch (error) {
    const cancelled = error?.name === 'AbortError';
    return { image, text: '', extractionVersion: 'pdfjs-3-line-v1', textSource: 'image', ocrStatus: cancelled ? 'cancelled' : 'failed', ocrVersion: OCR_VERSION, ocrError: error?.message || String(error) };
  }
}

async function loadLibrary() {
  const docs = (await repo.listDocuments()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $('library').innerHTML = docs.length ? docs.map(doc => `<div class="library-item"><div><strong>${escapeHtml(doc.title)}</strong><small>${doc.type === 'pdf' ? `PDF · ${doc.totalPages || doc.cachedMax || '?'} ${text('页','pages')} · ${text('起点','anchor')} ${doc.anchor || 1}` : `Text · ${(doc.rawText || '').length} chars`}</small></div><div class="row"><button class="btn primary fit" data-open="${escapeHtml(doc.id)}">${text('打开','Open')}</button><button class="btn danger fit" data-delete="${escapeHtml(doc.id)}">${text('删除','Delete')}</button></div></div>`).join('') : `<div class="hint">${text('还没有内容。可以导入 PDF 或粘贴文字。','Nothing saved yet. Import a PDF or paste text.')}</div>`;
  $('library').querySelectorAll('[data-open]').forEach(btn => btn.onclick = () => openDocument(btn.dataset.open));
  $('library').querySelectorAll('[data-delete]').forEach(btn => btn.onclick = async () => { if (!confirm(text('删除本机保存的全部内容？','Delete all locally saved content?'))) return; await repo.deleteDocument(btn.dataset.delete); await loadLibrary(); });
}

async function preparePdfDocument(doc, page = doc.position?.page || doc.anchor || 1) {
  currentPdfPage = null; currentTranslation.clear();
  $('ocrRetry').classList.add('hidden');
  $('readerTitle').textContent = doc.title; $('readerMeta').textContent = text(`PDF · 起始页 ${doc.anchor || 1} · 每批约 30 页`, `PDF · anchor ${doc.anchor || 1} · batches of about 30 pages`);
  $('pageNumber').value = page; $('pageTotal').textContent = `/ ${doc.totalPages}`; syncQuickPager(doc, page); $('showTranslation').checked = false;
  const next = nextBatch(doc, page); if (next) setStatus('pageStatus', text(`接近批次末尾时会准备第 ${next.start}–${next.end} 页。`, `Next batch ${next.start}–${next.end} will prepare near the end.`));
  await ensureAndShowPage(doc, page);
}
async function ensureOcrForPage(doc, page, { force = false } = {}) {
  const key = `${doc.id}:${page}`;
  if (ocrInFlight.has(key)) return ocrInFlight.get(key);
  const promise = (async () => {
    const cached = await repo.getPage(doc.id, page);
    if (!cached) return null;
    if (!force && cached.ocrStatus === 'ready') return cached;
    await repo.updatePage(doc.id, page, { ocrStatus: 'running', ocrError: null, ocrVersion: OCR_VERSION });
    setStatus('pageStatus', text(`正在本机识别第 ${page} 页…`, `Recognizing page ${page} locally…`));
    const source = await repo.get('sourceBlobs', doc.id);
    if (!source?.blob) throw new Error(text('原始 PDF 不在本机，无法进行 OCR。','The original PDF is unavailable locally for OCR.'));
    const rendered = await renderPdfPage(source.blob, page, undefined, { ocr: true, onProgress: message => {
      if (message?.status && Number.isFinite(message.progress)) setStatus('pageStatus', text(`正在本机识别第 ${page} 页… ${Math.round(message.progress * 100)}%`, `Recognizing page ${page} locally… ${Math.round(message.progress * 100)}%`));
    } });
    return repo.updatePage(doc.id, page, rendered);
  })().finally(() => ocrInFlight.delete(key));
  ocrInFlight.set(key, promise); return promise;
}
async function ensureAndShowPage(doc, page, { forceOcr = false } = {}) {
  page = Math.min(doc.totalPages, Math.max(1, Number(page) || 1)); $('pageNumber').value = page; syncQuickPager(doc, page);
  try {
    const cached = await repo.getPage(doc.id, page);
    if (!cached) { setStatus('pageStatus', text('正在处理这一批页面…','Preparing this batch…')); await batcher.ensure(doc, page, { ocrPage: page }); }
    let pageData = await repo.getPage(doc.id, page); if (!pageData) throw new Error(text('页面处理失败。','Page processing failed.'));
    const needsOcr = !pageData.text?.trim() && (forceOcr || ['pending', 'running', 'failed', 'cancelled'].includes(pageData.ocrStatus) || !pageData.ocrStatus);
    if (needsOcr) pageData = await ensureOcrForPage(doc, page, { force: forceOcr });
    if (!pageData) throw new Error(text('页面处理失败。','Page processing failed.'));
    const normalizedText = normalizeReadingText(pageData.text || '');
    if (normalizedText !== (pageData.text || '')) pageData = await repo.updatePage(doc.id, page, { text: normalizedText, normalizationVersion: 'reading-text-v1' });
    currentPdfPage = pageData; currentUnits = [{ id: `${doc.id}:page:${page}`, documentId: doc.id, order: page, text: pageData.text || '' }];
    const sourceLanguage = currentUnits[0].text.trim() ? languageOf(currentUnits[0].text, doc.sourceLanguage) : null; $('translateBtn').classList.toggle('hidden', sourceLanguage !== 'en');
    if (sourceLanguage === 'en') { const cachedTranslation = await translation.readyText(currentUnits[0], 'en', 'zh'); if (cachedTranslation) currentTranslation.set(currentUnits[0].id, cachedTranslation); }
    const b = batchForPage(doc, page); const n = nextBatch(doc, page);
    const pageLabel = text(`第 ${page} 页 · 当前批次 ${b.start}–${b.end}${n ? ` · 下一批 ${n.start}–${n.end}` : ''}`, `Page ${page} · batch ${b.start}–${b.end}${n ? ` · next ${n.start}–${n.end}` : ''}`);
    const ocrLabel = pageData.ocrStatus === 'failed' ? text(`本页 OCR 失败：${pageData.ocrError || '未知错误'}`, `OCR failed: ${pageData.ocrError || 'unknown error'}`) : pageData.ocrStatus === 'unavailable' ? text(`本机 OCR 不可用：${pageData.ocrError || '请检查浏览器'}`, `Local OCR unavailable: ${pageData.ocrError || 'check the browser'}`) : pageData.ocrStatus === 'cancelled' ? text('本页 OCR 已取消，可点击重试。','OCR was cancelled; retry is available.') : pageLabel;
    setStatus('pageStatus', ocrLabel, ['failed', 'unavailable', 'cancelled'].includes(pageData.ocrStatus));
    $('ocrRetry').classList.toggle('hidden', !['failed', 'unavailable', 'cancelled'].includes(pageData.ocrStatus));
    $('pageProgress').style.width = `${page / doc.totalPages * 100}%`; await repo.updateDocument({ ...doc, position: { page }, updatedAt: Date.now() }); renderContent(); renderBookmarks(doc); loadVoices();
    if (n && page >= b.end - 4) void batcher.ensure(doc, n.start).catch(error => setStatus('pageStatus', error.message, true));
  } catch (error) { setStatus('pageStatus', error.message, true); }
}

async function prepareTextDocument(doc) {
  syncQuickPager(null, 0);
  $('ocrRetry').classList.add('hidden');
  currentPdfPage = null; currentTranslation.clear(); currentUnits = await repo.getUnits(doc.id); const sourceLanguage = languageOf(doc.rawText, doc.sourceLanguage); for (const unit of currentUnits) { const cachedTranslation = sourceLanguage === 'en' ? await translation.readyText(unit, 'en', 'zh') : null; if (cachedTranslation) currentTranslation.set(unit.id, cachedTranslation); } $('readerTitle').textContent = doc.title; $('readerMeta').textContent = text(`${currentUnits.length} 个原始段落 · 翻译默认关闭`, `${currentUnits.length} original paragraphs · translation is off by default`); $('translateBtn').classList.toggle('hidden', sourceLanguage !== 'en'); $('showTranslation').checked = false; renderContent(); const savedUnit = currentUnits.find(unit => unit.order === doc.position?.unit); if (savedUnit) document.querySelector(`[data-unit="${CSS.escape(savedUnit.id)}"]`)?.scrollIntoView({ block: 'center' }); renderBookmarks(doc); speech.stop(); loadVoices();
}
function renderContent() {
  const show = $('showTranslation').checked; const lang = languageOf(currentUnits.map(u => u.text).join('\n'), current?.sourceLanguage); const hasText = currentUnits.some(unit => unit.text.trim());
  if (pageImageUrl) { URL.revokeObjectURL(pageImageUrl); pageImageUrl = null; }
  const image = currentPdfPage?.image && !hasText ? (pageImageUrl = URL.createObjectURL(currentPdfPage.image), `<img src="${pageImageUrl}" alt="${text('PDF 图片页','PDF image page')}" style="display:block;width:100%;max-height:68vh;object-fit:contain;border-radius:8px;margin-bottom:12px">`) : '';
  const emptyMessage = currentPdfPage?.ocrStatus === 'failed' ? text('本页本机文字识别失败，请点击“重试 OCR”。','Local OCR failed for this page. Click “Retry OCR”.') : currentPdfPage?.ocrStatus === 'unavailable' ? text('本机 OCR 不可用，未上传页面内容。请检查浏览器后重试。','Local OCR is unavailable. The page was not uploaded. Check the browser and retry.') : text('这是图片页，正在等待本机文字识别。','This is an image page waiting for local OCR.');
  const body = hasText ? currentUnits.map(unit => { const translated = currentTranslation.get(unit.id); return `<div class="unit" data-unit="${escapeHtml(unit.id)}"><div class="page-text">${escapeHtml(unit.text)}</div>${show && translated ? `<div class="translation">${escapeHtml(translated)}</div>` : ''}</div>`; }).join('') : `<div class="hint">${emptyMessage}</div>`;
  $('content').innerHTML = image + body;
  document.querySelectorAll('[data-unit]').forEach(el => el.onclick = async () => { const unit = currentUnits.find(u => u.id === el.dataset.unit); if (unit) { current = await repo.updateDocument({ ...current, position: { unit: unit.order } }); const translatedUnit = { ...unit, translation: currentTranslation.get(unit.id) }; const translated = show && currentTranslation.has(unit.id); speech.play(speechItems([translatedUnit], translated ? 'zh' : lang, translated), { next: null }); } });
}
function renderBookmarks(doc) { $('bookmarks').innerHTML = (doc.bookmarks || []).length ? doc.bookmarks.map((mark, i) => `<div class="bookmark"><span>${escapeHtml(mark.name)} · ${mark.pageNum}</span><button class="btn fit" data-bookmark="${i}">${text('打开','Open')}</button></div>`).join('') : `<div class="hint">${text('还没有书签。','No bookmarks yet.')}</div>`; $('bookmarks').querySelectorAll('[data-bookmark]').forEach(btn => btn.onclick = () => doc.type === 'pdf' ? ensureAndShowPage(doc, doc.bookmarks[Number(btn.dataset.bookmark)].pageNum) : null); }
async function openDocument(id) { current = await repo.getDocument(id); if (!current) return; if (current.type === 'pdf' && !current.totalPages) current = { ...current, totalPages: current.cachedMax || 1 }; setScreen('reader'); if (current.type === 'pdf') await preparePdfDocument(current); else await prepareTextDocument(current); }

async function translateCurrent() {
  const sourceText = currentUnits.map(u => u.text).join('\n'); if (!sourceText.trim()) { setStatus('translationStatus', text('此页没有可翻译的文字。','This page has no text to translate.'), true); return; }
  const source = languageOf(sourceText, current.sourceLanguage); if (source !== 'en') return;
  const button = $('translateBtn'); button.disabled = true; setStatus('translationStatus', text('点击后准备本机翻译模型…','Preparing the local translation model…'));
  try {
    await translation.provider.prepare('en', 'zh', loaded => setStatus('translationStatus', `${text('下载翻译模型','Downloading translation model')} ${Math.round(loaded * 100)}%`));
    const results = await translation.translateAll(currentUnits, 'en', 'zh', { onState: record => { if (record.status === 'failed') setStatus('translationStatus', record.error, true); } });
    currentTranslation = new Map(); const failed = [];
    for (const result of results) { if (result.status === 'ready') currentTranslation.set(result.unitId, result.text); else failed.push(result); }
    $('retryBtn').classList.toggle('hidden', failed.length === 0); $('showTranslation').checked = failed.length === 0; setStatus('translationStatus', failed.length ? text(`${failed.length} 段失败，可重试。`,` ${failed.length} part(s) failed; retry is available.`) : text('翻译完成，原文仍保留。','Translation ready; original text is retained.')); renderContent();
  } catch (error) { setStatus('translationStatus', error.message, true); } finally { button.disabled = false; }
}

function currentSpeechQueue() { const sourceText = currentUnits.map(u => u.text).join('\n'); if (!sourceText.trim()) { setStatus('speechStatus', text('图片页没有可朗读文字。','This image-only page has no text to read.'), true); return []; } const lang = languageOf(sourceText, current?.sourceLanguage); const translated = $('showTranslation').checked && currentTranslation.size; const units = currentUnits.map(unit => ({ ...unit, translation: currentTranslation.get(unit.id) })); return speechItems(units, translated ? 'zh' : lang, Boolean(translated)); }
function playCurrentReading() {
  const queue = currentSpeechQueue(); if (!queue.length) return;
  if (current?.type !== 'pdf') { speech.play(queue); return; }
  speech.play(queue, { next: async () => { if (!$('continuous').checked) return null; const nextPage = Number($('pageNumber').value) + 1; if (nextPage > current.totalPages) return null; await ensureAndShowPage(current, nextPage); return currentSpeechQueue(); } });
}
function loadVoices() { const sourceText = currentUnits.map(u => u.text).join('\n'); if (!sourceText.trim()) { $('voice').innerHTML = `<option>${text('图片页无可用音色','No voice needed for an image-only page')}</option>`; return; } const lang = languageOf(sourceText, current?.sourceLanguage); const voices = speech.voices(lang); $('voice').innerHTML = voices.length ? voices.map(v => `<option value="${escapeHtml(v.voiceURI)}">${escapeHtml(v.name)} (${escapeHtml(v.lang)})${v.provider === 'minimax' ? ' · MiniMax' : v.localService ? ' · Local' : ''}</option>`).join('') : `<option>${text('未检测到匹配的本机音色','No matching local voice')}</option>`; const selected = speech.voice(lang); if (selected) $('voice').value = selected.voiceURI; }
function updateSpeechState({ state, error, detail }) {
  let preparing = detail?.provider === 'minimax'
    ? text('正在生成 MiniMax 语音…', 'Generating MiniMax speech…')
    : text('正在准备本地语音，首次使用会下载音色模型…','Preparing local voice; first use downloads the voice model…');
  if (detail?.total) {
    const pct = Math.max(0, Math.min(100, Math.round(detail.loaded * 100 / detail.total)));
    preparing = detail.phase === 'inference'
      ? text(`正在生成本地语音 ${pct}%…`, `Generating local voice ${pct}%…`)
      : text(`正在下载本地音色 ${pct}%…`, `Downloading local voice ${pct}%…`);
  }
  setStatus('speechStatus', error || ({preparing,playing:text('朗读中','Playing'),paused:text('已暂停','Paused'),waiting:text('准备下一段','Preparing next'),stopped:text('已停止','Stopped'),error:text('朗读失败','Speech error')}[state] || state), Boolean(error));
  document.querySelectorAll('.unit').forEach(el => el.classList.remove('playing'));
}

async function init() {
  repo = await openDatabase(); await repo.migrateLegacy(bookId => { try { return JSON.parse(localStorage.getItem(`reader_notes:${bookId}`)); } catch { return null; } });
  ocr = new BrowserOcrProvider();
  const configuredByLink = applyMiniMaxSetupLink();
  const prefs = await repo.getPreference('tts') || { id: 'tts', voices: {}, rate: 1 };
  const storedEndpoint = localStorage.getItem('course-reader-minimax-endpoint');
  const automaticEndpoint = !String(storedEndpoint || '').trim() ? defaultMiniMaxEndpoint() : '';
  const savedEndpoint = String(storedEndpoint || '').trim() || automaticEndpoint;
  const savedSecret = localStorage.getItem('course-reader-minimax-relay-secret') || '';
  const savedModel = localStorage.getItem('course-reader-minimax-model') || 'speech-2.8-turbo';
  if (automaticEndpoint) localStorage.setItem('course-reader-minimax-endpoint', automaticEndpoint);
  const minimaxReady = Boolean(savedEndpoint && miniMaxEndpointIsReady(savedEndpoint, savedSecret));
  speechProvider = new HybridSpeechProvider(undefined, undefined, undefined);
  speechProvider.setMinimaxEndpoint(minimaxReady ? savedEndpoint : '', savedSecret, savedModel);
  speech = new SpeechController(speechProvider, { preferences: prefs.voices || {}, rate: prefs.rate || 1, onState: updateSpeechState, onHighlight: item => { document.querySelectorAll('.unit').forEach(el => el.classList.toggle('playing', el.dataset.unit === item?.unitId)); }, onPreference: value => { void repo.put('preferences', { id: 'tts', ...value }); } });
  if ((automaticEndpoint || configuredByLink) && minimaxReady && !String(prefs.voices?.zh || '').startsWith('minimax:')) speech.changeSettings({ language: 'zh', voiceURI: MINIMAX_VOICES[0].voiceURI });
  translation = new TranslationController(repo, new BrowserTranslationProvider()); batcher = new BatchProcessor(repo, renderPdfPage);
  $('minimaxEndpoint').value = savedEndpoint; $('minimaxRelaySecret').value = savedSecret; $('minimaxModel').value = savedModel;
  $('minimaxAdvanced').open = !minimaxReady;
  speechProvider.onVoicesChanged(loadVoices); $('rate').value = speech.rate; $('rateValue').value = `${speech.rate}×`; loadVoices(); await loadLibrary(); applyLanguage();
  $('continuous').checked = localStorage.getItem('course-reader-continuous') !== '0';
  if (minimaxReady) setStatus('minimaxStatus', savedEndpoint === PUBLIC_MINIMAX_ENDPOINT ? text('已连接 MiniMax 在线音色。','Connected to MiniMax online voices.') : text('已自动连接本机 MiniMax 音色。','Connected to the local MiniMax voice automatically.'));
  else if (savedEndpoint === PUBLIC_MINIMAX_ENDPOINT) setStatus('minimaxStatus', text('MiniMax 在线音色需要授权，请使用专属设置链接。','MiniMax online voices require authorization; use the private setup link.'), true);
}

$('langZh').onclick = () => { uiLanguage = 'zh'; localStorage.setItem('course-reader-ui', uiLanguage); applyLanguage(); void loadLibrary(); };
$('langEn').onclick = () => { uiLanguage = 'en'; localStorage.setItem('course-reader-ui', uiLanguage); applyLanguage(); void loadLibrary(); };
$('pdfTab').onclick = () => setTab('pdf'); $('textTab').onclick = () => setTab('text'); $('backHome').onclick = () => { speech.stop(); setScreen('home'); void loadLibrary(); };
$('importPdf').onclick = async () => { const file = $('pdfFile').files[0]; if (!file) return setStatus('pdfStatus', text('请选择 PDF 文件。','Choose a PDF file.'), true); try { $('importPdf').disabled = true; setStatus('pdfStatus', text('正在解析 PDF…','Parsing PDF…')); const data = await file.arrayBuffer(); const pdf = await pdfjsLib.getDocument({ data }).promise; const start = Math.min(pdf.numPages, Math.max(1, Number($('pdfStart').value) || 1)); current = await repo.importPdf({ blob: file, title: $('pdfTitle').value.trim() || file.name, totalPages: pdf.numPages, startPage: start }); pdfDocument = pdf; setStatus('pdfStatus', text('已保存，正在打开第一批…','Saved; opening the first batch…')); await openDocument(current.id); } catch (error) { setStatus('pdfStatus', error.message, true); } finally { $('importPdf').disabled = false; } };
$('saveText').onclick = async () => { try { const rawText = $('rawText').value; current = await repo.saveText({ title: $('textTitle').value.trim() || text('粘贴文字','Pasted text'), rawText, sourceLanguage: $('textLanguage').value }); await openDocument(current.id); } catch (error) { setStatus('textStatus', error.message, true); } };
$('prevPage').onclick = () => current?.type === 'pdf' && ensureAndShowPage(current, Number($('pageNumber').value) - 1); $('nextPage').onclick = () => current?.type === 'pdf' && ensureAndShowPage(current, Number($('pageNumber').value) + 1); $('pageNumber').onchange = () => current?.type === 'pdf' && ensureAndShowPage(current, $('pageNumber').value);
$('quickPrev').onclick = () => current?.type === 'pdf' && ensureAndShowPage(current, Number($('pageNumber').value) - 1); $('quickNext').onclick = () => current?.type === 'pdf' && ensureAndShowPage(current, Number($('pageNumber').value) + 1);
$('ocrRetry').onclick = () => current?.type === 'pdf' && ensureAndShowPage(current, Number($('pageNumber').value), { forceOcr: true });
$('translateBtn').onclick = translateCurrent; $('retryBtn').onclick = translateCurrent; $('showTranslation').onchange = renderContent;
$('saveMinimax').onclick = () => {
  const endpoint = $('minimaxEndpoint').value.trim(); const secret = $('minimaxRelaySecret').value; const model = $('minimaxModel').value;
  localStorage.setItem('course-reader-minimax-endpoint', endpoint); localStorage.setItem('course-reader-minimax-relay-secret', secret); localStorage.setItem('course-reader-minimax-model', model);
  const ready = Boolean(endpoint && miniMaxEndpointIsReady(endpoint, secret)); speechProvider.setMinimaxEndpoint(ready ? endpoint : '', secret, model); loadVoices();
  setStatus('minimaxStatus', ready ? text('MiniMax 音色已启用。','MiniMax voice enabled.') : endpoint ? text('请填写中转密钥。','Enter the relay authorization.' ) : text('已关闭 MiniMax，使用本机音色。','MiniMax disabled; using system voices.'), Boolean(endpoint && !ready));
};
$('addBookmark').onclick = async () => { if (!current) return; const pageNum = current.type === 'pdf' ? Number($('pageNumber').value) : Number(current.position?.unit || 0); const bookmarks = [...(current.bookmarks || []).filter(mark => mark.pageNum !== pageNum), { pageNum, name: $('bookmarkName').value.trim() || text(`第 ${pageNum} 页`,`Page ${pageNum}`) }].sort((a,b) => a.pageNum - b.pageNum); current = await repo.updateDocument({ ...current, bookmarks }); renderBookmarks(current); $('bookmarkName').value = ''; };
$('play').onclick = () => { try { playCurrentReading(); } catch (error) { setStatus('speechStatus', error.message, true); } }; $('pause').onclick = () => speech.state === 'paused' ? speech.resume() : speech.pause(); $('stop').onclick = () => speech.stop(); $('rate').oninput = event => { const value = Number(event.target.value); $('rateValue').value = `${value.toFixed(2)}×`; speech.changeSettings({ rate: value }); }; $('voice').onchange = event => { const lang = languageOf(currentUnits.map(u => u.text).join('\n'), current?.sourceLanguage); speech.changeSettings({ language: lang, voiceURI: event.target.value }); };
$('continuous').onchange = event => localStorage.setItem('course-reader-continuous', event.target.checked ? '1' : '0');

init().catch(error => { setStatus('pdfStatus', error.message, true); setStatus('textStatus', error.message, true); });
