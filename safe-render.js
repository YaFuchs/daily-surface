// safe-render.js — the single untrusted-text render path (Track B Phase 4). EVERYTHING the phone
// shows that could contain phone-originated or repo text (task text, notes, journal values, and the
// plan) goes through here, built with createElement + textContent — NEVER innerHTML of content. This
// is the XSS discipline the in-browser PAT depends on: no injected markup can run a script and read
// the token out of IndexedDB. (The strict CSP in index.html — script-src 'self', connect-src
// api.github.com — is the backstop; this is the primary defence.)

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}

// Inline: **bold**, `code`, [text](https-url). Returns an array of text/element nodes (textContent
// throughout). Unknown/unsafe link schemes render as plain text (no href).
export function inline(str) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0, m;
  while ((m = re.exec(str))) {
    if (m.index > last) out.push(document.createTextNode(str.slice(last, m.index)));
    if (m[1] != null) out.push(el("strong", { text: m[1] }));
    else if (m[2] != null) out.push(el("code", { text: m[2] }));
    else out.push(el("a", { href: m[4], rel: "noopener noreferrer", target: "_blank", text: m[3] }));
    last = re.lastIndex;
  }
  if (last < str.length) out.push(document.createTextNode(str.slice(last)));
  return out;
}

// A minimal, SAFE markdown renderer for the planner's output (headings, italic intro, ordered/
// unordered lists, the day-shape pipe table, blockquotes, hr, paragraphs). DOM-built; no innerHTML.
export function renderMarkdown(md) {
  const frag = document.createDocumentFragment();
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const flushTable = (rows) => {
    const table = el("table");
    rows.forEach((cells, r) => {
      if (r === 1 && cells.every((c) => /^:?-+:?$/.test(c.trim()))) return; // separator row
      const tr = el("tr");
      cells.forEach((c) => tr.append(el(r === 0 ? "th" : "td", {}, ...inline(c.trim()))));
      table.append(tr);
    });
    frag.append(table);
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { frag.append(el("h" + m[1].length, {}, ...inline(m[2]))); i++; continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { frag.append(el("hr")); i++; continue; }
    if (line.startsWith(">")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith(">")) buf.push(lines[i++].replace(/^>\s?/, ""));
      frag.append(el("blockquote", {}, ...inline(buf.join(" "))));
      continue;
    }
    if (line.includes("|") && line.trim().startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim().startsWith("|")) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|"));
        i++;
      }
      flushTable(rows);
      continue;
    }
    if (/^\s*(\d+\.|[-*])\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = el(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*(\d+\.|[-*])\s+/.test(lines[i])) {
        list.append(el("li", {}, ...inline(lines[i].replace(/^\s*(\d+\.|[-*])\s+/, ""))));
        i++;
      }
      frag.append(list);
      continue;
    }
    if (/^\*[^*].*\*$/.test(line.trim())) { frag.append(el("p", { class: "intro" }, el("em", { text: line.trim().replace(/^\*|\*$/g, "") }))); i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>|\s*(\d+\.|[-*])\s|\|)/.test(lines[i])) buf.push(lines[i++]);
    frag.append(el("p", {}, ...inline(buf.join(" "))));
  }
  return frag;
}
