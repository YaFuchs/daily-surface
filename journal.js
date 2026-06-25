// journal.js — the Morning/Evening journal form (Track B Phase 4), rendered from the snapshot's
// journal_schema (never hardcoded, so it can't drift from JOURNAL_TEMPLATE / the fold / the planner).
// scale -> a 1–5 segmented control, checkbox -> a toggle, text -> an auto-grow textarea. The verbatim
// words go to the staging buffer; only the present/absent FLAG becomes an event (DEC-015), emitted on
// a present-flip (text is debounced + committed on blur). "Tomorrow's one thing" is just an Evening
// text field — it needs no special-casing; the schema places it.

import { el } from "./safe-render.js";

export function renderJournal(mount, schema, proseValues, actions) {
  // Preserve each section's live open/closed state across a re-render (default Morning-open only on
  // the first render) so a full refresh never collapses a section mid-ritual (security review should-fix).
  const prevOpen = {};
  mount.querySelectorAll(".jr-section").forEach((d) => { const s = d.querySelector("summary"); if (s) prevOpen[s.textContent] = d.open; });
  const firstRender = Object.keys(prevOpen).length === 0;
  mount.replaceChildren(el("h2", { class: "panel-h", text: "Journal" }));
  if (!schema || !schema.sections) { mount.append(el("p", { class: "muted", text: "Journal schema unavailable (sync first)." })); return; }
  for (const section of schema.sections) {
    const open = firstRender ? section.name.toLowerCase() === "morning" : !!prevOpen[section.name];
    const det = el("details", { class: "jr-section", open });
    det.append(el("summary", { text: section.name }));
    const cur = (proseValues && proseValues[section.name]) || {};
    for (const field of section.fields) det.append(fieldControl(section, field, cur[field.key], actions));
    mount.append(det);
  }
}

function fieldControl(section, field, value, actions) {
  const wrap = el("div", { class: "jr-field" });
  wrap.append(el("label", { class: "jr-label", text: field.label }));
  const commit = (v) => actions.setJournal(section, field, v);

  if (field.type === "scale") {
    const seg = el("div", { class: "scale" });
    for (let n = 1; n <= 5; n++) {
      const b = el("button", { class: "scale-b" + (Number(value) === n ? " on" : ""), text: String(n),
        onclick: () => { for (const c of seg.children) c.classList.remove("on"); b.classList.add("on"); commit(n); } });
      seg.append(b);
    }
    wrap.append(seg);
  } else if (field.type === "checkbox") {
    const t = el("button", { class: "toggle" + (value === true ? " on" : ""), role: "switch", "aria-checked": value === true,
      text: value === true ? "Yes" : "No",
      onclick: () => { const nv = !(t.classList.contains("on")); t.classList.toggle("on", nv); t.textContent = nv ? "Yes" : "No"; t.setAttribute("aria-checked", nv); commit(nv); } });
    wrap.append(t);
  } else {
    const ta = el("textarea", { class: "jr-text", rows: "2", dir: "auto", placeholder: field.hint || "", "aria-label": field.label });
    ta.value = value || "";
    let timer = null;
    ta.addEventListener("input", () => { autogrow(ta); clearTimeout(timer); timer = setTimeout(() => commit(ta.value), 600); });
    ta.addEventListener("blur", () => { clearTimeout(timer); commit(ta.value); });
    wrap.append(ta);
    requestAnimationFrame(() => autogrow(ta));
  }
  return wrap;
}

function autogrow(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
