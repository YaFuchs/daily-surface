# Daily Surface PWA — setup & runbook

The phone client for the Daily Surface (Track B Phase 4). A no-build, zero-dependency, vanilla-JS
ES-module PWA. It hydrates from `surface/snapshot/today.json`, records every tap as an append-only
event in IndexedDB, and on **Sync now** pushes per-day event + journal files to your private repo via
the GitHub Contents API — which the Mac then validates + folds (Phases 1–3). Security model + the PAT
runbook live in [../SECURITY.md](../SECURITY.md); this file is the operational how-to.

## Try it locally first (throwaway, no real key)

`localhost` is a "secure context", so the service worker + IndexedDB + install all work with no host.

```bash
cd surface/pwa
python3 -m http.server 8731
# open http://localhost:8731 — it boots from snapshot.fixture.json (the bundled sample),
# so you can read the plan, check tasks, capture notes, and fill the journal fully OFFLINE,
# with no GitHub and no key. Every tap lands in IndexedDB.
```

To test the **real round-trip** without risking production: create a **disposable private repo**,
seed it with the surface skeleton + the Phase 0–3 scripts, mint a **throwaway** fine-grained PAT
(that repo only, Contents read/write), then in the app's **⚙ Settings** enter owner/repo/branch +
the PAT and tap **Sync now**. Verify on the Mac with `automations/scripts/sync_surface.sh` +
`fold.py` (the headless contract is already proven by `tests/test_pwa_backend_e2e.sh`).

## Tests

```bash
TZ=Asia/Jerusalem node surface/pwa/tests/contract.test.js     # 30 byte/contract/reducer/prune checks
bash surface/pwa/tests/test_pwa_backend_e2e.sh                # real engine -> real backend round-trip
```

## Going live (Yair-gated — the DEC-018 #7 boundary)

Nothing below is automated; each step is yours.

1. **Mint the real PAT** — fine-grained, **`personal-os` only**, **Contents: Read and write** and
   nothing else, 90-day expiry. Verify the token summary reads exactly that. (Full rationale +
   rotation/revocation runbook: [../SECURITY.md](../SECURITY.md).)
2. **Host the shell** — *recommended:* a **separate PUBLIC GitHub repo + GitHub Pages**. The shell is
   HTML/JS/CSS only, **no data and no secret** (your key is entered in-app and stays on the device; the
   demo fixtures are synthetic), so publishing it is safe and keeps your `personal-os` repo private.
   Free, real HTTPS (required for install), stable URL.

   ```bash
   # one time: create an EMPTY public repo "daily-surface" on github.com, then:
   git clone https://github.com/<you>/daily-surface ~/daily-surface
   # each deploy (now and whenever the app changes):
   ./surface/pwa/deploy.sh ~/daily-surface
   cd ~/daily-surface && git add -A && git commit -m "Deploy Daily Surface" && git push
   ```

   Then **GitHub → the `daily-surface` repo → Settings → Pages → Source: "Deploy from a branch" →
   `main` / `(root)`**. After ~1 min it is live at `https://<you>.github.io/daily-surface/` (relative
   paths mean the sub-path "just works"). *(Alternatives — Cloudflare/Netlify Pages: fine, adds a
   custodian. Local-only: dev just uses `localhost`.)*
3. **Install on the phone** — open the Pages URL, **⚙ Settings** → enter owner/repo/branch + your
   device id (`phone-yair`, distinct from the `phone-manual` seed) + the PAT, **Save & connect**
   (it validates the scope), then **Add to Home Screen**.
4. **First real day** — read the plan, check tasks off, capture notes, journal, **Close the day** at
   night. The Mac validates + folds + generates tomorrow's plan and syncs it back.

## How it stays safe

- The key is stored **only on this device** (IndexedDB), never in any repo or the shell source. The
  strict CSP (`script-src 'self'`, `connect-src 'self' https://api.github.com`) blocks exfiltration.
  **Forget key** wipes it; revoke on GitHub on any device loss.
- A compromised key can only ever write under `surface/inbox/phone-<id>/` — the Mac's
  `validate_phone_commits.py` quarantines anything else (Phase 3). Blast radius = one private repo.
- Your journal **words** never enter an event or git history as data — they travel only in the
  `journal-<day>.md` staging file, byte-copied into `journal/` by the fold (DEC-015).
