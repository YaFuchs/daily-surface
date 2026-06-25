// db.js — IndexedDB wrapper (Track B Phase 4). Promise-based, zero deps. The on-device durable
// store: the append-only event outbox, the verbatim journal-prose buffer, the cached snapshot, and
// app meta (device, seq counter, ack high-water, last-synced, repo config, "days ever PUT").
// The PAT lives in its OWN store (secrets.js) so only that module ever reads the token.

const DB_NAME = "daily-surface";
const DB_VERSION = 1;

let _dbp = null;
export function openDB() {
  if (_dbp) return _dbp;
  _dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("outbox")) {
        const o = db.createObjectStore("outbox", { keyPath: "key" }); // key = device:zero-padded-seq
        o.createIndex("by_day", "day");
        o.createIndex("by_synced", "synced");
      }
      if (!db.objectStoreNames.contains("journal_prose")) {
        db.createObjectStore("journal_prose", { keyPath: "key" });     // key = day::section::field
      }
      if (!db.objectStoreNames.contains("snapshot")) db.createObjectStore("snapshot");
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("secrets")) db.createObjectStore("secrets");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbp;
}

function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function get(store, key) {
  const db = await openDB();
  return reqP(db.transaction(store, "readonly").objectStore(store).get(key));
}
export async function getAll(store) {
  const db = await openDB();
  return reqP(db.transaction(store, "readonly").objectStore(store).getAll());
}
export async function put(store, value, key) {
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  return new Promise((res, rej) => { tx.oncomplete = () => res(value); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
export async function del(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
export const meta = {
  get: (k) => get("meta", k),
  set: (k, v) => put("meta", v, k),
};

// padSeq makes the outbox key sort chronologically (string compare).
export const padSeq = (n) => String(n).padStart(12, "0");

// appendEvent — assigns the monotonic per-device seq AND stores the event in ONE atomic
// readwrite txn. buildEvent(seq) MUST be synchronous (events.js builders + crypto + Date all
// are): an awaited non-IDB call here would let the txn auto-commit early and two rapid taps could
// reuse a seq (critique nice-to-have). The outbox row keeps the event durably until it is acked.
export async function appendEvent(device, buildEvent) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["meta", "outbox"], "readwrite");
    const metaStore = tx.objectStore("meta");
    const r = metaStore.get("seqCounter");
    r.onsuccess = () => {
      const seq = (r.result || 0) + 1;
      let event;
      try { event = buildEvent(seq); } catch (e) { tx.abort(); reject(e); return; }
      metaStore.put(seq, "seqCounter");
      tx.objectStore("outbox").put({ key: `${device}:${padSeq(seq)}`, day: event.day, synced: 0, event });
      tx.oncomplete = () => resolve(event);
    };
    r.onerror = () => reject(r.error);
    tx.onabort = () => reject(tx.error || new Error("txn aborted"));
  });
}

export async function allEvents() {
  const rows = await getAll("outbox");
  rows.sort((a, b) => (a.event.seq || 0) - (b.event.seq || 0));
  return rows;
}
export async function markSynced(key) {
  const row = await get("outbox", key);
  if (row) { row.synced = 1; await put("outbox", row); }
}
export async function deleteEvent(key) { await del("outbox", key); }

// journal prose (verbatim words; the DEC-015 staging channel, never an event). `dirty` = changed
// since the day's staging was last PUT; prose is only pruned when clean AND its events have acked,
// so a journal edit can never be dropped before it reaches origin (durability).
export async function setProse(day, section, field, value) {
  await put("journal_prose", { key: `${day}::${section}::${field}`, day, section, field, value, dirty: true });
}
export async function allProse() { return getAll("journal_prose"); }
export async function clearProseDirty(day) {
  const rows = await allProse();
  for (const r of rows) if (r.day === day && r.dirty) { r.dirty = false; await put("journal_prose", r); }
}
export async function deleteProseForDay(day) {
  const rows = await allProse();
  for (const r of rows) if (r.day === day) await del("journal_prose", r.key);
}
