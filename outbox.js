// outbox.js — the single entry point for every mutation (Track B Phase 4). Each tap becomes an
// append-only event written to IndexedDB FIRST (the phone is an outbox, never a second truth);
// the UI re-renders optimistically off the reducer; sync flushes later. Sole writer of the outbox.

import * as db from "./db.js";
import {
  taskDone, taskDeferred, taskAdded, noteAdded, journalFieldSet, dayClosed, TASKID_RE, EVTID_RE,
} from "./events.js";
import { isPresent } from "./journal_staging.js";

const BUILDERS = {
  task_done: taskDone, task_deferred: taskDeferred, task_added: taskAdded,
  note_added: noteAdded, journal_field_set: journalFieldSet, day_closed: dayClosed,
};

function rand4() {
  const a = new Uint8Array(2);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function device() {
  return (await db.meta.get("device")) || "phone-yair";
}

// emit(type, fields, day) -> the stored event. day = the current plan-day (snapshot.plan.date).
export async function emit(type, fields, day) {
  const builder = BUILDERS[type];
  if (!builder) throw new Error(`unknown verb ${type}`);
  // HARD invariant (critique should-fix): never mint a task event with no valid address —
  // fold would orphan it, never ack it, and WEDGE the device watermark forever (DEC-019 trade-off).
  // task_done may alternatively address the ORIGIN task_added event (ref_evt, DEC-039) — that
  // references our own prior event, which the fold files before the done ever applies.
  if (type === "task_deferred" && !TASKID_RE.test(String(fields.task_id || ""))) {
    throw new Error(`refusing to ${type}: this task has no stable id yet (sync first)`);
  }
  if (type === "task_done") {
    const byRef = fields.ref_evt != null;
    if (byRef ? !EVTID_RE.test(String(fields.ref_evt)) : !TASKID_RE.test(String(fields.task_id || ""))) {
      throw new Error("refusing to task_done: no valid task_id or ref_evt address");
    }
  }
  const dev = await device();
  return db.appendEvent(dev, (seq) =>
    builder({ device: dev, seq, day, now: new Date(), rand4: rand4() }, fields));
}

// Journal: store the verbatim words keyed by the schema field KEY (so renderStaging finds them),
// and emit the present/absent FLAG — carrying the field LABEL (which fold renders into the presence
// ledger) — only when present actually flips. The words and the flag live in different files
// (DEC-015). present uses the SAME predicate as renderStaging, so the flag and bullet never disagree.
// Returns true iff a present-flip emitted an event (so the caller can refresh ONLY the header chip
// and never tear down the focused textarea — security review must-fix #2).
export async function setJournalField(day, section, field, value) {
  const present = isPresent(field.type, value);
  await db.setProse(day, section.name, field.key, value);     // verbatim words -> staging buffer (by KEY)
  const prev = await lastPresent(day, section.name, field.label);
  if (prev !== present) {
    await emit("journal_field_set", { section: section.name, field: field.label, present }, day);
    return true;
  }
  return false;
}

async function lastPresent(day, sectionName, fieldLabel) {
  const rows = await db.allEvents();
  let v = false;
  for (const r of rows) {
    const e = r.event;
    if (e.type === "journal_field_set" && e.day === day && e.section === sectionName && e.field === fieldLabel) v = !!e.present;
  }
  return v;
}

// -> { [sectionName]: { [fieldKey]: value } } scoped to ONE day, ready for renderStaging.
export async function proseFv(day) {
  const rows = await db.allProse();
  const out = {};
  for (const r of rows) if (r.day === day) (out[r.section] || (out[r.section] = {}))[r.field] = r.value;
  return out;
}
