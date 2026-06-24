#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const BASE = "https://kickbacks-backend-gmdaqm2c7q-uw.a.run.app";
const VIBE_DIR = join(homedir(), ".vibe-ads");
const TOKENS_FILE = join(VIBE_DIR, "tokens.json");
const CLIENT_ID_FILE = join(VIBE_DIR, "client-id.txt");

if (!existsSync(VIBE_DIR)) mkdirSync(VIBE_DIR, { recursive: true, mode: 0o700 });

let clientId;
if (existsSync(CLIENT_ID_FILE)) {
  clientId = readFileSync(CLIENT_ID_FILE, "utf8").trim();
} else {
  clientId = randomUUID();
  writeFileSync(CLIENT_ID_FILE, clientId);
}

console.log("Starting Kickbacks sign-in...");

const startRes = await fetch(`${BASE}/v1/auth/extension/start`, { redirect: "manual" });
const loc = startRes.headers.get("location");
if (!loc) { console.error("No redirect from auth server"); process.exit(1); }

const state = new URL(loc).searchParams.get("state");
if (!state) { console.error("No state in redirect URL"); process.exit(1); }

console.log("\nOpen this URL in your browser to sign in with Google:");
console.log(loc + "\n");
try { execSync(`xdg-open '${loc}' 2>/dev/null`); } catch {}

console.log("Waiting for sign-in (up to 2 minutes)...");
let tokens = null;
for (let i = 0; i < 120; i++) {
  await new Promise(r => setTimeout(r, 3000));
  try {
    const r = await fetch(`${BASE}/v1/auth/extension/poll?state=${encodeURIComponent(state)}`);
    if (r.status === 425) continue; // still pending
    if (r.ok) {
      const j = await r.json();
      if (j.access_token) {
        tokens = { access_token: j.access_token, refresh_token: j.refresh_token ?? null };
        break;
      }
    }
    if (r.status >= 400 && r.status !== 425) {
      const j = await r.json().catch(() => ({}));
      console.error("\nAuth error:", j.detail ?? r.status); process.exit(1);
    }
  } catch { /* keep polling */ }
  process.stdout.write(".");
}

if (!tokens) { console.error("\nSign-in timed out. Please try again."); process.exit(1); }

writeFileSync(TOKENS_FILE, JSON.stringify({ ...tokens, ts: Date.now() }, null, 2), { mode: 0o600 });
console.log("\n\nSigned in! Tokens saved.");
console.log("Start the daemon:  node ~/.vibe-ads/kickbacks-daemon.mjs &");
