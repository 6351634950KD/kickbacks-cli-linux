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
curl -fsSL "$REPO/kickbacks-daemon.mjs"       -o "$VIBE_DIR/kickbacks-daemon.mjs"
echo "[✓] kickbacks-daemon.mjs"

curl -fsSL "$REPO/kickbacks-login.mjs"        -o "$VIBE_DIR/kickbacks-login.mjs"
echo "[✓] kickbacks-login.mjs"

curl -fsSL "$REPO/vibe-ads-statusline.mjs"    -o "$VIBE_DIR/vibe-ads-statusline.mjs"
echo "[✓] vibe-ads-statusline.mjs"

chmod +x "$VIBE_DIR/kickbacks-daemon.mjs" "$VIBE_DIR/kickbacks-login.mjs"

# ── 4. Wire ~/.claude/settings.json ─────────────────────────────────────────
if [ ! -f "$CLAUDE_SETTINGS" ]; then
  echo '{}' > "$CLAUDE_SETTINGS"
fi
node --input-type=module << EOF
import { readFileSync, writeFileSync } from "node:fs";
let s = {};
try { s = JSON.parse(readFileSync("$CLAUDE_SETTINGS", "utf8")); } catch {}
s.statusLine = { type: "command", command: "node $VIBE_DIR/vibe-ads-statusline.mjs" };
writeFileSync("$CLAUDE_SETTINGS", JSON.stringify(s, null, 2));
console.log("[✓] statusLine wired in settings.json");
EOF

# ── 5. Systemd service ───────────────────────────────────────────────────────
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

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Sign in:    node ~/.vibe-ads/kickbacks-login.mjs"
echo "  2. Start:      systemctl --user start kickbacks.service"
echo "  3. Logs:       tail -f ~/.vibe-ads/daemon.log"
echo ""
echo "One-liner to reinstall/update anytime:"
echo "  curl -fsSL https://raw.githubusercontent.com/6351634950KD/kickbacks-cli-linux/master/install.sh | bash"
