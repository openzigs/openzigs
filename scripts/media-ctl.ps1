#Requires -Version 5.1
<#
.SYNOPSIS
    media-ctl.ps1 - Windows equivalent of media-ctl.sh for WSL CUDA sidecars

.DESCRIPTION
    Manages FluxQ (image-gen), LTX (video-gen), and Audio sidecars running in WSL Ubuntu.

.EXAMPLE
    .\scripts\media-ctl.ps1 flux logs
    .\scripts\media-ctl.ps1 flux status
    .\scripts\media-ctl.ps1 ltx logs
    .\scripts\media-ctl.ps1 status
    .\scripts\media-ctl.ps1 flux restart
    .\scripts\media-ctl.ps1 flux generate "a cat on a porch"

.PARAMETER Service
    flux | ltx | audio | (omit for unified commands)

.PARAMETER Command
    logs | status | restart | stop | health | generate [prompt]
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
    flux  = @{ port = 5005; log = "image-gen-cuda.log"; dir = "image-gen"; pid = "image-gen.pid"; label = "FluxQ (image-gen)" }
    ltx   = @{ port = 5007; log = "worker-cuda.log";    dir = "worker";    pid = "worker.pid";    label = "LTX (video-gen)"  }
    audio = @{ port = 5006; log = "audio-cuda.log";     dir = "audio";     pid = "audio.pid";     label = "Audio (Kokoro)"   }
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
    Get-SvcHealth "flux"  | Out-Null
    Get-SvcHealth "ltx"   | Out-Null
    Get-SvcHealth "audio" | Out-Null
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

    Write-Host "Restarting $($cfg.label)..." -ForegroundColor Yellow

    # Read HF_TOKEN from .env for image-gen
    $hfToken = ""
    if ($svc -eq "flux") {
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

    # Map service to its callback secret env var
    $secretEnvLine = ""
    if ($callbackSecret) {
        switch ($svc) {
            "flux"  { $secretEnvLine = "export FLUXQ_CALLBACK_SECRET='$callbackSecret'" }
            "ltx"   { $secretEnvLine = "export CALLBACK_SECRET='$callbackSecret'" }
        }
    }

    $script = @"
lsof -ti :$port 2>/dev/null | xargs -r kill -9 2>/dev/null || true
sleep 1
mkdir -p '$LOG_DIR' '$PID_DIR'
$(if ($hfToken) { "export HF_TOKEN='$hfToken'" } else { "" })
$(if ($secretEnvLine) { $secretEnvLine } else { "" })
nohup bash -c 'cd $dir && source venv/bin/activate && exec python server.py --port $port >> $log 2>&1' > /dev/null 2>&1 &
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

# Handle: status / help as first arg
if ($Service -eq "help") {
    Get-Help $MyInvocation.MyCommand.Path -Detailed
    exit 0
}

Write-Host "Usage: .\scripts\media-ctl.ps1 <flux|ltx|audio|status> [logs|status|restart|stop|sync|generate]" -ForegroundColor Yellow
