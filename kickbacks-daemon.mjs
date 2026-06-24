#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const BASE        = "https://kickbacks-backend-gmdaqm2c7q-uw.a.run.app";
const HOME        = homedir();
const VIBE_DIR    = join(HOME, ".vibe-ads");
const TOKENS_FILE = join(VIBE_DIR, "tokens.json");
const CLIENT_ID_FILE = join(VIBE_DIR, "client-id.txt");
const CLI_AD_FILE = join(VIBE_DIR, "cli-ad.json");
const SETTINGS    = join(HOME, ".claude", "settings.json");
const SL_SCRIPT   = join(VIBE_DIR, "vibe-ads-statusline.mjs");
const POLL_MS     = 60_000;
const CC_VERSION  = "2.2.0";
const EXT_VERSION = "kickbacks-cli-daemon-1.0.0";

if (!existsSync(VIBE_DIR)) mkdirSync(VIBE_DIR, { recursive: true, mode: 0o700 });

function loadTokens() {
  try { return JSON.parse(readFileSync(TOKENS_FILE, "utf8")); } catch { return null; }
}

function saveTokens(t) {
  writeFileSync(TOKENS_FILE, JSON.stringify({ ...t, ts: Date.now() }, null, 2), { mode: 0o600 });
}

function getClientId() {
  if (existsSync(CLIENT_ID_FILE)) return readFileSync(CLIENT_ID_FILE, "utf8").trim();
  const id = randomUUID();
  writeFileSync(CLIENT_ID_FILE, id);
  return id;
}

async function safeFetch(url, opts = {}) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000), ...opts });
    return r;
  } catch { return null; }
}

async function refreshAccessToken(rt) {
  const r = await safeFetch(`${BASE}/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rt }),
  });
  if (!r?.ok) return null;
  try { return await r.json(); } catch { return null; }
}

async function fetchPortfolio(at) {
  const r = await safeFetch(
    `${BASE}/v1/portfolio?claude_code_version=${encodeURIComponent(CC_VERSION)}`,
    { headers: { Authorization: `Bearer ${at}` } }
  );
  if (r?.status === 401) return { expired: true };
  if (!r?.ok) return null;
  try { return await r.json(); } catch { return null; }
}

async function sendMetric(event, ad, at, clientId) {
  const body = {
    event_type: event,
    ad_id: ad.adId,
    campaign_id: ad.campaignId,
    client_id: clientId,
    ts: new Date().toISOString(),
    claude_code_version: CC_VERSION,
    extension_version: EXT_VERSION,
    nonce: randomUUID(),
    session_token: ad.sessionToken ?? undefined,
    surface: "statusline",
  };
  const url = ad.demo ? `${BASE}/v1/metrics/demo` : `${BASE}/v1/metrics`;
  await safeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(at ? { Authorization: `Bearer ${at}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function wireSettings(adText) {
  let s = {};
  try { s = JSON.parse(readFileSync(SETTINGS, "utf8")); } catch {}
  s.statusLine  = { type: "command", command: `node ${SL_SCRIPT}` };
  s.spinnerVerbs = { mode: "replace", verbs: [adText] };
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
}

const clientId = getClientId();
let tokens = loadTokens();

if (!tokens?.access_token) {
  console.error("Not signed in. Run:  node ~/.vibe-ads/kickbacks-login.mjs");
  process.exit(1);
}

async function tick() {
  // Proactive token refresh after ~50 min
  if (tokens.refresh_token && tokens.ts && (Date.now() - tokens.ts) > 50 * 60_000) {
    const fresh = await refreshAccessToken(tokens.refresh_token);
    if (fresh?.access_token) { tokens = { ...tokens, ...fresh }; saveTokens(tokens); }
  }

  let portfolio = await fetchPortfolio(tokens.access_token);
  if (portfolio?.expired) {
    console.log(new Date().toISOString(), "Token expired — refreshing...");
    const fresh = await refreshAccessToken(tokens.refresh_token);
    if (fresh?.access_token) { tokens = { ...tokens, ...fresh }; saveTokens(tokens); }
    portfolio = await fetchPortfolio(tokens.access_token);
  }
  const raw = portfolio?.ads?.[0];
  if (!raw?.title_text) { console.log(new Date().toISOString(), "No ad available"); return; }

  // Normalise snake_case API fields to camelCase used internally
  const ad = {
    adId:         raw.ad_id,
    campaignId:   raw.campaign_id,
    adText:       raw.title_text,
    clickUrl:     raw.click_url,
    iconRef:      raw.icon_ref,
    iconUrl:      raw.icon_url,
    sessionToken: raw.session_token,
    demo:         raw.demo ?? false,
  };

  // Write cli-ad.json and wire settings
  writeFileSync(CLI_AD_FILE, JSON.stringify({ ...ad, ts: Date.now() }, null, 2));
  wireSettings(ad.adText);
  console.log(new Date().toISOString(), "Ad:", ad.adText);

  // Impression + view ticks (5 s heartbeat × 6 = 30 s visible time)
  await sendMetric("impression_rendered", ad, tokens.access_token, clientId);
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    await sendMetric("view_tick", ad, tokens.access_token, clientId);
  }
  await sendMetric("view_threshold_met", ad, tokens.access_token, clientId);
}

console.log("Kickbacks daemon running (poll every", POLL_MS / 1000, "s)");
tick().catch(console.error);
setInterval(() => tick().catch(console.error), POLL_MS);
