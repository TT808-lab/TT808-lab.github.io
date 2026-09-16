import { openDatabase } from './core/storage.mjs';
import { BatchProcessor } from './core/batches.mjs';
import { batchForPage, nextBatch, paragraphs } from './core/model.mjs';
import { BrowserTranslationProvider, TranslationController } from './core/translation.mjs';
import { BrowserSpeechProvider, SpeechController, languageOf, speechItems } from './core/speech.mjs';

const $ = id => document.getElementById(id);
const text = (zh, en) => uiLanguage === 'zh' ? zh : en;
let uiLanguage = localStorage.getItem('course-reader-ui') || 'zh';
let repo, batcher, translation, speech, pdfDocument;
let current = null, currentUnits = [], currentPdfPage = null, currentTranslation = new Map();
let pdfSourceCache = new Map();
let pageImageUrl = null;

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
function setScreen(name) { $('home').classList.toggle('hidden', name !== 'home'); $('reader').classList.toggle('hidden', name !== 'reader'); }
function setTab(tab) { $('pdfForm').classList.toggle('hidden', tab !== 'pdf'); $('textForm').classList.toggle('hidden', tab !== 'text'); $('pdfTab').classList.toggle('active', tab === 'pdf'); $('textTab').classList.toggle('active', tab === 'text'); }
function syncQuickPager(doc, page) { const visible = doc?.type === 'pdf'; $('quickPager').classList.toggle('hidden', !visible); if (!visible) return; $('quickPage').textContent = `${page} / ${doc.totalPages}`; $('quickPrev').disabled = page <= 1; $('quickNext').disabled = page >= doc.totalPages; }

async function renderPdfPage(blob, pageNum) {
  const key = await blob.arrayBuffer();
  const cacheKey = `${blob.size}:${blob.lastModified || 0}`;
  let pdf = pdfSourceCache.get(cacheKey);
  if (!pdf) { pdf = await pdfjsLib.getDocument({ data: key }).promise; pdfSourceCache.set(cacheKey, pdf); }
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1.25 });
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
  return { image, text: extracted.trim(), extractionVersion: 'pdfjs-3-line-v1' };
}

async function loadLibrary() {
  const docs = (await repo.listDocuments()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $('library').innerHTML = docs.length ? docs.map(doc => `<div class="library-item"><div><strong>${escapeHtml(doc.title)}</strong><small>${doc.type === 'pdf' ? `PDF · ${doc.totalPages || doc.cachedMax || '?'} ${text('页','pages')} · ${text('起点','anchor')} ${doc.anchor || 1}` : `Text · ${(doc.rawText || '').length} chars`}</small></div><div class="row"><button class="btn primary fit" data-open="${escapeHtml(doc.id)}">${text('打开','Open')}</button><button class="btn danger fit" data-delete="${escapeHtml(doc.id)}">${text('删除','Delete')}</button></div></div>`).join('') : `<div class="hint">${text('还没有内容。可以导入 PDF 或粘贴文字。','Nothing saved yet. Import a PDF or paste text.')}</div>`;
  $('library').querySelectorAll('[data-open]').forEach(btn => btn.onclick = () => openDocument(btn.dataset.open));
  $('library').querySelectorAll('[data-delete]').forEach(btn => btn.onclick = async () => { if (!confirm(text('删除本机保存的全部内容？','Delete all locally saved content?'))) return; await repo.deleteDocument(btn.dataset.delete); await loadLibrary(); });
}

async function preparePdfDocument(doc, page = doc.position?.page || doc.anchor || 1) {
  currentPdfPage = null; currentTranslation.clear();
  $('readerTitle').textContent = doc.title; $('readerMeta').textContent = text(`PDF · 起始页 ${doc.anchor || 1} · 每批约 30 页`, `PDF · anchor ${doc.anchor || 1} · batches of about 30 pages`);
  $('pageNumber').value = page; $('pageTotal').textContent = `/ ${doc.totalPages}`; syncQuickPager(doc, page); $('showTranslation').checked = false;
  const next = nextBatch(doc, page); if (next) setStatus('pageStatus', text(`接近批次末尾时会准备第 ${next.start}–${next.end} 页。`, `Next batch ${next.start}–${next.end} will prepare near the end.`));
  await ensureAndShowPage(doc, page);
}
async function ensureAndShowPage(doc, page) {
  page = Math.min(doc.totalPages, Math.max(1, Number(page) || 1)); $('pageNumber').value = page; syncQuickPager(doc, page);
  try {
    const cached = await repo.getPage(doc.id, page);
    if (!cached) { setStatus('pageStatus', text('正在处理这一批页面…','Preparing this batch…')); await batcher.ensure(doc, page); }
    const pageData = await repo.getPage(doc.id, page); if (!pageData) throw new Error(text('页面处理失败。','Page processing failed.'));
    currentPdfPage = pageData; currentUnits = [{ id: `${doc.id}:page:${page}`, documentId: doc.id, order: page, text: pageData.text || '' }];
    const sourceLanguage = currentUnits[0].text.trim() ? languageOf(currentUnits[0].text, doc.sourceLanguage) : null; $('translateBtn').classList.toggle('hidden', sourceLanguage !== 'en');
    if (sourceLanguage === 'en') { const cachedTranslation = await translation.readyText(currentUnits[0], 'en', 'zh'); if (cachedTranslation) currentTranslation.set(currentUnits[0].id, cachedTranslation); }
    const b = batchForPage(doc, page); const n = nextBatch(doc, page);
    setStatus('pageStatus', text(`第 ${page} 页 · 当前批次 ${b.start}–${b.end}${n ? ` · 下一批 ${n.start}–${n.end}` : ''}`, `Page ${page} · batch ${b.start}–${b.end}${n ? ` · next ${n.start}–${n.end}` : ''}`));
    $('pageProgress').style.width = `${page / doc.totalPages * 100}%`; await repo.updateDocument({ ...doc, position: { page }, updatedAt: Date.now() }); renderContent(); renderBookmarks(doc); loadVoices();
    if (n && page >= b.end - 4) void batcher.ensure(doc, n.start).catch(error => setStatus('pageStatus', error.message, true));
  } catch (error) { setStatus('pageStatus', error.message, true); }
}

async function prepareTextDocument(doc) {
  syncQuickPager(null, 0);
  currentPdfPage = null; currentTranslation.clear(); currentUnits = await repo.getUnits(doc.id); const sourceLanguage = languageOf(doc.rawText, doc.sourceLanguage); for (const unit of currentUnits) { const cachedTranslation = sourceLanguage === 'en' ? await translation.readyText(unit, 'en', 'zh') : null; if (cachedTranslation) currentTranslation.set(unit.id, cachedTranslation); } $('readerTitle').textContent = doc.title; $('readerMeta').textContent = text(`${currentUnits.length} 个原始段落 · 翻译默认关闭`, `${currentUnits.length} original paragraphs · translation is off by default`); $('translateBtn').classList.toggle('hidden', sourceLanguage !== 'en'); $('showTranslation').checked = false; renderContent(); const savedUnit = currentUnits.find(unit => unit.order === doc.position?.unit); if (savedUnit) document.querySelector(`[data-unit="${CSS.escape(savedUnit.id)}"]`)?.scrollIntoView({ block: 'center' }); renderBookmarks(doc); speech.stop(); loadVoices();
}
function renderContent() {
  const show = $('showTranslation').checked; const lang = languageOf(currentUnits.map(u => u.text).join('\n'), current?.sourceLanguage); const hasText = currentUnits.some(unit => unit.text.trim());
  if (pageImageUrl) { URL.revokeObjectURL(pageImageUrl); pageImageUrl = null; }
  const image = currentPdfPage?.image && !hasText ? (pageImageUrl = URL.createObjectURL(currentPdfPage.image), `<img src="${pageImageUrl}" alt="${text('PDF 图片页','PDF image page')}" style="display:block;width:100%;max-height:68vh;object-fit:contain;border-radius:8px;margin-bottom:12px">`) : '';
  const body = hasText ? currentUnits.map(unit => { const translated = currentTranslation.get(unit.id); return `<div class="unit" data-unit="${escapeHtml(unit.id)}"><div class="page-text">${escapeHtml(unit.text)}</div>${show && translated ? `<div class="translation">${escapeHtml(translated)}</div>` : ''}</div>`; }).join('') : `<div class="hint">${text('这是图片页，没有可提取文字，暂时不能朗读。请翻到下一页。','This is an image-only page, so there is no text to read aloud. Turn to the next page.')}</div>`;
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
function loadVoices() { const sourceText = currentUnits.map(u => u.text).join('\n'); if (!sourceText.trim()) { $('voice').innerHTML = `<option>${text('图片页无可用音色','No voice needed for an image-only page')}</option>`; return; } const lang = languageOf(sourceText, current?.sourceLanguage); const voices = speech.voices(lang); $('voice').innerHTML = voices.length ? voices.map(v => `<option value="${escapeHtml(v.voiceURI)}">${escapeHtml(v.name)} (${escapeHtml(v.lang)})${v.localService ? ' · Local' : ''}</option>`).join('') : `<option>${text('未检测到匹配的本机音色','No matching local voice')}</option>`; const selected = speech.voice(lang); if (selected) $('voice').value = selected.voiceURI; }
function updateSpeechState({ state, error }) { setStatus('speechStatus', error || ({playing:text('朗读中','Playing'),paused:text('已暂停','Paused'),waiting:text('准备下一段','Preparing next'),stopped:text('已停止','Stopped'),error:text('朗读失败','Speech error')}[state] || state), Boolean(error)); document.querySelectorAll('.unit').forEach(el => el.classList.remove('playing')); }

async function init() {
  repo = await openDatabase(); await repo.migrateLegacy(bookId => { try { return JSON.parse(localStorage.getItem(`reader_notes:${bookId}`)); } catch { return null; } });
  const prefs = await repo.getPreference('tts') || { id: 'tts', voices: {}, rate: 1 }; const provider = new BrowserSpeechProvider();
  speech = new SpeechController(provider, { preferences: prefs.voices || {}, rate: prefs.rate || 1, onState: updateSpeechState, onHighlight: item => { document.querySelectorAll('.unit').forEach(el => el.classList.toggle('playing', el.dataset.unit === item?.unitId)); }, onPreference: value => { void repo.put('preferences', { id: 'tts', ...value }); } });
  translation = new TranslationController(repo, new BrowserTranslationProvider()); batcher = new BatchProcessor(repo, renderPdfPage);
  provider.onVoicesChanged(loadVoices); $('rate').value = speech.rate; $('rateValue').value = `${speech.rate}×`; loadVoices(); await loadLibrary(); applyLanguage();
}

$('langZh').onclick = () => { uiLanguage = 'zh'; localStorage.setItem('course-reader-ui', uiLanguage); applyLanguage(); void loadLibrary(); };
$('langEn').onclick = () => { uiLanguage = 'en'; localStorage.setItem('course-reader-ui', uiLanguage); applyLanguage(); void loadLibrary(); };
$('pdfTab').onclick = () => setTab('pdf'); $('textTab').onclick = () => setTab('text'); $('backHome').onclick = () => { speech.stop(); setScreen('home'); void loadLibrary(); };
$('importPdf').onclick = async () => { const file = $('pdfFile').files[0]; if (!file) return setStatus('pdfStatus', text('请选择 PDF 文件。','Choose a PDF file.'), true); try { $('importPdf').disabled = true; const data = await file.arrayBuffer(); const pdf = await pdfjsLib.getDocument({ data }).promise; const start = Math.min(pdf.numPages, Math.max(1, Number($('pdfStart').value) || 1)); current = await repo.importPdf({ blob: file, title: $('pdfTitle').value.trim() || file.name, totalPages: pdf.numPages, startPage: start }); pdfDocument = pdf; setStatus('pdfStatus', text('已保存，正在打开第一批…','Saved; opening the first batch…')); await openDocument(current.id); } catch (error) { setStatus('pdfStatus', error.message, true); } finally { $('importPdf').disabled = false; } };
$('saveText').onclick = async () => { try { const rawText = $('rawText').value; current = await repo.saveText({ title: $('textTitle').value.trim() || text('粘贴文字','Pasted text'), rawText, sourceLanguage: $('textLanguage').value }); await openDocument(current.id); } catch (error) { setStatus('textStatus', error.message, true); } };
$('prevPage').onclick = () => current?.type === 'pdf' && ensureAndShowPage(current, Number($('pageNumber').value) - 1); $('nextPage').onclick = () => current?.type === 'pdf' && ensureAndShowPage(current, Number($('pageNumber').value) + 1); $('pageNumber').onchange = () => current?.type === 'pdf' && ensureAndShowPage(current, $('pageNumber').value);
$('quickPrev').onclick = () => current?.type === 'pdf' && ensureAndShowPage(current, Number($('pageNumber').value) - 1); $('quickNext').onclick = () => current?.type === 'pdf' && ensureAndShowPage(current, Number($('pageNumber').value) + 1);
$('translateBtn').onclick = translateCurrent; $('retryBtn').onclick = translateCurrent; $('showTranslation').onchange = renderContent;
$('addBookmark').onclick = async () => { if (!current) return; const pageNum = current.type === 'pdf' ? Number($('pageNumber').value) : Number(current.position?.unit || 0); const bookmarks = [...(current.bookmarks || []).filter(mark => mark.pageNum !== pageNum), { pageNum, name: $('bookmarkName').value.trim() || text(`第 ${pageNum} 页`,`Page ${pageNum}`) }].sort((a,b) => a.pageNum - b.pageNum); current = await repo.updateDocument({ ...current, bookmarks }); renderBookmarks(current); $('bookmarkName').value = ''; };
$('play').onclick = () => { try { speech.play(currentSpeechQueue()); } catch (error) { setStatus('speechStatus', error.message, true); } }; $('pause').onclick = () => speech.state === 'paused' ? speech.resume() : speech.pause(); $('stop').onclick = () => speech.stop(); $('rate').oninput = event => { const value = Number(event.target.value); $('rateValue').value = `${value.toFixed(2)}×`; speech.changeSettings({ rate: value }); }; $('voice').onchange = event => { const lang = languageOf(currentUnits.map(u => u.text).join('\n'), current?.sourceLanguage); speech.changeSettings({ language: lang, voiceURI: event.target.value }); };

init().catch(error => { setStatus('pdfStatus', error.message, true); setStatus('textStatus', error.message, true); });
