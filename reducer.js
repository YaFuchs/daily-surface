// reducer.js — the pure overlay + the ack prune (Track B Phase 4). No IndexedDB, no network.
//
// reduce(snapshot, localEvents): the current-state VIEW = the authoritative snapshot OVERLAID with
// this device's own un-acked local events (a tapped-done task shows done immediately; a deferral
// shows deferred; added tasks/notes show as pending). The phone is an outbox, not a second truth —
// the snapshot wins for anything already folded+acked; local events only overlay until acked.
//
// pruneAcked(...): the durable-buffer gate. The phone keeps every event until its seq is acked
// (processed_seq) in a pulled snapshot, then prunes. FAIL-SAFE to the letter of the README ack
// reader contract / render_snapshot.build_ack / SECURITY.md #9: a missing ack, an unknown device,
// a non-integer, or a REGRESSED processed_seq => prune NOTHING. Only ever prune by (device, seq).

export function reduce(snapshot, localEvents) {
  const tasks = (snapshot.tasks || []).map((t) => ({ ...t }));
  const byId = new Map(tasks.filter((t) => t.id).map((t) => [t.id, t]));
  const addedTasks = [];
  const notes = [];
  const journalPresence = {};            // section -> { field -> present } (LWW by seq)
  let closed = false;
  let closedDay = null;                  // which day the un-acked day_closed belongs to (DEC-038)

  const ordered = [...localEvents].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  for (const e of ordered) {
    switch (e.type) {
      case "task_done": {
        // DEC-039: a completion may address the ORIGIN task_added event (ref_evt) instead of a
        // minted id. Prefer the still-pending local add row (same batch, the common case); else
        // the snapshot task that materialized from that add (joined via tasks[].origin) — so a
        // ref-done emitted offline still shows done after the add syncs, folds, and re-appears
        // with a real id. _doneSeq maps the completion to its outbox row for the DEC-023b undo.
        if (e.ref_evt) {
          const row = addedTasks.find((a) => a.evtId === e.ref_evt);
          if (row) { row.done = true; row._doneSeq = e.seq; break; }
          const t = tasks.find((x) => x.origin && x.origin === e.ref_evt);
          if (t) { t.status = "done"; t._localPending = true; t._doneSeq = e.seq; }
          break;
        }
        const t = byId.get(e.task_id);
        // _doneSeq lets the app map this completion to its outbox row, so an un-synced "done"
        // can be undone before it reaches the Mac (DEC-023b — drop the task_done event).
        if (t) { t.status = "done"; t._localPending = true; t._doneSeq = e.seq; }
        break;
      }
      case "task_deferred": {
        const t = byId.get(e.task_id);
        if (t) { t.status = "deferred"; t.deferredTo = e.when; t._localPending = true; }
        break;
      }
      case "task_added":
        // seq lets the app map this overlay back to its outbox row (key + sync state) so an
        // un-synced add can be cancelled locally before it reaches the Mac (db.deleteEvent).
        // evtId (the event's own id) is the row's DEC-039 address: a later task_done{ref_evt}
        // marks it done here, and the fold joins on the same id via the filed <!--evt:--> marker.
        addedTasks.push({ text: e.text, project: e.project, ts: e.ts, seq: e.seq, evtId: e.id, _pending: true });
        break;
      case "note_added":
        notes.push({ text: e.text, ts: e.ts, seq: e.seq, _pending: true });
        break;
      case "journal_field_set":
        (journalPresence[e.section] || (journalPresence[e.section] = {}))[e.field] = !!e.present;
        break;
      case "day_closed":
        closed = true;
        closedDay = e.day || null;
        break;
      default:
        break;
    }
  }
  return { plan: snapshot.plan, tasks, addedTasks, notes, journalPresence, closed, closedDay,
           today: Array.isArray(snapshot.today) ? snapshot.today : [] };  // Phase 2: plan-selected focus ids (DEC-021 §6)
}

// computeScoreboard(view): the Daily Scoreboard numbers for the close-the-day recap (DEC-038).
// Pure and display-only — counts the plan-committed ids (view.today) against the overlaid task
// state at THIS moment: "done" = the local task_done overlay (the snapshot itself never carries
// done tasks — DEC-023); everything else — open, deferred, or missing from tasks[] — still rolls.
// Null when the plan committed no tracked tasks that day, so the UI stays quiet.
export function computeScoreboard(view) {
  const ids = (view && Array.isArray(view.today)) ? view.today : [];
  if (!ids.length) return null;
  const byId = new Map(((view && view.tasks) || []).filter((t) => t.id).map((t) => [t.id, t]));
  let done = 0;
  for (const id of ids) { const t = byId.get(id); if (t && t.status === "done") done++; }
  return { committed: ids.length, done, rolls: ids.length - done };
}

// One phrasing for the scoreboard everywhere (header chip + the close-confirm dialog). Lives here
// beside the numbers so the contract tests cover copy + counts together; ui/app import it.
export function scoreboardText(s) {
  if (!s) return null;
  if (s.rolls === 0) return `All ${s.committed} committed done ✓`;
  return `${s.done} of ${s.committed} committed done${s.done ? " ✓" : ""} · ${s.rolls} roll${s.rolls === 1 ? "s" : ""} to tomorrow`;
}

// Returns { kept, newLastSeen }. lastSeen is a persisted per-device high-water that only advances.
export function pruneAcked(localEvents, ack, device, lastSeen) {
  const keepAll = { kept: localEvents, newLastSeen: lastSeen };
  if (!ack || typeof ack !== "object" || !ack.devices) return keepAll;
  const entry = ack.devices[device];
  if (!entry) return keepAll;                                   // device not yet acked
  const ps = entry.processed_seq;
  if (!Number.isInteger(ps)) return keepAll;                    // malformed
  if (ps < lastSeen) return keepAll;                            // REGRESSED -> never prune
  const kept = localEvents.filter(
    (e) => !(e.device === device && Number.isInteger(e.seq) && e.seq <= ps)
  );
  return { kept, newLastSeen: Math.max(lastSeen, ps) };
}

// Which prose days are SAFE to drop from the buffer? A day's verbatim words may be dropped only
// when (a) NO event of ANY type for that day remains un-acked — exactly when the day also leaves
// the push set, so no later empty-body PUT can overwrite the folded words — and (b) no dirty (un-PUT)
// edit remains. Gating on journal events alone was the data-loss bug: an orphan task_done stalls the
// ack cursor while the journal seq prunes, then push re-PUTs an empty journal over real words (the
// fold byte-copies the blank). keptEvents = events still un-acked after pruneAcked. (must-fix #1.)
export function prunableProseDays(keptEvents, proseRows) {
  const keptDays = new Set(keptEvents.map((e) => e.day).filter(Boolean));
  const out = new Set();
  for (const day of new Set(proseRows.map((p) => p.day))) {
    const dirty = proseRows.some((p) => p.day === day && p.dirty);
    if (!keptDays.has(day) && !dirty) out.add(day);
  }
  return out;
}
