// ui.js — DOM rendering of the header, plan, task, and capture panels (Track B Phase 4). Pure DOM
// via safe-render (textContent everywhere; dir="auto" so Hebrew renders RTL per node). Every
// mutation calls an action on the shared `actions` object (which emits an event + re-renders).

import { el, inline, renderMarkdown } from "./safe-render.js";
import { scoreboardText } from "./reducer.js";

function freshness(lastSynced) {
  if (!lastSynced) return { cls: "danger", label: "never synced" };
  const h = (Date.now() - lastSynced) / 3.6e6;
  if (h < 6) return { cls: "fresh", label: `synced ${rel(h)}` };
  if (h < 18) return { cls: "stale", label: `synced ${rel(h)}` };
  return { cls: "danger", label: `synced ${rel(h)} — stale` };
}
const rel = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))}m ago` : `${Math.round(h)}h ago`);

export function renderHeader(mount, { day, lastSynced, unsynced, awaiting, syncState, online, closed, scoreboard }, actions) {
  const f = freshness(lastSynced);
  mount.replaceChildren(
    el("div", { class: "hd-row" },
      el("div", { class: "hd-date", text: day || "—" }),
      el("span", { class: `chip ${online ? f.cls : "danger"}`, text: online ? f.label : "offline" }),
      unsynced ? el("span", { class: "chip pending", text: `${unsynced} unsynced` }) : null,
      awaiting ? el("span", { class: "chip", text: `${awaiting} awaiting confirm` }) : null,
      // The Daily Scoreboard recap (DEC-038): the day's report — the accountability moment the
      // close IS. Shown once the day is closed; recomputed from view state on every render, so
      // it shares the closed chip's durable-until-ack lifetime (reload-surviving, no new state).
      closed && scoreboard ? el("span", { class: "chip fresh", text: `Today: ${scoreboardText(scoreboard)}` }) : null,
      // Durable, re-render-surviving close acknowledgment (driven by view.closed, i.e. an actual
      // local day_closed event — not a transient toast, so a reload/re-render still shows it):
      // honest about the async, Mac-dependent payoff. Also IS the duplicate-close guard — once
      // closed, the button below is disabled, so a second tap can't emit another day_closed.
      closed ? el("span", { class: "chip fresh", text: "Tomorrow's plan generates on your Mac this evening — Sync later to see it" }) : null,
    ),
    el("div", { class: "hd-actions" },
      el("button", {
        class: `btn ${syncState}`, disabled: syncState === "syncing",
        onclick: () => actions.syncNow(),
        text: syncState === "syncing" ? "Syncing…" : syncState === "error" ? "Sync failed — retry" : "Sync now",
      }),
      el("button", { class: "btn ghost", disabled: syncState === "syncing" || closed, onclick: () => actions.closeDay(),
        text: closed ? "Day closed ✓" : "Close the day" }),
    ),
  );
}

export function renderPlan(mount, planMarkdown, view) {
  mount.replaceChildren();
  mount.append(el("h2", { class: "panel-h", text: "Today's plan" }));
  if (planMarkdown) {
    const body = el("div", { class: "plan-body", dir: "auto" });
    body.append(renderMarkdown(planMarkdown));
    mount.append(body);
  } else {
    mount.append(el("p", { class: "muted", text: "Plan not cached offline — showing your tasks below." }));
  }
}

export function renderTasks(mount, view, actions) {
  mount.replaceChildren(el("h2", { class: "panel-h", text: "Tasks" }));

  // "Today" = the tasks the plan selected by id (snapshot.today, already validated by
  // render_snapshot); "Backlog" = everything else, collapsed so the panel opens on the focus set.
  // Empty/absent today (old snapshot, or nothing pinned) → fall back to the flat priority-grouped
  // list, so this is never worse than before the split. (DEC-021 §6 / DEC-028.)
  const todayIds = view.today || [];
  if (todayIds.length) {
    const byId = new Map(view.tasks.filter((t) => t.id).map((t) => [t.id, t]));
    const todayTasks = todayIds.map((id) => byId.get(id)).filter(Boolean);   // planner's order; skip any not present
    const inToday = new Set(todayTasks);
    const backlog = view.tasks.filter((t) => !inToday.has(t));

    mount.append(el("div", { class: "task-today-h", text: "Today" }));
    if (todayTasks.length) for (const t of todayTasks) mount.append(taskRow(t, actions));
    else mount.append(el("p", { class: "muted tiny", text: "Nothing pinned for today." }));

    if (backlog.length) {
      const det = el("details", { class: "backlog" });
      det.append(el("summary", { class: "backlog-sum", text: `Backlog (${backlog.length})` }));
      appendGrouped(det, backlog, actions);
      mount.append(det);
    }
  } else {
    appendGrouped(mount, view.tasks, actions);
  }

  for (const a of view.addedTasks) {
    const row = el("div", { class: "task-row pending" },
      el("div", { class: "task-text", dir: "auto" }, ...inline(a.text),
        el("span", { class: "tag", text: a.synced ? "new · awaiting confirm" : "new · unsynced" })),
    );
    // A just-added task has no stable id and no undo/edit verb (DEC-024 pending). The one thing it
    // CAN do before sync is be cancelled — drop the un-synced event from the outbox.
    if (a.synced === 0 && a.key) {
      row.append(el("button", { class: "task-cancel", title: "Cancel — remove this un-synced task",
        "aria-label": "cancel task", onclick: () => actions.cancelLocal(a.key), text: "×" }));
    }
    mount.append(row);
  }
  // add-task
  const input = el("input", { class: "add-input", type: "text", placeholder: "Add a task…", "aria-label": "Add a task" });
  const add = () => { const v = input.value.trim(); if (v) { actions.addTask(v); input.value = ""; } };
  mount.append(el("div", { class: "add-row" }, input,
    el("button", { class: "btn small", onclick: add, text: "Add" })));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
}

function appendGrouped(mount, tasks, actions) {
  const groups = {};
  for (const t of tasks) (groups[t.priority || "—"] ||= []).push(t);
  for (const pr of Object.keys(groups).sort()) {
    mount.append(el("div", { class: "task-group-h", text: pr }));
    for (const t of groups[pr]) mount.append(taskRow(t, actions));
  }
}

function taskRow(t, actions) {
  const done = t.status === "done";
  const deferred = t.status === "deferred";
  const noId = !t.id;
  const undoable = done && t._doneSynced === 0 && t._doneKey;   // un-synced completion → tap to undo (DEC-023b)
  const row = el("div", { class: `task-row${done ? " done" : ""}${deferred ? " deferred" : ""}` });
  const checkbox = el("button", {
    class: "task-check",
    "aria-label": done ? (undoable ? "undo done" : "done") : "mark done",
    disabled: noId || (done && !undoable),
    title: noId ? "No stable id yet — sync first" : undoable ? "Tap to undo — not synced yet" : "",
    onclick: () => { if (undoable) actions.cancelLocal(t._doneKey); else if (!done) actions.markDone(t.id); },
    text: done ? "✓" : "○",
  });
  const text = el("div", { class: "task-text", dir: "auto" }, ...inline(t.text));
  if (t._localPending) text.append(el("span", { class: "tag", text: "unsynced" }));
  if (deferred) text.append(el("span", { class: "tag", text: `→ ${t.deferredTo || "later"}` }));
  row.append(checkbox, text);
  if (!done && !deferred && !noId) {
    row.append(el("button", { class: "task-defer", title: "Defer to tomorrow",
      onclick: () => actions.deferTask(t.id), text: "⏭" }));
  }
  return row;
}

export function renderCapture(mount, view, actions) {
  mount.replaceChildren(el("h2", { class: "panel-h", text: "Capture a note" }));
  const ta = el("textarea", { class: "note-input", rows: "2", placeholder: "A thought, an idea…", dir: "auto", "aria-label": "Capture a note" });
  const save = () => { const v = ta.value.trim(); if (v) { actions.addNote(v); ta.value = ""; } };
  mount.append(ta, el("button", { class: "btn small", onclick: save, text: "Save note" }));
  for (const n of (view && view.notes) || []) {
    const row = el("div", { class: "task-row pending" },
      el("div", { class: "task-text", dir: "auto" }, ...inline(n.text),
        el("span", { class: "tag", text: n.synced ? "captured · awaiting confirm" : "captured · unsynced" })));
    if (n.synced === 0 && n.key) {
      row.append(el("button", { class: "task-cancel", title: "Cancel — remove this un-synced note",
        "aria-label": "cancel note", onclick: () => actions.cancelLocal(n.key), text: "×" }));
    }
    mount.append(row);
  }
}
