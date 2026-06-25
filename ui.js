// ui.js — DOM rendering of the header, plan, task, and capture panels (Track B Phase 4). Pure DOM
// via safe-render (textContent everywhere; dir="auto" so Hebrew renders RTL per node). Every
// mutation calls an action on the shared `actions` object (which emits an event + re-renders).

import { el, inline, renderMarkdown } from "./safe-render.js";

function freshness(lastSynced) {
  if (!lastSynced) return { cls: "danger", label: "never synced" };
  const h = (Date.now() - lastSynced) / 3.6e6;
  if (h < 6) return { cls: "fresh", label: `synced ${rel(h)}` };
  if (h < 18) return { cls: "stale", label: `synced ${rel(h)}` };
  return { cls: "danger", label: `synced ${rel(h)} — stale` };
}
const rel = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))}m ago` : `${Math.round(h)}h ago`);

export function renderHeader(mount, { day, lastSynced, unsynced, awaiting, syncState, online }, actions) {
  const f = freshness(lastSynced);
  mount.replaceChildren(
    el("div", { class: "hd-row" },
      el("div", { class: "hd-date", text: day || "—" }),
      el("span", { class: `chip ${online ? f.cls : "danger"}`, text: online ? f.label : "offline" }),
      unsynced ? el("span", { class: "chip pending", text: `${unsynced} unsynced` }) : null,
      awaiting ? el("span", { class: "chip", text: `${awaiting} awaiting confirm` }) : null,
    ),
    el("div", { class: "hd-actions" },
      el("button", {
        class: `btn ${syncState}`, disabled: syncState === "syncing",
        onclick: () => actions.syncNow(),
        text: syncState === "syncing" ? "Syncing…" : syncState === "error" ? "Sync failed — retry" : "Sync now",
      }),
      el("button", { class: "btn ghost", disabled: syncState === "syncing", onclick: () => actions.closeDay(),
        text: "Close the day" }),
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
  const groups = {};
  for (const t of view.tasks) (groups[t.priority || "—"] ||= []).push(t);
  for (const pr of Object.keys(groups).sort()) {
    mount.append(el("div", { class: "task-group-h", text: pr }));
    for (const t of groups[pr]) mount.append(taskRow(t, actions));
  }
  for (const a of view.addedTasks) {
    mount.append(el("div", { class: "task-row pending" },
      el("div", { class: "task-text", dir: "auto" }, ...inline(a.text), el("span", { class: "tag", text: "new · unsynced" })),
    ));
  }
  // add-task
  const input = el("input", { class: "add-input", type: "text", placeholder: "Add a task…", "aria-label": "Add a task" });
  const add = () => { const v = input.value.trim(); if (v) { actions.addTask(v); input.value = ""; } };
  mount.append(el("div", { class: "add-row" }, input,
    el("button", { class: "btn small", onclick: add, text: "Add" })));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
}

function taskRow(t, actions) {
  const done = t.status === "done";
  const deferred = t.status === "deferred";
  const noId = !t.id;
  const row = el("div", { class: `task-row${done ? " done" : ""}${deferred ? " deferred" : ""}` });
  const checkbox = el("button", {
    class: "task-check", "aria-label": done ? "done" : "mark done",
    disabled: noId || done, title: noId ? "No stable id yet — sync first" : "",
    onclick: () => actions.markDone(t.id), text: done ? "✓" : "○",
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
    mount.append(el("div", { class: "task-row pending" },
      el("div", { class: "task-text", dir: "auto" }, ...inline(n.text), el("span", { class: "tag", text: "captured · unsynced" }))));
  }
}
