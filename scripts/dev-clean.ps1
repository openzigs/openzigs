<#
.SYNOPSIS
    OpenZigs development startup script for Windows.

.DESCRIPTION
    Kills existing OpenZigs processes and starts the backend + UI development servers,
    and launches the WSL CUDA sidecars (Flux/5005, Audio/5006, LTX/5007, Music/5009,
    Lipsync/5010, SadTalker/5011, v2a/MMAudio/5012). This is the Windows equivalent
    of dev-clean.sh.

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

# Kill only OpenZigs-related node processes (not VS Code MCP servers, etc.)
# Strategy: kill node.exe whose command line contains "openzigs" or "next-server"
$nodeProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
$killed = 0
foreach ($proc in $nodeProcs) {
    $cmdLine = $proc.CommandLine
    if ($cmdLine -and ($cmdLine -match 'openzigs|next-server.*3001|tsx.*watch')) {
        Write-Info "Killing node PID $($proc.ProcessId): $($cmdLine.Substring(0, [Math]::Min(120, $cmdLine.Length)))..."
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        $killed++
    }
}
if ($killed -gt 0) { Write-Info "Killed $killed OpenZigs-related node process(es)" }
else { Write-Info "No OpenZigs node processes found" }

# Kill only OpenZigs-spawned Python processes (command line contains openzigs paths)
$pyProcs = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='python3.exe'" -ErrorAction SilentlyContinue
$killed = 0
foreach ($proc in $pyProcs) {
    $cmdLine = $proc.CommandLine
    if ($cmdLine -and ($cmdLine -match 'openzigs')) {
        Write-Info "Killing python PID $($proc.ProcessId): $($cmdLine.Substring(0, [Math]::Min(120, $cmdLine.Length)))..."
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        $killed++
    }
}
if ($killed -gt 0) { Write-Info "Killed $killed OpenZigs-related python process(es)" }

# Kill orphaned cmd.exe processes that ran OpenZigs batch files
$openzigsBats = Get-ChildItem "$env:TEMP\openzigs-*.bat" -ErrorAction SilentlyContinue
if ($openzigsBats) {
    Write-Info "Found $($openzigsBats.Count) OpenZigs batch files -- killing their cmd processes"
    $cmdProcs = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue
    foreach ($proc in $cmdProcs) {
        $cmdLine = $proc.CommandLine
        if ($cmdLine -and ($cmdLine -match 'openzigs')) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

# Also kill WSL sidecar ports and orphaned sleep-infinity anchors in Ubuntu
if (Get-Command wsl -ErrorAction SilentlyContinue) {
    $wslKillCmd = 'for p in 5005 5006 5007 5009 5010 5011 5012; do lsof -ti :$p 2>/dev/null | xargs -r kill -9 2>/dev/null; done; pkill -f "sleep infinity" 2>/dev/null; true'
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
    Write-Info "Starting WSL CUDA sidecars (Flux/5005, Audio/5006, LTX/5007, Music/5009, Lipsync/5010, SadTalker/5011, v2a/5012)..."

    # Fire-and-forget: sidecars load models lazily on first request, logs at ~/.openzigs/logs/*-cuda.log
    $wslScriptPath = ($ProjectRoot -replace '\\','/') -replace '^([A-Za-z]):','/mnt/$1'
    $wslScriptPath = $wslScriptPath.Substring(0,5) + $wslScriptPath[5].ToString().ToLower() + $wslScriptPath.Substring(6)
    # Strip Windows CRLF line endings via tr (more reliable than sed in PowerShell escaping).
    # Then run the cleaned script, append output to log, and keep the session alive with
    # 'sleep infinity' so WSL2 does not terminate the setsid-detached sidecar processes
    # when the original bash -c command finishes.
    # IMPORTANT: use ';' not '&&' before sleep — the script must keep WSL alive even if
    # some sidecars fail to start.
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE ".openzigs\logs") -ErrorAction SilentlyContinue
    $startArgs = "-d Ubuntu -- bash -c `"tr -d '\r' < '$wslScriptPath/sidecars/start-cuda-sidecars.sh' > /tmp/openzigs-start-sidecars.sh && chmod +x /tmp/openzigs-start-sidecars.sh && bash /tmp/openzigs-start-sidecars.sh >> `$HOME/.openzigs/logs/sidecar-start.log 2>&1; exec sleep infinity`""
    Start-Process -FilePath "wsl" -ArgumentList $startArgs -WindowStyle Hidden
    Write-Ok "WSL CUDA sidecars launched (Flux/5005, Audio/5006, LTX/5007, Music/5009, Lipsync/5010, SadTalker/5011, v2a/5012)"
    Write-Info "Sidecar startup log: wsl -d Ubuntu bash -c 'cat ~/.openzigs/logs/sidecar-start.log'"
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
    -CmdLine "set PORT=3001 && `"$pnpmPath`" dev --turbopack" -LogFile $uiLogFile

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
Write-Host "  Sidecars (WSL):   5005 (Flux), 5006 (Audio), 5007 (LTX), 5009 (Music), 5010 (Lipsync), 5011 (SadTalker), 5012 (v2a/MMAudio) - loading in background"
Write-Host ""
Write-Host "  Logs:"
Write-Host "    Backend: $backendLogFile"
Write-Host "    UI:      $uiLogFile"
Write-Host "    Sidecars (WSL): ~/.openzigs/logs/{image-gen,audio,worker,music,lipsync,sadtalker,v2a}-cuda.log"
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
        $wslKillCmd = 'for p in 5005 5006 5007 5009 5010 5011 5012; do lsof -ti :$p 2>/dev/null | xargs -r kill -9 2>/dev/null; done; true'
        wsl -d Ubuntu -e bash -c $wslKillCmd 2>&1 | Out-Null
    }

    Write-Ok "Shutdown complete."
}