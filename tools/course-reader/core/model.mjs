export const BATCH_SIZE = 30;
export const PREFETCH_DISTANCE = 5;

export function pageNumber(value, fallback, total = Number.MAX_SAFE_INTEGER) {
  if (value === '' || value === undefined || value === null) value = fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > total) {
    throw new RangeError('Page must be an integer within the PDF.');
  }
  return number;
}

// Negative indices cover pages before the chosen starting page, without moving it.
export function batchForPage(document, page) {
  const total = pageNumber(document.totalPages, undefined);
  const anchor = pageNumber(document.anchor, 1, total);
  pageNumber(page, undefined, total);
  const index = Math.floor((page - anchor) / BATCH_SIZE);
  const start = Math.max(1, anchor + index * BATCH_SIZE);
  const end = Math.min(total, anchor + (index + 1) * BATCH_SIZE - 1);
  return { id: `${document.id}:batch:${anchor}:${index}`, documentId: document.id, index, anchor, start, end };
}

export function nextBatch(document, page) {
  const batch = batchForPage(document, page);
  if (batch.end === document.totalPages || page < batch.end - PREFETCH_DISTANCE + 1) return null;
  return batchForPage(document, batch.end + 1);
}

export async function hashBytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export async function hashText(text) {
  return hashBytes(new TextEncoder().encode(text));
}

export function paragraphs(rawText) {
  // Keep raw text separately; offsets point into that exact string, including CRLF.
  const result = [];
  const breaks = /(?:\r\n|\r(?!\n)|(?<!\r)\n)[\t ]*(?:(?:\r\n|\r(?!\n)|(?<!\r)\n)[\t ]*)+/g;
  let start = 0;
  for (const match of rawText.matchAll(breaks)) {
    if (match.index > start) result.push({ order: result.length, start, end: match.index, text: rawText.slice(start, match.index) });
    start = match.index + match[0].length;
  }
  if (start < rawText.length) result.push({ order: result.length, start, end: rawText.length, text: rawText.slice(start) });
  return result.filter(p => p.text.trim());
}

export function sentences(text, language) {
  if (!text.trim()) return [];
  const segmenter = new Intl.Segmenter(language === 'zh' ? 'zh' : 'en', { granularity: 'sentence' });
  return Array.from(segmenter.segment(text), s => ({ text: s.segment, start: s.index, end: s.index + s.segment.length }));
}

export function translationKey(unitId, sourceHash, sourceLanguage, targetLanguage, providerVersion) {
  return JSON.stringify([unitId, sourceHash, sourceLanguage, targetLanguage, providerVersion]);
}
