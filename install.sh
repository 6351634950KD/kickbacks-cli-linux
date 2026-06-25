#!/usr/bin/env bash
# Kickbacks.ai — one-shot installer for Claude Code CLI (Linux / WSL / Kali)
# Usage: curl -fsSL https://raw.githubusercontent.com/6351634950KD/kickbacks-cli-linux/master/install.sh | bash
set -e

REPO="https://raw.githubusercontent.com/6351634950KD/kickbacks-cli-linux/master"
VIBE_DIR="$HOME/.vibe-ads"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
SERVICE_DIR="$HOME/.config/systemd/user"

echo "=== Kickbacks.ai CLI Installer ==="
echo "[*] Pulling latest files from GitHub..."

# ── 1. Dependencies ──────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "[*] Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "[✓] Node.js $(node --version)"

# ── 2. Create dirs ───────────────────────────────────────────────────────────
mkdir -p "$VIBE_DIR" "$HOME/.claude"
chmod 700 "$VIBE_DIR"

# ── 3. Download scripts from GitHub ─────────────────────────────────────────
curl -fsSL "$REPO/kickbacks-daemon.mjs"    -o "$VIBE_DIR/kickbacks-daemon.mjs"
echo "[✓] kickbacks-daemon.mjs"

curl -fsSL "$REPO/kickbacks-login.mjs"     -o "$VIBE_DIR/kickbacks-login.mjs"
echo "[✓] kickbacks-login.mjs"

curl -fsSL "$REPO/vibe-ads-statusline.mjs" -o "$VIBE_DIR/vibe-ads-statusline.mjs"
echo "[✓] vibe-ads-statusline.mjs"

chmod +x "$VIBE_DIR/kickbacks-daemon.mjs" "$VIBE_DIR/kickbacks-login.mjs"

# ── WSL2: enable mirrored networking so loopback reaches VS Code on Windows ──
if grep -qi microsoft /proc/version 2>/dev/null; then
  WIN_HOME=$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r')
  if [ -n "$WIN_HOME" ]; then
    WSL_HOME=$(wslpath "$WIN_HOME" 2>/dev/null)
    WSLCONFIG="$WSL_HOME/.wslconfig"
    if ! grep -q "networkingMode=mirrored" "$WSLCONFIG" 2>/dev/null; then
      echo "" >> "$WSLCONFIG" 2>/dev/null || true
      printf "[wsl2]\nnetworkingMode=mirrored\n" >> "$WSLCONFIG"
      echo "[✓] WSL2 mirrored networking enabled (restart WSL once: wsl --shutdown)"
    else
      echo "[✓] WSL2 mirrored networking already enabled"
    fi
  fi
fi

# ── Install Node dependencies (better-sqlite3 for loopback port discovery) ──
echo "[*] Installing Node dependencies..."
cd "$VIBE_DIR" && npm init -y > /dev/null 2>&1 && npm install better-sqlite3 --silent 2>/dev/null \
  && echo "[✓] Node dependencies installed" \
  || echo "[!] npm install failed — loopback billing may not work"
cd "$HOME"

# ── 4. Install kickbacks.ai VS Code extension (enables billed impressions) ──
if command -v code &>/dev/null; then
  VSIX_TMP=""
  if grep -qi microsoft /proc/version 2>/dev/null; then
    WIN_TEMP=$(cmd.exe /c "echo %TEMP%" 2>/dev/null | tr -d '\r')
    [ -n "$WIN_TEMP" ] && VSIX_TMP="$(wslpath "$WIN_TEMP" 2>/dev/null)/kickbacks-ai.vsix"
  fi
  [ -z "$VSIX_TMP" ] && VSIX_TMP="/tmp/kickbacks-ai.vsix"

  echo "[*] Downloading kickbacks.ai VS Code extension..."
  if curl -fsSL "https://kickbacks.ai/vsix" -o "$VSIX_TMP" 2>/dev/null; then
    if grep -qi microsoft /proc/version 2>/dev/null && [ -n "$WIN_TEMP" ]; then
      code --install-extension "${WIN_TEMP}\\kickbacks-ai.vsix" 2>/dev/null \
        && echo "[✓] kickbacks.ai VS Code extension installed" \
        || echo "[!] Extension install failed — run: code --install-extension \"${WIN_TEMP}\\kickbacks-ai.vsix\""
    else
      code --install-extension "$VSIX_TMP" 2>/dev/null \
        && echo "[✓] kickbacks.ai VS Code extension installed" \
        || echo "[!] Extension install failed — run: code --install-extension $VSIX_TMP"
    fi
  else
    echo "[!] Could not download extension — get it from https://kickbacks.ai/vsix"
  fi
else
  echo "[!] VS Code not found — install kickbacks.ai extension manually from https://kickbacks.ai/vsix"
fi

# ── 5. Wire ~/.claude/settings.json ─────────────────────────────────────────
[ ! -f "$CLAUDE_SETTINGS" ] && echo '{}' > "$CLAUDE_SETTINGS"
node --input-type=module << EOF
import { readFileSync, writeFileSync } from "node:fs";
let s = {};
try { s = JSON.parse(readFileSync("$CLAUDE_SETTINGS", "utf8")); } catch {}
s.statusLine = { type: "command", command: "node $VIBE_DIR/vibe-ads-statusline.mjs" };
writeFileSync("$CLAUDE_SETTINGS", JSON.stringify(s, null, 2));
console.log("[✓] statusLine wired in settings.json");
EOF

# ── 6. Systemd service ───────────────────────────────────────────────────────
if systemctl --user status &>/dev/null 2>&1; then
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE_DIR/kickbacks.service" << SERVICE
[Unit]
Description=Kickbacks.ai ad daemon for Claude Code CLI
After=network-online.target

[Service]
ExecStart=$(which node) $VIBE_DIR/kickbacks-daemon.mjs
Restart=always
RestartSec=30
StartLimitIntervalSec=0
StandardOutput=append:$VIBE_DIR/daemon.log
StandardError=append:$VIBE_DIR/daemon.log

[Install]
WantedBy=default.target
SERVICE
  systemctl --user daemon-reload
  systemctl --user enable kickbacks.service
  loginctl enable-linger "$USER" 2>/dev/null || true
  echo "[✓] systemd service installed & enabled (auto-start on boot)"
else
  BASHRC="$HOME/.bashrc"
  if ! grep -q "kickbacks-daemon" "$BASHRC" 2>/dev/null; then
    echo "" >> "$BASHRC"
    echo "# Kickbacks.ai daemon (auto-start)" >> "$BASHRC"
    echo "pgrep -f kickbacks-daemon.mjs > /dev/null || node $VIBE_DIR/kickbacks-daemon.mjs >> $VIBE_DIR/daemon.log 2>&1 &" >> "$BASHRC"
    echo "[✓] Auto-start added to ~/.bashrc (systemd not available)"
  fi
fi

# ── 7. Sign in (runs login flow right now) ───────────────────────────────────
echo ""
echo "=== Sign in to Kickbacks.ai ==="

# Skip login if valid token already exists
SKIP_LOGIN=false
if [ -f "$VIBE_DIR/tokens.json" ]; then
  TOKEN_OK=$(node --input-type=module << 'TOKENCHECK'
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
try {
  const t = JSON.parse(readFileSync(join(homedir(), ".vibe-ads", "tokens.json"), "utf8"));
  if (!t.access_token) { process.exit(1); }
  const payload = JSON.parse(Buffer.from(t.access_token.split(".")[1], "base64").toString());
  const ok = payload.exp && payload.exp * 1000 > Date.now() + 60000;
  process.stdout.write(ok ? "yes" : "no");
} catch { process.stdout.write("no"); }
TOKENCHECK
  )
  [ "$TOKEN_OK" = "yes" ] && SKIP_LOGIN=true
fi

if [ "$SKIP_LOGIN" = "true" ]; then
  echo "[✓] Already signed in — skipping login"
else
  echo "[*] Opening browser for sign-in..."
  node "$VIBE_DIR/kickbacks-login.mjs"
fi

# ── 8. Start the daemon ───────────────────────────────────────────────────────
echo ""
if systemctl --user status &>/dev/null 2>&1; then
  systemctl --user restart kickbacks.service
  sleep 3
  if systemctl --user is-active --quiet kickbacks.service; then
    echo "[✓] Daemon started and running"
  else
    echo "[!] Daemon failed to start — check: tail -f $VIBE_DIR/daemon.log"
  fi
else
  pkill -f kickbacks-daemon.mjs 2>/dev/null || true
  nohup node "$VIBE_DIR/kickbacks-daemon.mjs" >> "$VIBE_DIR/daemon.log" 2>&1 &
  sleep 2
  echo "[✓] Daemon started"
fi

echo ""
echo "=== All done! Kickbacks.ai is running ==="
echo ""
echo "Check earnings:  grep 'lifetime' $VIBE_DIR/daemon.log | tail -1"
echo "Watch logs:      tail -f $VIBE_DIR/daemon.log"
echo "Update anytime:  curl -fsSL https://raw.githubusercontent.com/6351634950KD/kickbacks-cli-linux/master/install.sh | bash"
