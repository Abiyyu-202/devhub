#!/usr/bin/env bash
# DevHub setup for macOS and Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS="$(uname -s)"
INSTALL=0
AUTOSTART=0
START=0
WITH_YTDLP=0

usage() {
  cat <<'EOF'
DevHub setup

  ./scripts/setup.sh [options]

Options:
  --install       Install missing dependencies (tmux, fzf, ffmpeg, git, curl)
  --autostart     Enable DevHub autostart after setup
  --start         Start the DevHub server after setup
  --with-ytdlp    Also install yt-dlp (optional, for streaming sites)
  -h, --help      Show this help

Without --install, the script only checks dependencies and prints the commands.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --autostart) AUTOSTART=1 ;;
    --start) START=1 ;;
    --with-ytdlp) WITH_YTDLP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opsi tidak dikenal: $arg" >&2; usage; exit 1 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

echo "DevHub setup · $OS"

if ! have node; then
  echo "✖ Node.js belum terpasang (butuh Node 20+)." >&2
  if [ "$OS" = "Darwin" ]; then
    echo "  brew install node" >&2
  else
    echo "  Ubuntu/Debian: sudo apt install nodejs npm" >&2
    echo "  Atau pakai NodeSource: https://nodejs.org/en/download" >&2
  fi
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✖ Node $(node -v) terlalu lama. Butuh Node 20+." >&2
  exit 1
fi
echo "✔ Node $(node -v)"

MISSING=()
have tmux || MISSING+=("tmux")
have fzf || MISSING+=("fzf")
have git || MISSING+=("git")
have curl || MISSING+=("curl")
if [ "$OS" != "Darwin" ]; then
  have ffmpeg || MISSING+=("ffmpeg")
fi

if [ "$WITH_YTDLP" -eq 1 ] && ! have yt-dlp; then
  NEED_YTDLP=1
else
  NEED_YTDLP=0
fi

install_linux() {
  local packages=("$@")
  if have apt-get; then
    sudo apt-get update
    sudo apt-get install -y "${packages[@]}"
  elif have dnf; then
    sudo dnf install -y "${packages[@]}"
  elif have pacman; then
    sudo pacman -S --needed --noconfirm "${packages[@]}"
  elif have zypper; then
    sudo zypper --non-interactive install "${packages[@]}"
  else
    echo "✖ Package manager tidak dikenal. Install manual: ${packages[*]}" >&2
    return 1
  fi
}

if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "Dependency belum lengkap: ${MISSING[*]}"
  if [ "$INSTALL" -eq 1 ]; then
    if [ "$OS" = "Darwin" ]; then
      if ! have brew; then
        echo "✖ Homebrew belum ada: https://brew.sh" >&2
        exit 1
      fi
      brew install "${MISSING[@]}"
    else
      install_linux "${MISSING[@]}"
    fi
  else
    echo "Jalankan ulang dengan --install, atau install manual:"
    if [ "$OS" = "Darwin" ]; then
      echo "  brew install ${MISSING[*]}"
    else
      echo "  sudo apt install ${MISSING[*]}   # Debian/Ubuntu"
      echo "  sudo dnf install ${MISSING[*]}   # Fedora"
      echo "  sudo pacman -S ${MISSING[*]}     # Arch"
    fi
  fi
else
  echo "✔ Dependency dasar lengkap"
fi

if [ "$NEED_YTDLP" -eq 1 ]; then
  if [ "$OS" = "Darwin" ] && have brew; then
    brew install yt-dlp
  elif have pipx; then
    pipx install yt-dlp
  elif have python3; then
    python3 -m pip install --user yt-dlp || true
  fi
fi

# Launcher symlink.
if [ -n "${DEVHUB_BIN_DIR:-}" ]; then
  BIN_DIR="$DEVHUB_BIN_DIR"
elif [ -w /usr/local/bin ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi
mkdir -p "$BIN_DIR"
chmod +x "$ROOT/bin/devhub"
ln -sfn "$ROOT/bin/devhub" "$BIN_DIR/devhub"
echo "✔ devhub → $BIN_DIR/devhub"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "⚠ Tambahkan $BIN_DIR ke PATH agar perintah 'devhub' bisa dipanggil." ;;
esac

if [ "$AUTOSTART" -eq 1 ]; then
  echo "→ Mengaktifkan autostart…"
  node "$ROOT/cli.mjs" autostart on
fi

if [ "$START" -eq 1 ]; then
  echo "→ Menjalankan DevHub…"
  node "$ROOT/cli.mjs" start
fi

cat <<EOF

Selesai.
  Dashboard : node "$ROOT/cli.mjs" dashboard
  Autostart : devhub autostart on
  Status    : devhub status
  agy split : devhub agy / opc / ai   (butuh tmux)

EOF
