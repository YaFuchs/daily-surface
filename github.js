// github.js — the GitHub REST Contents API client (Track B Phase 4). The PWA is not a git client;
// it reads the snapshot and appends to its own outbox files via the Contents API (one file per
// commit). UTF-8-safe base64 so Hebrew prose round-trips. Uses secrets.authedFetch — never holds
// the PAT itself. connect-src in the CSP is pinned to api.github.com ONLY (never widen to
// githubusercontent.com): the Contents API returns base64 inline for these small files, so no
// raw-host fetch is ever needed and the exfil channel stays closed.

import { authedFetch, getConfig } from "./secrets.js";

export function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
export function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function classify(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 409 || status === 422) return "sha_stale";
  return "other";
}

async function contentsUrl(path) {
  const { owner, repo, apiBase } = await getConfig();
  return `${apiBase}/repos/${owner}/${repo}/contents/${path}`;
}

// GET a file -> { sha, text }. A 404 is normal (the file does not exist yet) -> { sha:null, text:"" }.
export async function getFile(path) {
  const { branch } = await getConfig();
  let res;
  try {
    res = await authedFetch(`${await contentsUrl(path)}?ref=${encodeURIComponent(branch)}`, { cache: "no-store" });
  } catch (e) {
    const err = new Error("offline"); err.code = "offline"; throw err;
  }
  if (res.status === 404) return { sha: null, text: "" };
  if (!res.ok) { const err = new Error(`GET ${path} ${res.status}`); err.code = classify(res.status); throw err; }
  const j = await res.json();
  // A >1MB blob comes back with empty inline content + a real sha; treating it as "" would let a PUT
  // clobber it. Fail loud instead (the per-day try/catch keeps the buffer). Unreachable at human scale.
  if (!j.content && j.size > 0) { const err = new Error(`GET ${path} too large (${j.size}B)`); err.code = "too_large"; throw err; }
  return { sha: j.sha, text: j.content ? b64decode(j.content) : "" };
}

// PUT (create or update) a file. sha=null creates; a sha updates. Returns the new commit sha.
export async function putFile(path, contentStr, sha, message) {
  const { branch } = await getConfig();
  const body = { message, content: b64encode(contentStr), branch };
  if (sha) body.sha = sha;
  let res;
  try {
    res = await authedFetch(await contentsUrl(path), { method: "PUT", body: JSON.stringify(body) });
  } catch (e) {
    const err = new Error("offline"); err.code = "offline"; throw err;
  }
  if (!res.ok) { const err = new Error(`PUT ${path} ${res.status}`); err.code = classify(res.status); throw err; }
  const j = await res.json();
  return j.commit && j.commit.sha;
}

// GET the snapshot JSON (the phone's read side).
export async function getJson(path) {
  const { sha, text } = await getFile(path);
  if (!text) return { sha, json: null };
  return { sha, json: JSON.parse(text) };
}
