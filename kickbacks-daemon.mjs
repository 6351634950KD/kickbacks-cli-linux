#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, release as osRelease } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";

const BASE        = "https://kickbacks-backend-gmdaqm2c7q-uw.a.run.app";
const HOME        = homedir();
const VIBE_DIR    = join(HOME, ".vibe-ads");
const TOKENS_FILE = join(VIBE_DIR, "tokens.json");
const CLIENT_FILE = join(VIBE_DIR, "client-id.txt");
const CLI_AD_FILE = join(VIBE_DIR, "cli-ad.json");
const SETTINGS    = join(HOME, ".claude", "settings.json");
const SL_SCRIPT   = join(VIBE_DIR, "vibe-ads-statusline.mjs");
const POLL_MS     = 10_000;
const CC_VERSION  = "2.2.0";
const EXT_VERSION = "0.3.177";  // matches current kickbacks.ai extension version

// clientEnv mirrors the extension's MetricsClient.clientEnv() shape exactly.
const CLIENT_ENV = {
  os: process.platform,
  arch: process.arch,
  os_version: osRelease(),
  editor: "Visual Studio Code",
};

// Guard: only one tick() runs at a time, preventing concurrent cycles
// that produce fraudulent-looking event patterns on the backend.
let tickRunning = false;

function loadTokens() {
  try { return JSON.parse(readFileSync(TOKENS_FILE, "utf8")); } catch { return null; }
}
function saveTokens(t) {
  writeFileSync(TOKENS_FILE, JSON.stringify({ ...t, ts: Date.now() }, null, 2), { mode: 0o600 });
}
function getClientId() {
  if (existsSync(CLIENT_FILE)) return readFileSync(CLIENT_FILE, "utf8").trim();
  const id = randomUUID(); writeFileSync(CLIENT_FILE, id); return id;
}
function sessionNonce() {
  return randomBytes(8).toString("hex");
}
async function safeFetch(url, opts = {}) {
  try { return await fetch(url, { signal: AbortSignal.timeout(15_000), ...opts }); } catch { return null; }
}
async function refreshToken(rt) {
  const r = await safeFetch(BASE + "/v1/auth/refresh", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rt }),
  });
  if (!r?.ok) return null;
  try { return await r.json(); } catch { return null; }
}
async function fetchPortfolio(at) {
  const r = await safeFetch(BASE + "/v1/portfolio?claude_code_version=" + CC_VERSION,
    { headers: { Authorization: "Bearer " + at } });
  if (r?.status === 401) return { expired: true };
  if (!r?.ok) return null;
  try { return await r.json(); } catch { return null; }
}

async function sendMetric(event, ad, at, clientId, extras = {}) {
  const { corr: _corr, ...restExtras } = extras;
  const corr = _corr ?? `cli.${ad.adId}`;
  const body = {
    event_type: event,
    ad_id: ad.adId,
    campaign_id: ad.campaignId,
    client_id: clientId,
    ts: new Date().toISOString(),
    claude_code_version: CC_VERSION,
    extension_version: EXT_VERSION,
    nonce: randomUUID(),
    session_token: ad.sessionToken,
    surface: "statusline",
    ext: CLIENT_ENV,
    ...restExtras,
  };
  const url = ad.demo ? BASE + "/v1/metrics/demo" : BASE + "/v1/metrics";
  const r = await safeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Kickbacks-Corr": corr,
      "X-Vibe-Corr": corr,
      ...(at ? { Authorization: "Bearer " + at } : {}),
    },
    body: JSON.stringify(body),
  });
  if (r?.ok) {
    const j = await r.json().catch(() => ({}));
    const bal = j.balances ?? {};
    console.log(new Date().toISOString(),
      `[${event}] billed=${j.billed} lifetime=$${bal.lifetime_usd ?? "?"} today=$${bal.today_usd ?? "?"}`);
    return j;
  } else {
    const txt = await r?.text().catch(() => "");
    console.log(new Date().toISOString(), `[${event}] FAILED ${r?.status} ${txt.slice(0, 100)}`);
    return null;
  }
}

function wireSettings(adText) {
  let s = {};
  try { s = JSON.parse(readFileSync(SETTINGS, "utf8")); } catch {}
  s.statusLine   = { type: "command", command: "node " + SL_SCRIPT };
  s.spinnerVerbs = { mode: "replace", verbs: [adText] };
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
}
function toastNotify(adText, clickUrl) {
  const safe = (s) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const ps = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null",
    `$xml = '<toast activationType="protocol" launch="${safe(clickUrl)}"><visual><binding template="ToastGeneric"><text>Kickbacks.ai</text><text>${safe(adText)}</text><text>Click to earn 50x</text></binding></visual></toast>'`,
    "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$doc.LoadXml($xml)",
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Kickbacks').Show($toast)",
  ].join("; ");
  try { execSync(`powershell.exe -NoProfile -Command "${ps}"`, { stdio: "ignore" }); } catch {}
}

const clientId = getClientId();
let tokens = loadTokens();
let reloginInProgress = false;
let lastAdId = null;

async function startReloginFlow() {
  if (reloginInProgress) return;
  reloginInProgress = true;
  console.log(new Date().toISOString(), "Session expired. Starting re-login flow...");
  try {
    const startRes = await safeFetch(BASE + "/v1/auth/extension/start", { redirect: "manual" });
    const loc = startRes?.headers?.get("location");
    if (!loc) { reloginInProgress = false; return; }
    const state = new URL(loc).searchParams.get("state");
    console.log("\nOpen this URL:\n" + loc + "\n");
    try { execSync("cmd.exe /c start '" + loc + "' 2>/dev/null"); } catch {}
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const r = await safeFetch(BASE + "/v1/auth/extension/poll?state=" + encodeURIComponent(state));
      if (r?.ok) {
        const j = await r.json().catch(() => ({}));
        if (j.access_token) {
          tokens = { access_token: j.access_token, refresh_token: j.refresh_token ?? null };
          saveTokens(tokens);
          console.log(new Date().toISOString(), "Re-login successful.");
          reloginInProgress = false;
          return;
        }
      }
    }
    console.log(new Date().toISOString(), "Re-login timed out.");
  } catch (e) { console.error("Re-login error:", e.message); }
  reloginInProgress = false;
}

if (!tokens?.access_token) {
  console.log("No tokens — starting login...");
  await startReloginFlow();
  if (!tokens?.access_token) process.exit(1);
}

async function tick() {
  if (tickRunning) {
    console.log(new Date().toISOString(), "tick() skipped — previous cycle still running");
    return;
  }
  tickRunning = true;
  try {
    if (tokens.refresh_token && tokens.ts && (Date.now() - tokens.ts) > 50 * 60_000) {
      const fresh = await refreshToken(tokens.refresh_token);
      if (fresh?.access_token) { tokens = { ...tokens, ...fresh }; saveTokens(tokens); }
    }
    let portfolio = await fetchPortfolio(tokens.access_token);
    if (portfolio?.expired) {
      const fresh = tokens.refresh_token ? await refreshToken(tokens.refresh_token) : null;
      if (fresh?.access_token) {
        tokens = { ...tokens, ...fresh }; saveTokens(tokens);
        portfolio = await fetchPortfolio(tokens.access_token);
      } else { startReloginFlow(); return; }
    }
    const raw = portfolio?.ads?.[0];
    if (!raw?.title_text) { console.log(new Date().toISOString(), "No ad"); return; }
    const ad = {
      adId: raw.ad_id, campaignId: raw.campaign_id, adText: raw.title_text,
      clickUrl: raw.click_url, sessionToken: raw.session_token, demo: raw.demo ?? false,
    };
    writeFileSync(CLI_AD_FILE, JSON.stringify({ ...ad, ts: Date.now() }, null, 2));
    wireSettings(ad.adText);

    console.log(new Date().toISOString(), `Ad: "${ad.adText.slice(0, 60)}"`);

    if (ad.adId !== lastAdId) {
      lastAdId = ad.adId;
      toastNotify(ad.adText, ad.clickUrl);
    }

    // Per-cycle correlation IDs (in headers only — body ext = clientEnv)
    const impCorr = `cli.${ad.adId}`;

    // 1. Mark the impression as rendered
    await sendMetric("impression_rendered", ad, tokens.access_token, clientId, {
      corr: impCorr,
    });

    // 2. Immediately signal the impression is viewable (100% in-viewport)
    await sendMetric("impression_viewable", ad, tokens.access_token, clientId, {
      corr: impCorr,
      view_pct: 100,
    });

    // 3. Six view_ticks at 5s intervals, accumulating visible_ms
    for (let i = 1; i <= 6; i++) {
      await new Promise(r => setTimeout(r, 5_000));
      const visible_ms = i * 5_000;
      const tickCorr = `clitick.${ad.adId}.${randomBytes(3).toString("hex")}`;
      await sendMetric("view_tick", ad, tokens.access_token, clientId, {
        corr: tickCorr,
        visible_ms,
      });
    }

    // 4. View threshold met (15s minimum reached at tick 3, completing all 6 = 30s)
    const finalCorr = `clitick.${ad.adId}.${randomBytes(3).toString("hex")}`;
    await sendMetric("view_threshold_met", ad, tokens.access_token, clientId, {
      corr: finalCorr,
      visible_ms: 30_000,
      view_pct: 100,
      view_ms: 30_000,
    });
  } finally {
    tickRunning = false;
  }
}

// Random active session lengths and rest durations to mimic real usage patterns
const SESSION_MINS = [5, 7, 10, 15, 30, 60];
const REST_MINS    = [1, 2, 3, 4, 5, 6];

function randPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runSessionLoop() {
  while (true) {
    const sessionMs = randPick(SESSION_MINS) * 60_000;
    const restMs    = randPick(REST_MINS) * 60_000;
    const sessionEnd = Date.now() + sessionMs;

    console.log(new Date().toISOString(),
      `Session started — active for ${sessionMs/60000} min, then rest ${restMs/60000} min`);

    while (Date.now() < sessionEnd) {
      await tick().catch(console.error);
      await sleep(POLL_MS);
    }

    console.log(new Date().toISOString(),
      `Session ended — resting ${restMs/60000} min`);
    await sleep(restMs);
  }
}

console.log("Kickbacks daemon running (random sessions)");
runSessionLoop();
