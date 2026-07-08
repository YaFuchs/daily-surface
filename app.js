// app.js — entry + orchestration (Track B Phase 4). Boots from the cached snapshot + the durable
// outbox, overlays un-acked local events via the pure reducer, renders the panels, and owns the
// action handlers (each = emit an event, then re-render optimistically). Sync is the only network
// action. Orchestration only — no DOM building (ui/journal) and no contract logic (events/reducer).

import * as db from "./db.js";
import * as outbox from "./outbox.js";
import { reduce, computeScoreboard, scoreboardText } from "./reducer.js";
import * as sync from "./sync.js";
import * as secrets from "./secrets.js";
import { getFile } from "./github.js";
import { addDays } from "./events.js";
import { renderHeader, renderPlan, renderWeek, renderTasks, renderCapture } from "./ui.js";
import { renderJournal } from "./journal.js";

const $ = (id) => document.getElementById(id);
const state = { snapshot: null, rows: [], events: [], view: null, plan: null, week: null, syncState: "idle", online: navigator.onLine };

function today() { return new Date().toLocaleDateString("en-CA"); } // YYYY-MM-DD, local
function day() { return (state.snapshot && state.snapshot.plan && state.snapshot.plan.date) || today(); }

async function loadState() {
  state.snapshot = (await sync.getCachedSnapshot()) || null;
  if (!state.snapshot) state.snapshot = await loadFixture();   // dev/offline-first fallback
  state.rows = await db.allEvents();
  state.events = state.rows.map((r) => r.event);
  state.view = reduce(state.snapshot || { tasks: [] }, state.events);
  // Annotate optimistic overlays with their outbox row (key + sync state) so the UI can offer a
  // pre-sync cancel: a local-only delete of an un-synced (synced===0) add/note. Once a row is
  // pushed (synced===1) it has left for the Mac and can no longer be retracted from the phone.
  const rowBySeq = new Map(state.rows.map((r) => [r.event.seq, r]));
  for (const item of [...state.view.addedTasks, ...state.view.notes]) {
    const row = rowBySeq.get(item.seq);
    item.key = row ? row.key : null;
    item.synced = row ? row.synced : 0;
  }
  // Annotate locally-completed tasks with the outbox row of their task_done event, so an un-synced
  // completion can offer an undo (tap to drop that event → reverts to open). DEC-023(b).
  // Pending added rows completed via ref_evt (DEC-039) get the same treatment.
  for (const t of [...state.view.tasks, ...state.view.addedTasks]) {
    if (t._doneSeq != null) {
      const row = rowBySeq.get(t._doneSeq);
      t._doneKey = row ? row.key : null;
      t._doneSynced = row ? row.synced : 0;
    }
  }
  // Load the cached plan markdown that matches the CURRENT snapshot's plan-day (not the wall-clock
  // date — the evening-primary plan is tomorrow's), so a reopen/refresh shows the right plan.
  const pdate = state.snapshot && state.snapshot.plan && state.snapshot.plan.date;
  if (pdate) { const c = await db.meta.get("planMarkdown"); if (c && c.day === pdate) state.plan = c.md; }
  // Same, for the week plan (DEC-040): cached under its own key, keyed by ISO-week label.
  const wdate = state.snapshot && state.snapshot.week && state.snapshot.week.date;
  if (wdate) { const c = await db.meta.get("weekMarkdown"); if (c && c.week === wdate) state.week = c.md; }
}

// "unsynced" = not yet pushed (alarming); "awaiting" = pushed but the Mac has not yet folded+acked
// it (neutral) — so a clean sync does not read as "still unsynced" (security review should-fix).
async function renderHeaderOnly() {
  const unsynced = state.rows.filter((r) => r.synced === 0).length;
  const awaiting = state.rows.filter((r) => r.synced === 1).length;
  // The recap chip only while the snapshot still belongs to the day that was closed: if a NEW
  // day's snapshot lands before day_closed is acked (offline close + pull-before-push), the
  // numbers would silently recompute against the new plan — hide instead (review, DEC-038).
  const sameDay = state.view?.closed && state.view.closedDay === state.snapshot?.plan?.date;
  renderHeader($("header-mount"), { day: day(), lastSynced: await sync.lastSynced(), unsynced, awaiting, syncState: state.syncState, online: state.online, closed: state.view?.closed,
    scoreboard: sameDay ? computeScoreboard(state.view) : null }, actions);
}

async function loadFixture() {
  try { const r = await fetch("./snapshot.fixture.json", { cache: "no-store" }); if (r.ok) return await r.json(); }
  catch { /* none */ } return null;
}

async function refresh() {
  await loadState();
  await renderHeaderOnly();
  renderPlan($("plan-mount"), state.plan, state.view);
  renderWeek($("week-mount"), state.week);
  renderTasks($("tasks-mount"), state.view, actions);
  renderCapture($("capture-mount"), state.view, actions);
  const prose = await outbox.proseFv(day());
  renderJournal($("journal-mount"), state.snapshot && state.snapshot.journal_schema, prose, actions);
}

const actions = {
  async markDone(taskId) { await outbox.emit("task_done", { task_id: taskId }, day()); await refresh(); },
  // DEC-039: complete a just-captured task by its origin task_added event id — works instantly,
  // offline, before the Mac ever minted the task an id (the capture dead-zone fix).
  async markDoneRef(evtId) { await outbox.emit("task_done", { ref_evt: evtId }, day()); await refresh(); },
  async deferTask(taskId) { await outbox.emit("task_deferred", { task_id: taskId, when: addDays(day(), 1) }, day()); await refresh(); },
  async addTask(text) { await outbox.emit("task_added", { text, project: "inbox" }, day()); await refresh(); },
  async addNote(text) { await outbox.emit("note_added", { text }, day()); await refresh(); },
  // Local-only cancel of an un-synced add/note (the only reversible action pre-DEC-024): drop the
  // event from the outbox before it is pushed. Re-checks synced===0 at tap time so it can never
  // delete a row already on its way to the Mac (which the fold would still apply — a phantom).
  async cancelLocal(key) {
    if (!key) return;
    const row = await db.get("outbox", key);
    if (!row || row.synced !== 0) return;
    await db.deleteEvent(key);
    await refresh();
  },
  async setJournal(section, field, value) {
    // Update ONLY the header chip on a present-flip — never re-render the journal panel, or the
    // focused textarea (caret + soft keyboard) is destroyed mid-sentence (must-fix #2).
    const emitted = await outbox.setJournalField(day(), section, field, value);
    if (emitted) { await loadState(); await renderHeaderOnly(); }
  },
  async syncNow() { await doSync(); },
  async closeDay() {
    // Guard against a duplicate day_closed (2026-07-04 fix): the button is disabled once closed,
    // but this covers a race (a stale click firing just before the disabling re-render lands).
    // The server already de-dupes (fold idempotency + evening_close.sh's high-water mark), but a
    // 2nd emit still triggers a redundant regeneration and leaves a pending event on the baton.
    if (state.view?.closed) return;
    // The Daily Scoreboard (DEC-038): closing IS the report-back moment — lead the confirm with
    // today's committed-vs-done score (quiet on days the plan committed no tracked tasks).
    const sb = computeScoreboard(state.view);
    const report = sb ? `Today's report: ${scoreboardText(sb)}.\n\n` : "";
    if (!confirm(`${report}Close ${day()} and hand the baton to your Mac? Tomorrow's plan generates tonight.`)) return;
    await outbox.emit("day_closed", { plan_date: addDays(day(), 1) }, day());
    // Immediate, local, durable feedback — independent of doSync's network step (which early-
    // returns without refreshing if no PAT is configured yet): state.view.closed flips as soon as
    // this event is read back from the outbox, disabling the button and showing the acknowledgment.
    await refresh();
    await doSync();
  },
};

async function doSync() {
  if (!(await secrets.hasPat())) { openSettings("Enter your repo + access key to sync."); return; }
  state.syncState = "syncing"; await refresh();
  try {
    const res = await sync.syncNow();
    state.syncState = res.ok ? "idle" : "error";
    await cachePlan(res.snapshot);
    await cacheWeek(res.snapshot);
    if (!res.ok && res.errors.length) console.warn("sync errors", res.errors);
    // Connected, but the plan file was not found = wrong repo/branch (the #1 setup slip — a
    // case-mismatched branch). Tell the user exactly where to look instead of silently doing nothing.
    if (res.pulled && !res.snapshotFound) {
      const cfg = await secrets.getConfig();
      state.syncState = "error";
      openSettings(`Connected, but no plan found at ${cfg.owner}/${cfg.repo} on branch "${cfg.branch}". Double-check the repo name and branch — they are case-sensitive (the branch should be lowercase "main").`);
    }
  } catch (e) { state.syncState = "error"; console.warn("sync failed:", e.code || e.message); }
  await refresh();
}

// Fetch + cache the plan markdown (private repo, via the Contents API) for the plan panel.
// Takes the snapshot EXPLICITLY — the freshly-pulled one from syncNow. Reading state.snapshot here
// was the bug: during a sync it is still the PREVIOUS day's snapshot (refresh reloads it only
// afterwards), so the panel fetched yesterday's plan even though the date had advanced. Keyed by
// the plan's own date (the evening-primary plan is tomorrow's, not the wall-clock day).
async function cachePlan(snapshot) {
  const snap = snapshot || state.snapshot;
  const src = snap && snap.plan && snap.plan.source;
  const pdate = snap && snap.plan && snap.plan.date;
  if (!src) return;
  try { const f = await getFile(src); if (f.text) { state.plan = f.text; await db.meta.set("planMarkdown", { day: pdate, md: f.text }); } }
  catch { const c = await db.meta.get("planMarkdown"); if (c && c.day === pdate) state.plan = c.md; }
}

// Same, for the week plan (DEC-040) — same mechanism, one field over: snapshot.week.source instead
// of snapshot.plan.source, cached under its own IndexedDB key so a plan-day change never evicts it.
async function cacheWeek(snapshot) {
  const snap = snapshot || state.snapshot;
  const src = snap && snap.week && snap.week.source;
  const wdate = snap && snap.week && snap.week.date;
  if (!src) return;
  try { const f = await getFile(src); if (f.text) { state.week = f.text; await db.meta.set("weekMarkdown", { week: wdate, md: f.text }); } }
  catch { const c = await db.meta.get("weekMarkdown"); if (c && c.week === wdate) state.week = c.md; }
}

// ---- settings (repo config + PAT) -----------------------------------------------------------
async function openSettings(msg) {
  const cfg = await secrets.getConfig();
  const box = $("settings");
  box.hidden = false;
  $("settings-msg").textContent = msg || "";
  $("cfg-owner").value = cfg.owner; $("cfg-repo").value = cfg.repo;
  $("cfg-branch").value = cfg.branch; $("cfg-device").value = cfg.device;
  $("cfg-pat").value = "";
}
function wireSettings() {
  $("settings-toggle").addEventListener("click", () => openSettings(""));
  $("settings-close").addEventListener("click", () => { $("settings").hidden = true; });
  $("settings-forget").addEventListener("click", async () => { await secrets.clearPat(); $("settings-status").textContent = "Access key forgotten."; });
  $("settings-save").addEventListener("click", async () => {
    await secrets.setConfig({ owner: $("cfg-owner").value.trim(), repo: $("cfg-repo").value.trim(), branch: $("cfg-branch").value.trim() || "main", device: $("cfg-device").value.trim() || "phone-yair" });
    const pat = $("cfg-pat").value.trim();
    if (pat) await secrets.setPat(pat);
    $("settings-status").textContent = "Checking access…";
    const v = await secrets.validatePat();
    $("settings-status").textContent = v.ok ? "✓ Connected." : `✗ ${v.reason}`;
    if (v.ok) { $("settings").hidden = true; await doSync(); }
  });
}

async function boot() {
  wireSettings();
  window.addEventListener("online", () => { state.online = true; refresh(); });
  window.addEventListener("offline", () => { state.online = false; refresh(); });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  await refresh();   // loadState() loads the cached plan that matches the snapshot's plan-day
  if (!state.plan && !(await secrets.hasPat())) {        // dev/offline: show the bundled sample plan
    try { const r = await fetch("./plan.fixture.md", { cache: "no-store" }); if (r.ok) { state.plan = await r.text(); renderPlan($("plan-mount"), state.plan, state.view); } } catch { /* none */ }
  }
  if (!state.week && !(await secrets.hasPat())) {        // same, for the sample week plan
    try { const r = await fetch("./week.fixture.md", { cache: "no-store" }); if (r.ok) { state.week = await r.text(); renderWeek($("week-mount"), state.week); } } catch { /* none */ }
  }
  if (!(await secrets.hasPat())) openSettings("Welcome. Connect your repo to sync (your data stays private).");
}

// Fail VISIBLE, never blank: if IndexedDB is unavailable (private mode, storage pressure, a locked-
// down webview) the whole UI (built inside refresh) would otherwise never appear (should-fix).
boot().catch((e) => {
  const h = $("header-mount");
  if (h) h.replaceChildren(Object.assign(document.createElement("div"), {
    className: "hd-row", textContent: "Storage unavailable on this browser — the Surface needs IndexedDB (try a normal, non-private window).",
  }));
  console.error("boot failed:", e && (e.message || e));
});
