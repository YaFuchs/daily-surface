// journal_staging.js — the verbatim prose projection (Track B Phase 4). Pure; Node + browser.
//
// fold.copy_journal does a BYTE-FOR-BYTE copy of surface/inbox/phone-<id>/journal-<day>.md into
// journal/<day>.md, so this renderer must emit a valid journal file matching JOURNAL_TEMPLATE.md.
// It is a PROJECTION (regenerated in full from the day's field values on every journal change),
// NOT append-only. PER-DAY scoped: a multi-day-offline buffer renders one file per day from only
// that day's values (critique blocking #2). Labels come FROM the snapshot schema (never hardcoded)
// so the planner's label-based read of "Tomorrow's one thing" can't drift.
//
// This file carries the verbatim words; the journal_field_set EVENT carries only present:true|false
// (DEC-015). These are the two halves of the journal channel and they live in different files.

// A field counts as "present" (has content worth recording) — the SAME predicate the form uses to
// decide the journal_field_set present flag, so the event flag and the rendered bullet never disagree.
export function isPresent(type, value) {
  if (value === undefined || value === null) return false;
  if (type === "scale") {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 5;
  }
  if (type === "checkbox") return value === true;     // only a checked box is content (template "v=y")
  return String(value).trim() !== "";                  // text
}

export function renderValue(type, value) {
  if (type === "scale") return `${Number(value)}/5`;   // matches the template "/5" token
  if (type === "checkbox") return value ? "v" : "x";   // template "v=y, x=n"
  return String(value).replace(/[\r\n]+/g, " ").trim(); // text: collapse newlines -> byte-clean bullet
}

// fv shape: { [section.name]: { [field.key]: value } } — only this day's values.
export function renderStaging(schema, fv, day) {
  const parts = [`# Journal — ${day}\n`];
  for (const section of schema.sections) {
    const sv = fv[section.name] || {};
    const rows = [];
    for (const field of section.fields) {
      const val = sv[field.key];
      if (isPresent(field.type, val)) {
        rows.push(`- **${field.label}**: ${renderValue(field.type, val)}\n`);
      }
    }
    if (rows.length) parts.push(`\n## ${section.name}\n\n`, ...rows);
  }
  return parts.join("");
}

// Does this day have ANY present field? The sync layer PUTs the staging file when this is true OR
// when the day was previously PUT (the "once-PUT, always-PUT" durability rule — critique should-fix:
// never let fold copy a stale non-empty file after a full clear).
export function hasAnyPresent(schema, fv) {
  for (const section of schema.sections) {
    const sv = fv[section.name] || {};
    for (const field of section.fields) {
      if (isPresent(field.type, sv[field.key])) return true;
    }
  }
  return false;
}
