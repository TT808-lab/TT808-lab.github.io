import { hashBytes, pageNumber, paragraphs, randomId } from './model.mjs';

export const DB_NAME = 'studyReaderDB';
export const DB_VERSION = 3;
const SCHEMA = {
  documents: 'id', sourceBlobs: 'documentId', pageCache: 'id', units: 'id',
  translations: 'id', jobs: 'id', preferences: 'id', migrations: 'id',
};
export const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export function openDatabase({ name = DB_NAME, onBlocked = () => {}, onVersionChange = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) {
        db.createObjectStore('pages', { keyPath: 'key' }).createIndex('bookId', 'bookId');
      }
      for (const [name, keyPath] of Object.entries(SCHEMA)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath });
          if (['sourceBlobs', 'pageCache', 'units', 'translations', 'jobs'].includes(name)) store.createIndex('documentId', 'documentId');
          if (name === 'documents') store.createIndex('sourceHash', 'sourceHash', { unique: false });
        }
      }
      if (db.objectStoreNames.contains('documents')) {
        const store = req.transaction.objectStore('documents');
        if (store.indexNames.contains('sourceHash')) store.deleteIndex('sourceHash');
        store.createIndex('sourceHash', 'sourceHash', { unique: false });
      }
      if (db.objectStoreNames.contains('sourceBlobs')) {
        const blobs = req.transaction.objectStore('sourceBlobs');
        if (!blobs.indexNames.contains('documentId')) blobs.createIndex('documentId', 'documentId');
      }
    };
    req.onblocked = onBlocked;
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); onVersionChange(); };
      resolve(new Repository(req.result));
    };
  });
}

export class Repository {
  constructor(db) { this.db = db; }
  close() { this.db.close(); }
  async transaction(names, mode, work) {
    const tx = this.db.transaction(names, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted.'));
      tx.onerror = () => reject(tx.error || new Error('Storage transaction failed.'));
    });
    // Observe immediately so an abort cannot cause an unhandled rejection.
    done.catch(() => {});
    try {
      const result = await work(tx);
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }
  get(store, id) { return this.transaction([store], 'readonly', tx => request(tx.objectStore(store).get(id))); }
  put(store, data) { return this.transaction([store], 'readwrite', tx => request(tx.objectStore(store).put(data))); }
  listDocuments() { return this.transaction(['documents'], 'readonly', tx => request(tx.objectStore('documents').getAll())); }
  getDocument(id) { return this.get('documents', id); }
  updateDocument(document) { return this.put('documents', { ...document, updatedAt: Date.now() }); }
  getPages(id) { return this.transaction(['pageCache'], 'readonly', tx => request(tx.objectStore('pageCache').index('documentId').getAll(id)).then(rows => rows.sort((a, b) => a.pageNum - b.pageNum))); }
  getUnits(id) { return this.transaction(['units'], 'readonly', tx => request(tx.objectStore('units').index('documentId').getAll(id)).then(rows => rows.sort((a, b) => a.order - b.order))); }
  getPreference(id) { return this.get('preferences', id); }
  async deleteDocument(id) {
    return this.transaction(['documents', 'sourceBlobs', 'pageCache', 'units', 'translations', 'jobs'], 'readwrite', async tx => {
      const stores = ['sourceBlobs', 'pageCache', 'units', 'translations', 'jobs'];
      for (const name of stores) {
        const store = tx.objectStore(name);
        const keyPath = name === 'sourceBlobs' ? 'documentId' : 'documentId';
        const rows = await request(store.index('documentId').getAll(id));
        for (const row of rows) store.delete(row[name === 'pageCache' ? 'id' : name === 'sourceBlobs' ? 'documentId' : 'id']);
      }
      tx.objectStore('documents').delete(id);
    });
  }
  countPages(id) { return this.transaction(['pageCache'], 'readonly', tx => request(tx.objectStore('pageCache').index('documentId').count(id))); }
  getPage(id, number) { return this.get('pageCache', `${id}:${number}`); }
  updatePage(documentId, pageNum, patch) {
    const id = `${documentId}:${pageNum}`;
    return this.transaction(['pageCache'], 'readwrite', async tx => {
      const store = tx.objectStore('pageCache'); const page = await request(store.get(id));
      if (!page) throw new Error(`Page ${pageNum} is not cached.`);
      store.put({ ...page, ...patch, id, documentId, pageNum }); return { ...page, ...patch, id, documentId, pageNum };
    });
  }

  async importPdf({ blob, title, totalPages, startPage }) {
    pageNumber(totalPages, undefined);
    const anchor = pageNumber(startPage, 1, totalPages);
    const sourceHash = await hashBytes(await blob.arrayBuffer());
    return this.transaction(['documents', 'sourceBlobs'], 'readwrite', async tx => {
      const docs = tx.objectStore('documents');
      const existing = await request(docs.index('sourceHash').get(sourceHash));
      if (existing) {
        // Same bytes reuse the document and preserve its existing reading anchor.
        tx.objectStore('sourceBlobs').put({ documentId: existing.id, blob, sourceHash });
        return existing;
      }
      const document = { id: randomId(), title, type: 'pdf', totalPages, anchor, sourceHash,
        sourceLanguage: 'auto', createdAt: Date.now(), updatedAt: Date.now(), position: { page: anchor }, bookmarks: [] };
      docs.add(document);
      tx.objectStore('sourceBlobs').add({ documentId: document.id, blob, sourceHash });
      return document;
    });
  }

  async saveText({ title, rawText, sourceLanguage = 'auto' }) {
    if (!rawText.trim()) throw new Error('Text cannot be empty.');
    const id = randomId();
    const document = { id, title, type: 'text', rawText, sourceLanguage, createdAt: Date.now(), updatedAt: Date.now(), bookmarks: [], position: { unit: 0 } };
    const blocks = paragraphs(rawText);
    return this.transaction(['documents', 'units'], 'readwrite', tx => {
      tx.objectStore('documents').add(document);
      for (const block of blocks) tx.objectStore('units').add({ ...block, id: `${id}:text:${block.order}`, documentId: id });
      return document;
    });
  }

  async migrateLegacy(readNotes = () => null) {
    const books = await this.transaction(['books'], 'readonly', tx => request(tx.objectStore('books').getAll()));
    for (const book of books) {
      const documentId = `legacy:${book.id}`;
      let notes;
      try { notes = readNotes(book.id); } catch { notes = null; }
      await this.transaction(['books', 'pages', 'documents', 'pageCache', 'migrations'], 'readwrite', async tx => {
        if (await request(tx.objectStore('migrations').get(book.id))) return;
        const document = { id: documentId, legacyBookId: book.id, title: book.title, type: 'pdf',
          totalPages: null, anchor: null, cachedMax: 0, sourceLanguage: 'auto', updatedAt: book.updatedAt || 0,
          position: { page: Number.isInteger(notes?.lastPage) ? notes.lastPage : null },
          bookmarks: Array.isArray(notes?.bookmarks) ? notes.bookmarks.filter(m => Number.isInteger(m.pageNum) && typeof m.name === 'string') : [],
          needsSource: true };
        await new Promise((resolve, reject) => {
          const cursor = tx.objectStore('pages').index('bookId').openCursor(IDBKeyRange.only(book.id));
          cursor.onerror = () => reject(cursor.error);
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return resolve();
            const page = row.value;
            document.cachedMax = Math.max(document.cachedMax, page.pageNum);
            document.anchor = document.anchor === null ? page.pageNum : Math.min(document.anchor, page.pageNum);
            tx.objectStore('pageCache').put({ id: `${documentId}:${page.pageNum}`, documentId, pageNum: page.pageNum,
              image: page.image, text: page.text, status: 'ready', extractionVersion: 'legacy-v1' });
            row.continue();
          };
        });
        document.position.page ??= document.anchor;
        tx.objectStore('documents').add(document);
        tx.objectStore('migrations').add({ id: book.id, documentId, version: 1, status: 'ready' });
      });
    }
  }

  // A completed mapping is the sole authority. Unmigrated records retain v1 reads.
  async legacyAuthority(bookId) {
    const migration = await this.get('migrations', bookId);
    return migration?.status === 'ready' ? { store: 'pageCache', documentId: migration.documentId } : { store: 'pages', bookId };
  }

  async claimBatch(batch, owner, now = Date.now(), leaseMs = 60000) {
    return this.transaction(['jobs'], 'readwrite', async tx => {
      const store = tx.objectStore('jobs');
      const old = await request(store.get(batch.id));
      if (old?.status === 'ready') return { state: 'ready', job: old };
      if (old?.status === 'running' && old.leaseUntil > now) return { state: 'busy', job: old };
      const job = { ...batch, status: 'running', owner, attempt: (old?.attempt || 0) + 1,
        leaseUntil: now + leaseMs, error: null };
      store.put(job);
      return { state: 'claimed', job };
    });
  }
  async commitPage(batch, owner, page, now = Date.now()) {
    return this.transaction(['jobs', 'pageCache'], 'readwrite', async tx => {
      const job = await request(tx.objectStore('jobs').get(batch.id));
      if (!job || job.owner !== owner || job.status !== 'running' || job.leaseUntil <= now) throw new Error('Batch lease lost.');
      if (!Number.isInteger(page.pageNum) || page.pageNum < batch.start || page.pageNum > batch.end || !(page.image instanceof Blob)) throw new Error('Invalid rendered page.');
      const id = `${batch.documentId}:${page.pageNum}`;
      if (!await request(tx.objectStore('pageCache').get(id))) {
        tx.objectStore('pageCache').add({ ...page, id, documentId: batch.documentId, status: 'ready' });
      }
      tx.objectStore('jobs').put({ ...job, leaseUntil: now + 60000 });
    });
  }
  async finishBatch(batch, owner) {
    return this.transaction(['jobs', 'pageCache'], 'readwrite', async tx => {
      const job = await request(tx.objectStore('jobs').get(batch.id));
      if (job?.owner !== owner || job.status !== 'running' || job.leaseUntil <= Date.now()) throw new Error('Batch lease lost.');
      for (let number = batch.start; number <= batch.end; number++) {
        const page = await request(tx.objectStore('pageCache').get(`${batch.documentId}:${number}`));
        if (page?.status !== 'ready') throw new Error(`Page ${number} is missing.`);
      }
      tx.objectStore('jobs').put({ ...job, status: 'ready', leaseUntil: 0 });
    });
  }
  async failBatch(batch, owner, error, cancelled = false) {
    return this.transaction(['jobs'], 'readwrite', async tx => {
      const store = tx.objectStore('jobs');
      const job = await request(store.get(batch.id));
      if (job?.owner === owner && job.status === 'running') store.put({ ...job, status: cancelled ? 'cancelled' : 'failed', error: String(error.message || error), leaseUntil: 0 });
    });
  }
}
