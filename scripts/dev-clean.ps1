<#
.SYNOPSIS
    OpenZigs development startup script for Windows.

.DESCRIPTION
    Kills existing OpenZigs processes and starts the backend + UI development servers,
    and launches the WSL CUDA sidecars (Flux image-gen/5005, Audio/5006, LTX worker/5007).
    This is the Windows equivalent of dev-clean.sh.

.EXAMPLE
    .\scripts\dev-clean.ps1
#>

$ErrorActionPreference = "Stop"

# Refresh PATH from registry (background terminals may not inherit user PATH)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

# ---- Helpers ----------------------------------------------------------------
function Write-Info  { Write-Host "[clean-start] $args" -ForegroundColor Cyan }
function Write-Ok    { Write-Host "[clean-start] $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "[clean-start] $args" -ForegroundColor Yellow }

# ---- Resolve paths ----------------------------------------------------------
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Info "Project root: $ProjectRoot"

# ---- Kill existing processes ------------------------------------------------
Write-Info "Killing existing OpenZigs processes..."

# Force-kill ALL node processes via taskkill (elevated if needed)
$nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue
if ($nodeProcs) {
    Write-Info "Killing $($nodeProcs.Count) node processes..."
    $r = taskkill /F /IM node.exe 2>&1
    if ($r -match "Access is denied") {
        Write-Info "Elevating to kill protected node processes..."
        Start-Process -FilePath "taskkill" -ArgumentList "/F /IM node.exe" -Verb RunAs -Wait -ErrorAction SilentlyContinue
    }
}

# Kill any Python MCP server children
$pyProcs = Get-Process -Name "python","python3" -ErrorAction SilentlyContinue
if ($pyProcs) {
    Write-Info "Killing $($pyProcs.Count) python processes..."
    $r = taskkill /F /IM python.exe 2>&1
    if ($r -match "Access is denied") {
        Write-Info "Elevating to kill protected python processes..."
        Start-Process -FilePath "taskkill" -ArgumentList "/F /IM python.exe" -Verb RunAs -Wait -ErrorAction SilentlyContinue
    }
}

# Kill orphaned cmd.exe batch processes that may hold log file handles open
$openzigsBats = Get-ChildItem "$env:TEMP\openzigs-*.bat" -ErrorAction SilentlyContinue
if ($openzigsBats) {
    Write-Info "Found $($openzigsBats.Count) OpenZigs batch files -- killing background cmd processes"
    $cmdProcs = Get-Process -Name "cmd" -ErrorAction SilentlyContinue
    if ($cmdProcs) {
        $r = taskkill /F /IM cmd.exe 2>&1
        if ($r -match "Access is denied") {
            Write-Info "Elevating to kill protected cmd processes..."
            Start-Process -FilePath "taskkill" -ArgumentList "/F /IM cmd.exe" -Verb RunAs -Wait -ErrorAction SilentlyContinue
        }
    }
}

# Also kill WSL sidecar ports in Ubuntu (these forward to Windows localhost via WSL NAT)
if (Get-Command wsl -ErrorAction SilentlyContinue) {
    $wslKillCmd = 'for p in 5005 5006 5007 5009; do lsof -ti :$p 2>/dev/null | xargs -r kill -9 2>/dev/null; done; true'
    wsl -d Ubuntu -e bash -c $wslKillCmd 2>&1 | Out-Null
}

$Ports = @(3000, 3001, 3101)
foreach ($Port in $Ports) {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $conns) {
        $p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($p) {
            Write-Info "Killing process on port $Port (PID $($p.Id), $($p.ProcessName))"
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

Start-Sleep -Seconds 2

# Remove stale log files so new processes can write cleanly
$staleLogs = @(
    (Join-Path $ProjectRoot ".openzigs-dev.log"),
    (Join-Path $ProjectRoot ".openzigs-ui.log")
)
foreach ($log in $staleLogs) {
    if (Test-Path $log) {
        Remove-Item $log -Force -ErrorAction SilentlyContinue
    }
}

# ---- Stop Firecrawl if running ----------------------------------------------
$FirecrawlCompose = Join-Path $ProjectRoot "docker-compose.firecrawl.yml"
if ((Test-Path $FirecrawlCompose) -and (Get-Command docker -ErrorAction SilentlyContinue)) {
    try { & docker compose -f $FirecrawlCompose down 2>&1 | Out-Null } catch { }
}

# ---- Configure UI .env.local ------------------------------------------------
$ConfigFile = Join-Path $env:USERPROFILE ".openzigs\config.json"
$UiEnvFile  = Join-Path $ProjectRoot "ui\.env.local"

if (Test-Path $ConfigFile) {
    try {
        $cfg   = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        $token = $cfg.auth.token
        if ($token) {
            $envContent = "NEXT_PUBLIC_OPENZIGS_API_BASE=http://localhost:3000`r`n"
            $envContent += "OPENZIGS_INTERNAL_API=http://localhost:3000`r`n"
            $envContent += "NEXT_PUBLIC_OPENZIGS_TOKEN=$token`r`n"
            [System.IO.File]::WriteAllText($UiEnvFile, $envContent, [System.Text.Encoding]::UTF8)
            Write-Info "Wrote auth token to ui/.env.local"
        }
    } catch {
        Write-Warn "Could not read config file: $_"
    }
}

# ---- Resolve pnpm.cmd ------------------------------------------------------
$pnpmCmd = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if ($pnpmCmd) {
    $pnpmPath = $pnpmCmd.Source
} else {
    $pnpmPath = Join-Path $env:APPDATA "npm\pnpm.cmd"
}
if (-not (Test-Path $pnpmPath)) {
    Write-Warn "pnpm.cmd not found at $pnpmPath - cannot start servers"
    exit 1
}
Write-Info "Using pnpm: $pnpmPath"

# ---- Start Firecrawl Docker stack -------------------------------------------
if ((Test-Path $FirecrawlCompose) -and (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Info "Starting Firecrawl Docker stack..."
    try { & docker compose -f $FirecrawlCompose up -d 2>&1 | Out-Null } catch { }
}

# ---- Start WSL CUDA sidecars -----------------------------------------------
if (Get-Command wsl -ErrorAction SilentlyContinue) {
    Write-Info "Starting WSL CUDA sidecars (Flux/5005, Audio/5006, LTX/5007, Music/5009)..."

    # Fire-and-forget: sidecars load models lazily on first request, logs at ~/.openzigs/logs/*-cuda.log
    $wslScriptPath = ($ProjectRoot -replace '\\','/') -replace '^([A-Za-z]):','/mnt/$1'
    $wslScriptPath = $wslScriptPath.Substring(0,5) + $wslScriptPath[5].ToString().ToLower() + $wslScriptPath.Substring(6)
    Start-Process -FilePath "wsl" -ArgumentList @("-d", "Ubuntu", "bash", "$wslScriptPath/sidecars/start-cuda-sidecars.sh") -WindowStyle Hidden
    Write-Ok "WSL CUDA sidecars launched (Flux/5005, Audio/5006, LTX/5007, Music/5009) - check ~/.openzigs/logs/*-cuda.log"
} else {
    Write-Warn "WSL not found - skipping CUDA sidecar startup (start manually in WSL via start-cuda-sidecars.sh)"
}

# ---- Helper: write temp batch file and launch hidden cmd --------------------
function Start-BackgroundBat {
    param([string]$Name, [string]$WorkDir, [string]$CmdLine, [string]$LogFile)
    $batPath = Join-Path $env:TEMP "openzigs-$Name.bat"
    $b = '@echo off'
    $b += "`r`ncd /d `"$WorkDir`""
    $b += "`r`n$CmdLine > `"$LogFile`" 2>&1"
    [System.IO.File]::WriteAllText($batPath, $b, [System.Text.Encoding]::ASCII)
    return Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$batPath`"" -PassThru -WindowStyle Hidden
}

# ---- Start backend ----------------------------------------------------------
Write-Info "Starting backend..."
$backendLogFile = Join-Path $ProjectRoot ".openzigs-dev.log"
$backendProc = Start-BackgroundBat -Name "backend" -WorkDir $ProjectRoot `
    -CmdLine "`"$pnpmPath`" dev" -LogFile $backendLogFile

Write-Info "Backend logs: $backendLogFile"
Write-Info "Waiting for backend on port 3000 (MCP servers may take ~90s)..."
$maxWait = 120
for ($i = 0; $i -lt $maxWait; $i++) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
        Write-Ok "Backend ready on port 3000"
        break
    }
}
if ($i -eq $maxWait) {
    Write-Warn "Backend did not start within ${maxWait}s - check $backendLogFile"
}

# ---- Start UI ---------------------------------------------------------------
Write-Info "Starting UI..."
$uiLogFile = Join-Path $ProjectRoot ".openzigs-ui.log"
$uiWorkDir = Join-Path $ProjectRoot "ui"
$uiProc = Start-BackgroundBat -Name "ui" -WorkDir $uiWorkDir `
    -CmdLine "set PORT=3001 && `"$pnpmPath`" dev" -LogFile $uiLogFile

Write-Info "UI logs: $uiLogFile"
Write-Info "Waiting for UI on port 3001..."
$maxUiWait = 90
for ($i = 0; $i -lt $maxUiWait; $i++) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) {
        Write-Ok "UI ready on port 3001"
        break
    }
}
if ($i -eq $maxUiWait) {
    Write-Warn "UI did not start within ${maxUiWait}s - check $uiLogFile"
}

# ---- Summary ----------------------------------------------------------------
Write-Host ""
Write-Ok "OpenZigs dev servers started!"
Write-Host ""
Write-Host "  Backend:          http://localhost:3000"
Write-Host "  UI:               http://localhost:3001"
Write-Host "  Sidecars (WSL):   5005 (Flux), 5006 (Audio), 5007 (LTX), 5009 (Music) - loading in background"
Write-Host ""
Write-Host "  Logs:"
Write-Host "    Backend: $backendLogFile"
Write-Host "    UI:      $uiLogFile"
Write-Host "    Sidecars (WSL): ~/.openzigs/logs/{image-gen,audio,worker,music}-cuda.log"
Write-Host ""
Write-Host "  To stop: Close this window or press Ctrl+C"
Write-Host ""

# ---- Tail logs (Ctrl+C to stop) --------------------------------------------
Write-Info "Tailing logs (Ctrl+C to stop)..."

try {
    $lastBE = 0
    $lastUI = 0

    while ($true) {
        if (Test-Path $backendLogFile) {
            $c = Get-Content $backendLogFile -Raw -ErrorAction SilentlyContinue
            if ($c -and $c.Length -gt $lastBE) {
                Write-Host $c.Substring($lastBE) -NoNewline
                $lastBE = $c.Length
            }
        }
        if (Test-Path $uiLogFile) {
            $c = Get-Content $uiLogFile -Raw -ErrorAction SilentlyContinue
            if ($c -and $c.Length -gt $lastUI) {
                Write-Host $c.Substring($lastUI) -NoNewline
                $lastUI = $c.Length
            }
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    Write-Info "Shutting down..."

    if ($backendProc -and -not $backendProc.HasExited) {
        Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($uiProc -and -not $uiProc.HasExited) {
        Stop-Process -Id $uiProc.Id -Force -ErrorAction SilentlyContinue
    }
    foreach ($Port in @(3000, 3001, 3101)) {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        foreach ($conn in $conns) {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
    if ((Test-Path $FirecrawlCompose) -and (Get-Command docker -ErrorAction SilentlyContinue)) {
        try { & docker compose -f $FirecrawlCompose down 2>&1 | Out-Null } catch { }
    }

    # Stop WSL CUDA sidecars in Ubuntu
    if (Get-Command wsl -ErrorAction SilentlyContinue) {
        Write-Info "Stopping WSL CUDA sidecars..."
        $wslKillCmd = 'for p in 5005 5006 5007 5009; do lsof -ti :$p 2>/dev/null | xargs -r kill -9 2>/dev/null; done; true'
        wsl -d Ubuntu -e bash -c $wslKillCmd 2>&1 | Out-Null
    }

    Write-Ok "Shutdown complete."
}