import { batchForPage, hashBytes } from './model.mjs';

export class BatchProcessor {
  constructor(repository, renderPage) {
    this.repository = repository;
    this.renderPage = renderPage;
    this.inflight = new Map();
  }
  ensure(document, page, { signal } = {}) {
    const batch = batchForPage(document, page);
    if (this.inflight.has(batch.id)) return this.inflight.get(batch.id);
    const promise = this.run(document, batch, signal).finally(() => this.inflight.delete(batch.id));
    this.inflight.set(batch.id, promise);
    return promise;
  }
  async run(document, batch, signal) {
    const owner = crypto.randomUUID();
    const claim = await this.repository.claimBatch(batch, owner);
    if (claim.state !== 'claimed') return claim;
    try {
      let source;
      for (let page = batch.start; page <= batch.end; page++) {
        signal?.throwIfAborted();
        if (await this.repository.getPage(document.id, page)) continue;
        if (!source) {
          source = await this.repository.get('sourceBlobs', document.id);
          if (!source?.blob || !document.sourceHash) throw new Error('Original PDF required. Reconnect the source file.');
          if (await hashBytes(await source.blob.arrayBuffer()) !== document.sourceHash) throw new Error('Source PDF does not match this document.');
        }
        const rendered = await this.renderPage(source.blob, page, signal);
        signal?.throwIfAborted();
        await this.repository.commitPage(batch, owner, { ...rendered, pageNum: page });
      }
      await this.repository.finishBatch(batch, owner);
      return { state: 'ready' };
    } catch (error) {
      await this.repository.failBatch(batch, owner, error, signal?.aborted);
      throw error;
    }
  }
}

// Old v1 has no total-page metadata or source hash: no title-only relinking.
export async function verifyLegacySource(cachedPages, candidateTotal, readCandidateText) {
  const normalize = text => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const eligible = cachedPages.filter(p => normalize(p.text || '').length >= 24).sort((a, b) => a.pageNum - b.pageNum);
  if (eligible.length < 3 || cachedPages.some(p => p.pageNum > candidateTotal)) return false;
  // Compare every informative cached page; insufficient evidence means import as new.
  for (const page of eligible) {
    if (normalize(page.text) !== normalize(await readCandidateText(page.pageNum))) return false;
  }
  return true;
}
