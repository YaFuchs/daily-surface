// secrets.js — the PAT vault + repo config (Track B Phase 4). The write-scoped fine-grained PAT is
// entered at runtime and stored ONLY in IndexedDB (its own store), behind the device passcode + OS
// encryption (DEC-014). This is the ONLY module that reads the literal token: everyone else calls
// authedFetch(), so the PAT never spreads through the codebase. It is never in the repo or the shell.

import * as db from "./db.js";

const DEFAULTS = { owner: "", repo: "", branch: "main", apiBase: "https://api.github.com", device: "phone-yair" };

export async function getConfig() {
  return { ...DEFAULTS, ...((await db.meta.get("github_config")) || {}) };
}
export async function setConfig(cfg) {
  const merged = { ...(await getConfig()), ...cfg };
  await db.meta.set("github_config", merged);
  if (cfg.device) await db.meta.set("device", cfg.device); // the device slug also lives at meta.device
  return merged;
}

export async function getPat() { return db.get("secrets", "github_pat"); }
export async function setPat(pat) { return db.put("secrets", String(pat || "").trim(), "github_pat"); }
export async function clearPat() { return db.del("secrets", "github_pat"); }
export async function hasPat() { return !!(await getPat()); }

// The single authenticated-fetch chokepoint. No other module ever sees the raw PAT.
export async function authedFetch(url, opts = {}) {
  const pat = await getPat();
  if (!pat) { const e = new Error("no PAT configured"); e.code = "no_pat"; throw e; }
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(opts.headers || {}),
  };
  return fetch(url, { ...opts, headers });
}

// Paste-and-validate: confirm the PAT can reach the configured repo before the first real sync, so a
// wrong-scope token fails fast and clearly instead of mid-flush.
export async function validatePat() {
  const { owner, repo, apiBase } = await getConfig();
  if (!owner || !repo) return { ok: false, reason: "owner/repo not set" };
  try {
    const res = await authedFetch(`${apiBase}/repos/${owner}/${repo}`);
    if (res.status === 200) return { ok: true };
    if (res.status === 401) return { ok: false, reason: "token rejected (401) — check the PAT" };
    if (res.status === 404) return { ok: false, reason: "repo not found / no access (404) — check scope + owner/repo" };
    return { ok: false, reason: `unexpected status ${res.status}` };
  } catch (e) {
    return { ok: false, reason: e.code === "no_pat" ? "no PAT entered" : "offline / network error" };
  }
}
