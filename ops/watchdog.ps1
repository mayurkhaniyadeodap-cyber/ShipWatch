# Idempotent watchdog: make sure ShipWatch is running, start it if not.
# Run at logon (Startup) AND every 2 min (scheduled task) — the port check keeps it
# from ever starting a second instance, so it doubles as crash-recovery + boot-start.
$ErrorActionPreference = "SilentlyContinue"

$listening = Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue
if ($listening) { return }   # already up — nothing to do

$root = "C:\Users\DeoDap\Desktop\projects\P\ShipWatch"
$node = "C:\Program Files\nodejs\node.exe"   # Node v24 (better-sqlite3-safe)
Start-Process -FilePath $node `
  -ArgumentList "node_modules\next\dist\bin\next", "start", "-H", "127.0.0.1" `
  -WorkingDirectory $root -WindowStyle Hidden
