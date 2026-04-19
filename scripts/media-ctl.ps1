#Requires -Version 5.1
<#
.SYNOPSIS
    media-ctl.ps1 - Windows management tool for WSL CUDA sidecars

.DESCRIPTION
    Manages all OpenZigs media sidecars running in WSL Ubuntu:

      flux      — FluxQ image generation (port 5005)
      ltx       — LTX video generation (port 5007)
      audio     — Kokoro/F5-TTS speech synthesis (port 5006)
      imgproc   — Real-ESRGAN upscaling + rembg background removal (port 5008)
      music     — ACE-Step music generation (port 5009)
      lipsync   — LatentSync lip sync (port 5010)
      studio    — Music Studio voice2voice pipeline (port 5010)
      sadtalker — SadTalker talking-head generation (port 5011)

    NOTE: lipsync and studio share port 5010 — only one can run at a time.

.EXAMPLE
    .\scripts\media-ctl.ps1 status              # all sidecars
    .\scripts\media-ctl.ps1 flux status
    .\scripts\media-ctl.ps1 flux logs
    .\scripts\media-ctl.ps1 flux restart
    .\scripts\media-ctl.ps1 flux stop
    .\scripts\media-ctl.ps1 flux sync
    .\scripts\media-ctl.ps1 flux generate "a cat on a porch"
    .\scripts\media-ctl.ps1 lipsync restart
    .\scripts\media-ctl.ps1 imgproc health
    .\scripts\media-ctl.ps1 music logs

.PARAMETER Service
    flux | ltx | audio | imgproc | music | lipsync | studio | sadtalker | (omit for unified commands)

.PARAMETER Command
    logs | status | restart | stop | health | sync | generate [prompt]
#>
param(
    [Parameter(Position=0)] [string]$Service = "status",
    [Parameter(Position=1)] [string]$Command = "",
    [Parameter(Position=2, ValueFromRemainingArguments)] [string[]]$Args = @()
)

$WSL_DISTRO = "Ubuntu"
$LOG_DIR    = "/home/mcronin/.openzigs/logs"
$PID_DIR    = "/home/mcronin/.openzigs/pids"
$SIDECAR    = "/home/mcronin/openzigs-sidecars"
$REPO       = "/mnt/c/Users/mgbre/Development/openzigs"

$SERVICES = @{
    flux    = @{ port = 5005; log = "image-gen-cuda.log";     dir = "image-gen";         pid = "image-gen.pid";     label = "FluxQ (image-gen)";       server = "server_cuda.py" }
    audio   = @{ port = 5006; log = "audio-cuda.log";         dir = "audio";             pid = "audio.pid";         label = "Audio (Kokoro/F5-TTS)";   server = "server_cuda.py" }
    ltx     = @{ port = 5007; log = "worker-cuda.log";        dir = "worker";            pid = "worker.pid";        label = "LTX (video-gen)";         server = "server_cuda.py" }
    imgproc = @{ port = 5008; log = "imgproc-cuda.log";       dir = "image-processing";  pid = "imgproc.pid";       label = "ImageProc (upscale/rembg)"; server = "server.py" }
    music   = @{ port = 5009; log = "music-cuda.log";         dir = "music";             pid = "music.pid";         label = "Music (ACE-Step)";        server = "server.py" }
    lipsync = @{ port = 5010; log = "lipsync-cuda.log";       dir = "lipsync";           pid = "lipsync.pid";       label = "LipSync (LatentSync)";    server = "server_cuda.py" }
    studio    = @{ port = 5010; log = "music-studio-cuda.log";  dir = "music-studio";      pid = "music-studio.pid";  label = "Music Studio (voice2voice)"; server = "server.py" }
    sadtalker = @{ port = 5011; log = "sadtalker-cuda.log";     dir = "sadtalker";          pid = "sadtalker.pid";      label = "SadTalker (talking-head)";    server = "server_cuda.py" }
}

function wsl { wsl.exe -d $WSL_DISTRO -- bash -c ($args[0] -replace "`r", "") }

function Get-SvcHealth([string]$svc) {
    $port = $SERVICES[$svc].port
    $label = $SERVICES[$svc].label
    $json = $null
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$port/health" -UseBasicParsing -TimeoutSec 3
        $json = $r.Content | ConvertFrom-Json
        $status = if ($json.is_busy) { "BUSY" } elseif ($json.model_loaded) { "LOADED: $($json.loaded_model)" } else { "idle (no model)" }
        Write-Host "  [OK] $label (port $port) - $status" -ForegroundColor Green
    } catch {
        Write-Host "  [--] $label (port $port) - Offline" -ForegroundColor DarkGray
    }
    return $json
}

function Show-Status {
    Write-Host "`nWSL CUDA Sidecar Status" -ForegroundColor Cyan
    Write-Host "========================" -ForegroundColor Cyan
    Get-SvcHealth "flux"    | Out-Null
    Get-SvcHealth "audio"   | Out-Null
    Get-SvcHealth "ltx"     | Out-Null
    Get-SvcHealth "imgproc" | Out-Null
    Get-SvcHealth "music"   | Out-Null
    Get-SvcHealth "lipsync"   | Out-Null
    Get-SvcHealth "studio"    | Out-Null
    Get-SvcHealth "sadtalker" | Out-Null
    Write-Host ""
    Write-Host "  Note: lipsync + studio share port 5010 (only one at a time)" -ForegroundColor DarkGray
    Write-Host ""
}

function Show-Logs([string]$svc) {
    $logFile = "$LOG_DIR/$($SERVICES[$svc].log)"
    Write-Host "Tailing $($SERVICES[$svc].label) logs (Ctrl+C to exit)..." -ForegroundColor Cyan
    Write-Host "Log: $logFile`n" -ForegroundColor DarkGray
    wsl.exe -d $WSL_DISTRO -- tail -f $logFile
}

function Restart-Svc([string]$svc) {
    $cfg = $SERVICES[$svc]
    $port = $cfg.port
    $dir  = "$SIDECAR/$($cfg.dir)"
    $log  = "$LOG_DIR/$($cfg.log)"
    $pidFile = "$PID_DIR/$($cfg.pid)"
    $serverFile = $cfg.server

    Write-Host "Restarting $($cfg.label)..." -ForegroundColor Yellow

    # Warn if lipsync/studio port conflict
    if ($svc -eq "lipsync" -or $svc -eq "studio") {
        $other = if ($svc -eq "lipsync") { "studio" } else { "lipsync" }
        Write-Host "  Note: this will kill any process on port $port (shared with $other)" -ForegroundColor Yellow
    }

    # Read HF_TOKEN from .env (needed by flux and ltx)
    $hfToken = ""
    if ($svc -eq "flux" -or $svc -eq "ltx") {
        $envLine = Get-Content "C:\Users\mgbre\Development\openzigs\.env" -ErrorAction SilentlyContinue |
                   Select-String "^HF_TOKEN=" | Select-Object -First 1
        if ($envLine) { $hfToken = $envLine.Line.Split("=",2)[1] }
    }

    # Read worker callback secret from config
    $callbackSecret = ""
    try {
        $cfg_json = Get-Content "C:\Users\mgbre\.openzigs\config.json" -Raw | ConvertFrom-Json
        $callbackSecret = $cfg_json.auth.workerSecret
    } catch { }

    # Build per-service environment variable exports
    $envLines = @()
    if ($hfToken) {
        $envLines += "export HF_TOKEN='$hfToken'"
    }
    switch ($svc) {
        "flux" {
            if ($callbackSecret) { $envLines += "export FLUXQ_CALLBACK_SECRET='$callbackSecret'" }
        }
        "ltx" {
            if ($callbackSecret) { $envLines += "export CALLBACK_SECRET='$callbackSecret'" }
            # Optional model override
            $envLines += "export LTX_MODEL_KEY='\${LTX_MODEL_KEY:-ltxv-13b-097-distilled}'"
        }
        "lipsync" {
            if ($callbackSecret) { $envLines += "export CALLBACK_SECRET='$callbackSecret'" }
        }
        "sadtalker" {
            $envLines += "export SADTALKER_DIR='\$HOME/SadTalker'"
            $envLines += "export GALLERY_DIR='\$HOME/.openzigs/gallery'"
            if ($callbackSecret) { $envLines += "export CALLBACK_SECRET='$callbackSecret'" }
            $envLines += "export CALLBACK_URL='http://10.255.255.254:3000/api/queue/callback/complete'"
            $envLines += "export PROGRESS_URL='http://10.255.255.254:3000/api/queue/callback/progress'"
        }
        "music" {
            $envLines += "export ACESTEP_DIR='\$HOME/ace-step'"
            $envLines += "export ACESTEP_DEVICE='cuda'"
        }
    }
    $envBlock = ($envLines -join "`n")

    $script = @"
lsof -ti :$port 2>/dev/null | xargs -r kill -9 2>/dev/null || true
sleep 1
mkdir -p '$LOG_DIR' '$PID_DIR'
$envBlock
nohup bash -c 'cd $dir && source venv/bin/activate && exec python $serverFile --port $port >> $log 2>&1' > /dev/null 2>&1 &
echo `$! > '$pidFile'
disown -a
echo "Started PID `$(cat '$pidFile')"
sleep 2
curl -s http://localhost:$port/health
"@
    wsl $script
}

function Stop-Svc([string]$svc) {
    $port = $SERVICES[$svc].port
    Write-Host "Stopping $($SERVICES[$svc].label) (port $port)..." -ForegroundColor Yellow
    if ($svc -eq "lipsync" -or $svc -eq "studio") {
        $other = if ($svc -eq "lipsync") { "studio" } else { "lipsync" }
        Write-Host "  Note: this kills any process on port $port (shared with $other)" -ForegroundColor Yellow
    }
    wsl "lsof -ti :$port 2>/dev/null | xargs -r kill -9 2>/dev/null && echo 'Stopped' || echo 'Not running'"
}

function Invoke-Generate([string]$prompt) {
    if (-not $prompt) { $prompt = "a beautiful landscape at sunset" }
    Write-Host "Submitting test generation: '$prompt'" -ForegroundColor Cyan
    $body = @{ prompt = $prompt; width = 512; height = 512; steps = 4 } | ConvertTo-Json
    try {
        $auth = Get-Content "C:\Users\mgbre\.openzigs\config.json" | ConvertFrom-Json
        $token = $auth.auth.token
        $r = Invoke-WebRequest -Uri "http://localhost:3000/api/queue/jobs" `
            -Method POST -Body $body -ContentType "application/json" `
            -Headers @{ Authorization = "Bearer $token" } -UseBasicParsing -TimeoutSec 10
        $r.Content | ConvertFrom-Json | Format-List
    } catch {
        Write-Host "Failed: $_" -ForegroundColor Red
    }
}

function Sync-Svc([string]$svc) {
    $cfg = $SERVICES[$svc]
    $srcDir = "$REPO/sidecars/$($cfg.dir)"
    $dstDir = "$SIDECAR/$($cfg.dir)"
    Write-Host "Syncing $($cfg.label): $srcDir -> $dstDir" -ForegroundColor Cyan
    wsl "rsync -av --exclude=venv --exclude=__pycache__ --exclude='*.pyc' '$srcDir/' '$dstDir/'"
}

# ── Dispatch ──────────────────────────────────────────────────────────────────

# Handle: status (no service specified)
if ($Service -eq "status" -and $Command -eq "") {
    Show-Status; exit 0
}

# Handle: restart-all — restart every sidecar sequentially
if ($Service -eq "restart-all") {
    foreach ($svc in @("flux", "audio", "ltx", "imgproc", "music", "lipsync", "sadtalker")) {
        Restart-Svc $svc
        Write-Host ""
    }
    Write-Host "All sidecars restarted (studio skipped -- shares port 5010 with lipsync)" -ForegroundColor Cyan
    exit 0
}

# Handle: stop-all
if ($Service -eq "stop-all") {
    foreach ($svc in @("flux", "audio", "ltx", "imgproc", "music", "lipsync", "sadtalker")) {
        Stop-Svc $svc
    }
    Write-Host "`nAll sidecars stopped." -ForegroundColor Cyan
    exit 0
}

# Handle: sync-all
if ($Service -eq "sync-all") {
    foreach ($svc in @("flux", "audio", "ltx", "imgproc", "music", "lipsync", "studio", "sadtalker")) {
        Sync-Svc $svc
        Write-Host ""
    }
    Write-Host "All sidecars synced." -ForegroundColor Cyan
    exit 0
}

# Handle: <service> <command>
if ($SERVICES.ContainsKey($Service)) {
    $svc = $Service
    $cmd = if ($Command) { $Command } else { "status" }
    switch ($cmd) {
        "logs"     { Show-Logs $svc }
        "status"   { Get-SvcHealth $svc | Out-Null }
        "health"   { Get-SvcHealth $svc | Out-Null }
        "restart"  { Restart-Svc $svc }
        "stop"     { Stop-Svc $svc }
        "sync"     { Sync-Svc $svc }
        "generate" { Invoke-Generate ($Args -join " ") }
        default    { Write-Host "Unknown command '$cmd'. Try: logs, status, restart, stop, sync, generate" -ForegroundColor Red }
    }
    exit 0
}

# Handle: help
if ($Service -eq "help") {
    Get-Help $MyInvocation.MyCommand.Path -Detailed
    exit 0
}

Write-Host @"
Usage: .\scripts\media-ctl.ps1 <service|command> [action] [args...]

Services:
  flux      FluxQ image generation           (port 5005)
  audio     Kokoro/F5-TTS speech synthesis   (port 5006)
  ltx       LTX video generation             (port 5007)
  imgproc   Real-ESRGAN upscale + rembg      (port 5008)
  music     ACE-Step music generation        (port 5009)
  lipsync   LatentSync lip sync              (port 5010)
  studio    Music Studio voice2voice         (port 5010)
  sadtalker SadTalker talking-head           (port 5011)

Actions:
  logs      Tail the sidecar's log file
  status    Check /health endpoint
  health    (alias for status)
  restart   Kill and restart the sidecar
  stop      Kill the sidecar process
  sync      rsync code from repo to WSL deploy dir
  generate  Submit a test image generation job

Global commands:
  status       Show status of all sidecars
  restart-all  Restart all sidecars (except studio, shares port with lipsync)
  stop-all     Stop all sidecars
  sync-all     Sync all sidecar code to WSL
  help         Show detailed help
"@ -ForegroundColor Yellow
