// sync.js — the only network action (Track B Phase 4). "Sync now" = pull the snapshot (+ prune the
// durable buffer on ack) then push the device's append-only files. ORDER MATTERS (critique blocking
// #1): per day, the journal-<day>.md (verbatim prose) is PUT BEFORE events-<day>.ndjson, so the
// words are on origin before the journal_field_set events that ack them can be folded — otherwise a
// crash/offline/409 between the two commits could let the phone prune an entry whose words never
// landed. Per-day scoped (critique blocking #2): a multi-day-offline buffer writes one file per day.
// Each PUT is one commit touching ONLY surface/inbox/<device>/{events,journal} so the Mac's
// validate_phone_commits.py always accepts it.

import * as db from "./db.js";
import { getFile, putFile, getJson } from "./github.js";
import { getConfig } from "./secrets.js";
import { pruneAcked, prunableProseDays } from "./reducer.js";
import { renderStaging, hasAnyPresent } from "./journal_staging.js";
import { serializeEvent } from "./events.js";

const SNAPSHOT_PATH = "surface/snapshot/today.json";
const inboxPath = (dev, name) => `surface/inbox/${dev}/${name}`;

export async function getCachedSnapshot() { return db.get("snapshot", "current"); }

// STEP A — pull + reconcile. Offline here is a SKIP (never a false prune).
export async function pull() {
  const { json } = await getJson(SNAPSHOT_PATH);
  if (json) { await db.put("snapshot", json, "current"); await reconcileAck(json); }
  return json;
}

async function reconcileAck(snapshot) {
  const { device } = await getConfig();
  const lastSeen = (await db.meta.get("lastSeenAck")) || 0;
  const rows = await db.allEvents();
  const events = rows.map((r) => r.event);
  const { kept, newLastSeen } = pruneAcked(events, snapshot.ack, device, lastSeen);
  if (newLastSeen !== lastSeen) await db.meta.set("lastSeenAck", newLastSeen);
  const keptIds = new Set(kept.map((e) => e.id));
  for (const r of rows) if (!keptIds.has(r.event.id)) await db.deleteEvent(r.key);
  // Prose is safe to drop ONLY when the day has NO un-acked event of ANY type left — exactly the
  // condition under which the day also drops out of push()'s day-set, so no later empty-body PUT can
  // fire. Gating on journal events alone (the prior bug) let an orphan task_done stall the ack cursor
  // while the journal seq pruned, after which push re-PUT an EMPTY journal over the real words and the
  // fold byte-copied the blank file — silent prose loss. Keep prose while ANY event for the day lives,
  // plus while a dirty (un-PUT) edit remains. (Security review must-fix #1.)
  const prose = await db.allProse();
  for (const day of prunableProseDays(kept, prose)) await db.deleteProseForDay(day);
}

// STEP B — push per day, prose first. Returns { pushedDays, errors }.
async function push() {
  const { device } = await getConfig();
  const snapshot = await getCachedSnapshot();
  const schema = snapshot && snapshot.journal_schema;
  const rows = await db.allEvents();
  const prose = await db.allProse();
  const everPut = new Set((await db.meta.get("journalPutDays")) || []);

  const days = [...new Set([
    ...rows.map((r) => r.day).filter(Boolean),
    ...prose.filter((p) => p.dirty).map((p) => p.day),
  ])].sort();

  const errors = [];
  let pushedDays = 0;
  for (const day of days) {
    try {
      // 1) JOURNAL (prose) FIRST.
      if (schema) {
        const fv = proseFvFor(prose, day);
        const present = hasAnyPresent(schema, fv);
        if (present || everPut.has(day)) {
          const body = renderStaging(schema, fv, day);
          const path = inboxPath(device, `journal-${day}.md`);
          const cur = await getFile(path);
          if (cur.text !== body) await putFile(path, body, cur.sha, `surface(${device}): journal ${day}`);
          everPut.add(day);
          await db.clearProseDirty(day);
        }
      }
      // 2) EVENTS second — append-only, id-substring dedupe against a FRESH GET (idempotent even
      //    if a prior PUT landed but its ack/prune did not).
      const dayRows = rows.filter((r) => r.day === day);
      if (dayRows.length) {
        const path = inboxPath(device, `events-${day}.ndjson`);
        const cur = await getFile(path);
        const fresh = dayRows.filter((r) => !cur.text.includes(`"id":"${r.event.id}"`));
        if (fresh.length) {
          const body = cur.text + fresh.map((r) => serializeEvent(r.event)).join("");
          await putFile(path, body, cur.sha, `surface(${device}): events ${day}`);
        }
        for (const r of dayRows) await db.markSynced(r.key);
      }
      pushedDays++;
    } catch (e) {
      errors.push({ day, code: e.code || "error", message: String(e.message || e) });
    }
  }
  await db.meta.set("journalPutDays", [...everPut]);
  return { pushedDays, errors };
}

function proseFvFor(proseRows, day) {
  const out = {};
  for (const p of proseRows) if (p.day === day) (out[p.section] || (out[p.section] = {}))[p.field] = p.value;
  return out;
}

// The public "Sync now": pull (+prune) then push. "synced" requires actually FINDING the snapshot
// (a 404 — wrong repo/branch — returns null, which must NOT read as a clean sync).
export async function syncNow() {
  let snapshot = null, pulled = true;
  try { snapshot = await pull(); } catch (e) { pulled = false; if (e.code !== "offline") throw e; }
  const { pushedDays, errors } = await push();
  const synced = pulled && !!snapshot && errors.length === 0;
  if (synced) await db.meta.set("lastSynced", Date.now());
  const unsynced = (await db.allEvents()).length;
  return { ok: synced, pulled, snapshotFound: !!snapshot, pushedDays, errors, unsynced, snapshot };
}

export async function lastSynced() { return (await db.meta.get("lastSynced")) || 0; }
