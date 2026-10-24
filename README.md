# DevHub

Toolbox developer lokal: kompres media, kelola project & aksi script, backup & restore database/project, pembersih disk (cleanup), git helper v2, API tester, download, background jobs queue, config editor, serta split `tmux` dengan `agy`, `opencode`, atau AI pilihan — semua dari satu dashboard web di `http://127.0.0.1:7070` atau via jaringan lokal (LAN).

Berjalan native di **macOS, Linux, dan Windows** dengan **Node.js murni tanpa dependency npm**.

---

## Fitur Utama

| Menu | Fungsi |
|---|---|
| **Kompres Media** | Foto, video, audio. macOS pakai `sips` + `avconvert` bawaan; Linux/Windows pakai `ffmpeg`. Upload via browser atau proses file lokal dengan antrian background. |
| **Tugas & Project** | Scan project otomatis (`package.json`, `composer.json`, `index.php`, `artisan`, `manage.py`, `index.html`) + tugas manual. Run/stop dev server dan pantau log realtime. |
| **Aksi Project** | Jalankan skrip per project langsung dari UI atau CLI (`npm run test/build/lint`, `php artisan migrate/seed`, `composer install`). |
| **Backup & Restore** | Backup arsip project (`tar.gz`) + dump database MySQL/MariaDB (`mysqldump`). Restore dengan konfirmasi aman dan opsi timpa atau folder baru. |
| **Cleanup / Penghemat Disk** | Pindai dan bersihkan folder yang bisa di-regenerasi (`node_modules`, `vendor`, `dist`, `build`, `.next`, cache) di dalam `scanRoots` untuk melegakan ruang disk. |
| **Git Helper v2** | Info branch, ganti branch, buat/hapus branch, diff viewer, commit history, stash list/pop, discard changes, dan stage/unstage per file. |
| **AI Launcher Dashboard** | Pilih project dan AI CLI (agy, opencode, claude, codex, gemini, dll.), otomatis buat sesi tmux split dan buka jendela Terminal. |
| **Server & Port** | Daftar port yang listen, kill proses nyangkut, serta start/stop layanan lokal sesuai konfigurasi. |
| **API Tester** | Mini HTTP client alternatif Postman: kirim GET, POST, PUT, DELETE dengan custom header & JSON body, lengkap dengan status, durasi (ms), dan ukuran respons. |
| **Downloader** | Download video/audio via `yt-dlp` jika tersedia, atau fallback `curl` untuk file langsung dengan progress bar. |
| **Antrian Job (Jobs Queue)** | Eksekusi background berurutan untuk tugas berat (backup, download, kompresi) dengan status dan progress realtime via Server-Sent Events (SSE). |
| **Config Editor** | Kelola konfigurasi `config.json` langsung dari UI web (port, scanRoots, scanDepth, services, backup targets). |
| **LAN Mode** | Akses dashboard dari HP atau laptop lain di Wi-Fi yang sama dengan pengamanan password (token). |

---

## Kebutuhan Sistem

- **Node.js 20+** (wajib)
- **git** dan **curl** (disarankan)
- **tmux** untuk split AI `devhub agy` / `opc` / `ai` (macOS/Linux; Windows via WSL)
- **fzf** opsional — pencarian project yang lebih interaktif
- **ffmpeg** untuk kompresi di Linux/Windows (macOS tidak perlu)
- **yt-dlp** opsional untuk download dari situs streaming video/audio

---

## Quick Start

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

### Setup Manual

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

---

## Autostart Saat Login

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

*Linux*: kalau ingin tetap jalan setelah logout, aktifkan linger sekali saja: `sudo loginctl enable-linger $USER`.

---

## Perintah CLI

```bash
devhub                                      # menu interaktif
devhub start                                # nyalakan server di background
devhub stop                                 # matikan server background
devhub restart                              # restart server background
devhub update                               # pull update DevHub (tanpa restart)
devhub update --restart                     # pull + restart server
devhub check                                # cek dependency yang kurang
devhub serve                                # jalankan foreground di http://127.0.0.1:7070
devhub dashboard                            # nyalakan + buka browser otomatis
devhub tasks                                # daftar project terdeteksi
devhub run [nama]                           # jalankan dev server project
devhub actions [nama]                       # pilih & jalankan skrip project (migrate/test/build)
devhub agy [nama]                           # pilih project → tmux: dev server + agy
devhub opc [nama]                           # pilih project → tmux: dev server + opencode
devhub ai [nama]                            # pilih project + AI apa saja (agy/opencode/claude/…)
devhub ai --list                            # daftar AI CLI yang terdeteksi di sistem
devhub backup list                          # daftar arsip backup yang ada
devhub backup create                        # buat backup project + database
devhub backup restore [file]                # restore arsip backup
devhub backup delete [file]                 # hapus arsip backup
devhub clean [--scan|--yes]                 # pindai atau bersihkan node_modules/build di scanRoots
devhub jobs [cancel <id>]                   # pantau antrian job background
devhub compress foto.jpg --quality=70       # kompres foto
devhub compress video.mov --preset=720p     # kompres video
devhub ports                                # lihat port yang sedang listen
devhub ports kill 1234                      # matikan proses berdasarkan PID
devhub git [path] status|pull|push|commit   # operasi git
devhub download "https://…" --audio        # unduh file/audio/video
devhub config [show|path|edit]              # lihat atau edit file konfigurasi
devhub lan [on|off|status]                  # aktifkan akses dashboard dari jaringan Wi-Fi lokal
devhub status                               # status layanan + server background
devhub autostart [on|off|status]            # konfigurasi autostart saat boot/login
```

---

## Split AI: `agy`, `opc`, `ai`

Menjalankan dev server di pane kiri dan AI CLI di pane kanan dalam satu sesi `tmux`:

```text
┌───────────────────────────┬───────────────────────────┐
│ dev · NamaProject         │ agy / opencode / AI       │
│ $ npm run dev             │ $ agy                     │
│                           │                           │
└───────────────────────────┴───────────────────────────┘
```

| Perintah | AI di Pane Kanan |
|---|---|
| `devhub agy [project]` | `agy` (Antigravity) |
| `devhub opc [project]` | `opencode` |
| `devhub ai [project]` | pilih dari AI yang terdeteksi |
| `devhub ai --ai=claude [project]` | langsung gunakan AI tertentu |
| `devhub ai --list` | lihat semua AI dan status install-nya |

Dukungan AI CLI: `agy`, `opencode`, `claude`, `codex`, `gemini`, `aider`, `cursor-agent`, `copilot`, `qwen`, `crush`, `goose`, `amp`.

---

## Akses LAN & Keamanan

Secara default, DevHub hanya bind ke `127.0.0.1` (localhost). Jika kamu ingin mengakses dashboard dari perangkat lain (misal HP atau laptop lain di Wi-Fi yang sama):

```bash
devhub lan on       # mengaktifkan host 0.0.0.0 & menghasilkan access token
devhub lan status   # melihat IP LAN, URL akses, dan token password
devhub lan off      # mengembalikan bind ke localhost (127.0.0.1)
```

### Mekanisme Keamanan:
- **Akses Lokal (`localhost` / `127.0.0.1`)**: Tetap instan tanpa password.
- **Akses Jaringan (`192.168.x.x`)**: Dilindungi HTTP Basic Auth. Browser akan meminta login:
  - **Username**: bebas (boleh dikosongkan atau diisi apa saja)
  - **Password**: masukkan *Access Token* yang tertera pada `devhub lan status`
- Token disimpan aman di `~/.config/devhub/config.json` dan divalidasi dengan *timing-safe comparison*.

---

## Konfigurasi

File konfigurasi berada di:
- **macOS / Linux**: `~/.config/devhub/config.json`
- **Windows**: `%APPDATA%\devhub\config.json`

Contoh konfigurasi lengkap:

```json
{
  "port": 7070,
  "host": "0.0.0.0",
  "accessToken": "token_acak_devhub",
  "scanRoots": [
    "/Users/kamu/Projects",
    "/Users/kamu/Sites"
  ],
  "scanDepth": 2,
  "outputDir": "/Users/kamu/.local/share/devhub/output",
  "downloadDir": "/Users/kamu/Downloads",
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
  ],
  "backup": {
    "dir": "",
    "targets": [
      {
        "id": "brmotor",
        "label": "BR Motor",
        "path": "/Users/kamu/BRMotor",
        "database": {
          "engine": "mariadb",
          "name": "br_motor",
          "user": "root",
          "socket": "/tmp/mysql.sock",
          "binDir": "/opt/local/lib/mariadb-11.4/bin"
        }
      }
    ]
  }
}
```

---

## Lokasi Data

| Data | macOS / Linux | Windows |
|---|---|---|
| Config & tasks | `~/.config/devhub/` | `%APPDATA%\devhub\` |
| Output kompresi | `~/.local/share/devhub/output/` | `%LOCALAPPDATA%\devhub\output\` |
| Log | `~/.local/share/devhub/logs/` | `%LOCALAPPDATA%\devhub\logs\` |
| Download | `~/Downloads/` | `%USERPROFILE%\Downloads\` |
| Backup | `~/.local/share/devhub/backups/` | `%LOCALAPPDATA%\devhub\backups\` |

---

## Lisensi

MIT — lihat [LICENSE](LICENSE).
