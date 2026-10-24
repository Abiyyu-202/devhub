# DevHub

Toolbox developer lokal: kompres media, kelola project, port, git, download, plus split `tmux` + `agy` — semua dari satu dashboard web di `http://127.0.0.1:7070`.

Berjalan native di **macOS, Linux, dan Windows** dengan **Node.js murni tanpa dependency npm**.

## Fitur

| Menu | Fungsi |
|---|---|
| **Kompres Media** | Foto, video, audio. macOS pakai `sips` + `avconvert` bawaan; Linux/Windows pakai `ffmpeg`. Upload lewat browser atau proses path lokal. |
| **Tugas & Project** | Scan project otomatis (`package.json`, `composer.json`, `index.php`, `artisan`, `manage.py`, `index.html`) + tugas manual. Run/stop dev server dan lihat log realtime. |
| **Server & Port** | Daftar port yang listen, kill proses nyangkut, dan start/stop layanan lokal sesuai config. |
| **Git Helper** | Branch, ahead/behind, file berubah, commit all, pull, push. |
| **Downloader** | `yt-dlp` kalau tersedia, fallback `curl` untuk file langsung. |

## Kebutuhan

- **Node.js 20+** (wajib)
- **git** dan **curl** (disarankan)
- **tmux** untuk `devhub agy` (macOS/Linux; Windows via WSL)
- **fzf** opsional — pencarian project yang lebih nyaman
- **ffmpeg** untuk kompresi di Linux/Windows (macOS tidak perlu)
- **yt-dlp** opsional untuk download dari situs streaming

## Quick start

```bash
git clone https://github.com/Abiyyu-202/devhub.git
cd devhub

# macOS / Linux
./scripts/setup.sh --install --start

# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Install -Start
```

Script akan mengecek dependency, memasang yang kurang (opsional), membuat launcher `devhub`, lalu menjalankan server. Tanpa `--install` script hanya melaporkan dependency yang belum ada.

Buka **http://127.0.0.1:7070**.

### Setup manual

```bash
# macOS / Linux
chmod +x bin/devhub
ln -sfn "$PWD/bin/devhub" ~/.local/bin/devhub   # pastikan ~/.local/bin ada di PATH
node cli.mjs start
```

```powershell
# Windows
node cli.mjs start
# lalu buat shim devhub.cmd berisi: node "C:\path\ke\devhub\cli.mjs" %*
```

## Autostart saat login

```bash
devhub autostart on       # aktifkan
devhub autostart status   # cek status
devhub autostart off      # matikan
```

| OS | Mekanisme | Lokasi |
|---|---|---|
| macOS | launchd user agent | `~/Library/LaunchAgents/local.devhub.plist` |
| Linux | systemd user unit | `~/.config/systemd/user/devhub.service` |
| Windows | Startup folder (VBS, tanpa jendela) | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DevHub.vbs` |

Linux: kalau ingin tetap jalan setelah logout, aktifkan linger sekali saja: `sudo loginctl enable-linger $USER`.

## Perintah CLI

```bash
devhub                      # menu interaktif
devhub start                # nyalakan server di background
devhub stop                 # matikan server background
devhub serve                # foreground di http://127.0.0.1:7070
devhub dashboard            # nyalakan + buka browser
devhub tasks                # daftar project terdeteksi
devhub run "Nama Project"   # jalankan dev server project
devhub agy "Nama Project"   # tmux split: kiri dev server, kanan agy
devhub compress foto.jpg --quality=70 --max=1600
devhub compress video.mov --preset=720p
devhub ports                # lihat port yang listen
devhub ports kill 1234
devhub git ~/Project status
devhub git ~/Project commit "pesan"
devhub git ~/Project push
devhub download "https://…" --audio
devhub status               # status layanan + server
devhub autostart on|off|status
```

## `devhub agy`

Memilih project (pakai `fzf` kalau ada, kalau tidak menu bernomor), lalu membuat sesi tmux:

```
┌───────────────────────────┬───────────────────────────┐
│ dev · NamaProject         │ agy                       │
│ $ npm run dev             │ $ agy                     │
│                           │                           │
└───────────────────────────┴───────────────────────────┘
```

- macOS: `brew install tmux`
- Debian/Ubuntu: `sudo apt install tmux`
- Windows: jalankan DevHub dari **WSL**, karena tmux tidak tersedia native.

`agy` diambil dari `PATH` (termasuk `~/.local/bin`). Kalau belum login, pane kanan akan menampilkan instruksi login dari `agy` itu sendiri.

## Konfigurasi

Config: `~/.config/devhub/config.json` (Linux/macOS) atau `%APPDATA%\devhub\config.json` (Windows).

```json
{
  "port": 7070,
  "scanRoots": ["/Users/kamu/Projects", "/Users/kamu/Sites"],
  "scanDepth": 2,
  "image": { "quality": 75, "maxDim": 1920 },
  "video": { "preset": "1080p" },
  "services": [
    {
      "id": "mariadb",
      "label": "MariaDB",
      "port": 3306,
      "start": ["brew", "services", "start", "mariadb"],
      "stop": ["brew", "services", "stop", "mariadb"]
    },
    {
      "id": "phpmyadmin",
      "label": "phpMyAdmin",
      "url": "http://127.0.0.1:8080/",
      "start": "php -S 127.0.0.1:8080 -t /path/ke/phpmyadmin",
      "stop": ["pkill", "-f", "php -S 127.0.0.1:8080"]
    }
  ]
}
```

- `services` sepenuhnya bebas: isi `port` atau `url` untuk status, dan `start`/`stop` (string shell atau array argv) untuk kontrol.
- Tanpa `services`, menu Server & Port tetap menampilkan semua port yang listen.
- Tugas manual disimpan di `tasks.json` (lebih mudah lewat UI).

## Lokasi data

| Data | macOS / Linux | Windows |
|---|---|---|
| Config & tasks | `~/.config/devhub/` | `%APPDATA%\devhub\` |
| Output kompresi | `~/.local/share/devhub/output/` | `%LOCALAPPDATA%\devhub\output\` |
| Log | `~/.local/share/devhub/logs/` | `%LOCALAPPDATA%\devhub\logs\` |
| Download | `~/Downloads/` | `%USERPROFILE%\Downloads\` |

## Backend kompresi

| OS | Foto | Video / audio |
|---|---|---|
| macOS | `sips` (bawaan) | `avconvert` (bawaan) |
| Linux / Windows | `ffmpeg` | `ffmpeg` |

Kalau hasil kompresi tidak lebih kecil, file asli dipertahankan dan hasilnya ditandai **"Sudah optimal"**.

Install ffmpeg:

```bash
# macOS
brew install ffmpeg
# Debian/Ubuntu
sudo apt install ffmpeg
# Fedora
sudo dnf install ffmpeg
# Windows
winget install Gyan.FFmpeg
```

## Keamanan

Server hanya bind ke `127.0.0.1` dan **tidak punya autentikasi**. Jangan expose port `7070` ke jaringan publik. DevHub bisa menjalankan perintah shell dari config dan UI, jadi perlakukan seperti terminal lokal.

## Lisensi

MIT — lihat [LICENSE](LICENSE).
