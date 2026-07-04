// events.js — pure event-mint layer (Daily Surface, Track B Phase 4). Zero deps; runs in
// the browser AND in Node (for the contract tests). Produces the EXACT NDJSON bytes the
// Mac's fold.py consumes — the frozen wire contract in surface/README.md / DEC-018.
//
// Every builder is PURE: it takes a `ctx` ({device, seq, day, now:Date, rand4:string}) so the
// timestamp, seq, and id-nonce are injectable and the output is byte-deterministic under test.
// outbox.js supplies the real ctx (atomic seq, Date now, crypto rand4).
//
// DEC-015 chokepoint: journalFieldSet() builds an object with a FIXED key set
// {…envelope…, section, field, present} and NOTHING else — prose can never enter an event here.

export const SCHEMA_V = 1;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;          // mirrors fold.py _DAY_RE
export const TASKID_RE = /^[0-9a-z]{6}$/;             // mirrors fold.py _TASKID_RE
export const EVTID_RE = /^[A-Za-z0-9._:-]{1,80}$/;    // mirrors fold.py _EVTID_RE (DEC-032/039)

const pad = (n) => String(n).padStart(2, "0");

// ISO-8601 LOCAL time, SECONDS precision, with offset (e.g. 2026-07-01T06:41:12+03:00).
// NOT Date.toISOString() (that is UTC-Z). fold.read_events sorts by str(ts); the retro reads
// local wall-clock. ms precision lives only inside the id.
export function formatLocalOffset(d) {
  const off = -d.getTimezoneOffset();                 // minutes east of UTC
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// evt_<ISO-UTC-ms with trailing Z>_<4 lowercase hex> — matches the README worked example
// byte-for-byte. Time-prefixed so lexicographic sort == chronological. The id is the fold's
// per-event idempotency marker (the <!--evt:id--> comment).
export function mintId(now, rand4) {
  return `evt_${now.toISOString()}_${rand4}`;
}

export function idemKey(type, subject, day) {
  return `${type}:${subject}:${day}`;
}

// The common envelope, keys in the pinned order (golden-test stability; fold parses by key).
function envelope(type, ctx, idemSubject) {
  return {
    v: SCHEMA_V,
    id: mintId(ctx.now, ctx.rand4),
    type,
    ts: formatLocalOffset(ctx.now),
    seq: ctx.seq,
    device: ctx.device,
    day: ctx.day,
    idem: idemKey(type, idemSubject, ctx.day),
  };
}

// ---- the six verbs (exact fields fold.py consumes) -----------------------------------------

export function taskDone(ctx, { task_id, ref_evt }) {
  // DEC-039: exactly one address — a minted 6-char task_id, OR ref_evt (the origin task_added
  // event's own id) so a just-captured task is completable before the Mac ever mints its id.
  if (task_id != null && ref_evt != null) throw new Error("taskDone: pass task_id OR ref_evt, not both");
  if (ref_evt != null) {
    if (!EVTID_RE.test(String(ref_evt))) throw new Error(`taskDone: bad ref_evt ${ref_evt}`);
    return { ...envelope("task_done", ctx, ref_evt), ref_evt };
  }
  if (!TASKID_RE.test(String(task_id || ""))) throw new Error(`taskDone: bad task_id ${task_id}`);
  return { ...envelope("task_done", ctx, task_id), task_id };
}

export function taskDeferred(ctx, { task_id, when }) {
  if (!TASKID_RE.test(String(task_id || ""))) throw new Error(`taskDeferred: bad task_id ${task_id}`);
  if (!DAY_RE.test(String(when || ""))) throw new Error(`taskDeferred: when must be YYYY-MM-DD, got ${when}`);
  return { ...envelope("task_deferred", ctx, task_id), task_id, when };
}

export function taskAdded(ctx, { text, project = "inbox" }) {
  // No natural dedupe subject for free text (re-adding the same text is a real second item) ->
  // the id-nonce is the subject. Text is NOT pre-escaped here; fold._sanitize_freetext owns
  // that (double-escaping would corrupt). Just reject empty.
  if (!String(text || "").trim()) throw new Error("taskAdded: empty text");
  return { ...envelope("task_added", ctx, ctx.rand4), text, project };
}

export function noteAdded(ctx, { text }) {
  if (!String(text || "").trim()) throw new Error("noteAdded: empty text");
  return { ...envelope("note_added", ctx, ctx.rand4), text };
}

// DEC-015 CHOKEPOINT: present is the ONLY content. NO value/text/prose key, ever. The verbatim
// words travel exclusively in the journal staging file (journal_staging.js).
export function journalFieldSet(ctx, { section, field, present }) {
  const subject = `${slug(section)}.${slug(field)}`;
  return {
    ...envelope("journal_field_set", ctx, subject),
    section: String(section),
    field: String(field),
    present: !!present,
  };
}

export function dayClosed(ctx, { plan_date }) {
  if (!DAY_RE.test(String(plan_date || ""))) throw new Error(`dayClosed: plan_date must be YYYY-MM-DD, got ${plan_date}`);
  return { ...envelope("day_closed", ctx, ctx.day), plan_date };
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^0-9a-z]+/g, "-").replace(/^-+|-+$/g, "") || "_";
}

// One NDJSON line per event (append-only). UTF-8; Hebrew rides literal inside the JSON.
export function serializeEvent(evt) {
  return JSON.stringify(evt) + "\n";
}

// tomorrow(planDay) = planDay + 1 calendar day, computed from the LOGICAL plan-day string
// (not wall-clock), so a late-night close still plans the correct tomorrow.
export function addDays(dayStr, n) {
  const [y, m, d] = dayStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);              // local-time calendar arithmetic
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
