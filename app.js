// app.js — entry + orchestration (Track B Phase 4). Boots from the cached snapshot + the durable
// outbox, overlays un-acked local events via the pure reducer, renders the panels, and owns the
// action handlers (each = emit an event, then re-render optimistically). Sync is the only network
// action. Orchestration only — no DOM building (ui/journal) and no contract logic (events/reducer).

import * as db from "./db.js";
import * as outbox from "./outbox.js";
import { reduce } from "./reducer.js";
import * as sync from "./sync.js";
import * as secrets from "./secrets.js";
import { getFile } from "./github.js";
import { addDays } from "./events.js";
import { renderHeader, renderPlan, renderTasks, renderCapture } from "./ui.js";
import { renderJournal } from "./journal.js";

const $ = (id) => document.getElementById(id);
const state = { snapshot: null, rows: [], events: [], view: null, plan: null, syncState: "idle", online: navigator.onLine };

function today() { return new Date().toLocaleDateString("en-CA"); } // YYYY-MM-DD, local
function day() { return (state.snapshot && state.snapshot.plan && state.snapshot.plan.date) || today(); }

async function loadState() {
  state.snapshot = (await sync.getCachedSnapshot()) || null;
  if (!state.snapshot) state.snapshot = await loadFixture();   // dev/offline-first fallback
  state.rows = await db.allEvents();
  state.events = state.rows.map((r) => r.event);
  state.view = reduce(state.snapshot || { tasks: [] }, state.events);
}

// "unsynced" = not yet pushed (alarming); "awaiting" = pushed but the Mac has not yet folded+acked
// it (neutral) — so a clean sync does not read as "still unsynced" (security review should-fix).
async function renderHeaderOnly() {
  const unsynced = state.rows.filter((r) => r.synced === 0).length;
  const awaiting = state.rows.filter((r) => r.synced === 1).length;
  renderHeader($("header-mount"), { day: day(), lastSynced: await sync.lastSynced(), unsynced, awaiting, syncState: state.syncState, online: state.online }, actions);
}

async function loadFixture() {
  try { const r = await fetch("./snapshot.fixture.json", { cache: "no-store" }); if (r.ok) return await r.json(); }
  catch { /* none */ } return null;
}

async function refresh() {
  await loadState();
  await renderHeaderOnly();
  renderPlan($("plan-mount"), state.plan, state.view);
  renderTasks($("tasks-mount"), state.view, actions);
  renderCapture($("capture-mount"), state.view, actions);
  const prose = await outbox.proseFv(day());
  renderJournal($("journal-mount"), state.snapshot && state.snapshot.journal_schema, prose, actions);
}

const actions = {
  async markDone(taskId) { await outbox.emit("task_done", { task_id: taskId }, day()); await refresh(); },
  async deferTask(taskId) { await outbox.emit("task_deferred", { task_id: taskId, when: addDays(day(), 1) }, day()); await refresh(); },
  async addTask(text) { await outbox.emit("task_added", { text, project: "inbox" }, day()); await refresh(); },
  async addNote(text) { await outbox.emit("note_added", { text }, day()); await refresh(); },
  async setJournal(section, field, value) {
    // Update ONLY the header chip on a present-flip — never re-render the journal panel, or the
    // focused textarea (caret + soft keyboard) is destroyed mid-sentence (must-fix #2).
    const emitted = await outbox.setJournalField(day(), section, field, value);
    if (emitted) { await loadState(); await renderHeaderOnly(); }
  },
  async syncNow() { await doSync(); },
  async closeDay() {
    if (!confirm(`Close ${day()} and hand the baton to your Mac? Tomorrow's plan generates tonight.`)) return;
    await outbox.emit("day_closed", { plan_date: addDays(day(), 1) }, day());
    await doSync();
  },
};

async function doSync() {
  if (!(await secrets.hasPat())) { openSettings("Enter your repo + access key to sync."); return; }
  state.syncState = "syncing"; await refresh();
  try {
    const res = await sync.syncNow();
    state.syncState = res.ok ? "idle" : "error";
    await cachePlan();
    if (!res.ok && res.errors.length) console.warn("sync errors", res.errors);
  } catch (e) { state.syncState = "error"; console.warn("sync failed:", e.code || e.message); }
  await refresh();
}

// Fetch + cache the plan markdown (private repo, via the Contents API) for the plan panel.
async function cachePlan() {
  const src = state.snapshot && state.snapshot.plan && state.snapshot.plan.source;
  if (!src) return;
  try { const f = await getFile(src); if (f.text) { state.plan = f.text; await db.meta.set("planMarkdown", { day: day(), md: f.text }); } }
  catch { const c = await db.meta.get("planMarkdown"); if (c && c.day === day()) state.plan = c.md; }
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
  const c = await db.meta.get("planMarkdown"); if (c && c.day === today()) state.plan = c.md;
  if (!state.plan && !(await secrets.hasPat())) {        // dev/offline: show the bundled sample plan
    try { const r = await fetch("./plan.fixture.md", { cache: "no-store" }); if (r.ok) state.plan = await r.text(); } catch { /* none */ }
  }
  await refresh();
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
