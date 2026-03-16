<#
.SYNOPSIS
    OpenZigs development startup script for Windows.

.DESCRIPTION
    Kills existing OpenZigs processes and starts the backend + UI development servers.
    This is the Windows equivalent of dev-clean.sh.

    NOTE: AI sidecars (image-gen, audio, music, video) are NOT available on Windows
    as they require Apple Silicon. Only the core Node.js backend and Next.js UI run.

.EXAMPLE
    .\scripts\dev-clean.ps1
#>

$ErrorActionPreference = "Stop"

# ── Colors ────────────────────────────────────────────────────────────────────
function Write-Info { Write-Host "[clean-start] $args" -ForegroundColor Cyan }
function Write-Ok { Write-Host "[clean-start] $args" -ForegroundColor Green }
function Write-Warn { Write-Host "[clean-start] $args" -ForegroundColor Yellow }

# ── Resolve paths ─────────────────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Info "Project root: $ProjectRoot"

# ── Kill existing processes ───────────────────────────────────────────────────
Write-Info "Killing existing OpenZigs processes..."

# Kill node/tsx processes related to OpenZigs
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -like "*$ProjectRoot*" -or $_.CommandLine -like "*$ProjectRoot*"
} | ForEach-Object {
    Write-Info "Killing node process (PID $($_.Id))"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

# Kill processes on known ports
$Ports = @(3000, 3001, 3101)
foreach ($Port in $Ports) {
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $connections) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Info "Killing process on port $Port (PID $($proc.Id), $($proc.ProcessName))"
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

# Give processes time to terminate
Start-Sleep -Seconds 1

# ── Configure UI environment ──────────────────────────────────────────────────
$ConfigFile = Join-Path $env:USERPROFILE ".openzigs\config.json"
$UiEnvFile = Join-Path $ProjectRoot "ui\.env.local"

if (Test-Path $ConfigFile) {
    try {
        $config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        $token = $config.auth.token
        if ($token) {
            @"
NEXT_PUBLIC_OPENZIGS_API_BASE=http://localhost:3000
NEXT_PUBLIC_OPENZIGS_TOKEN=$token
"@ | Set-Content $UiEnvFile -Encoding UTF8
            Write-Info "Wrote auth token to ui/.env.local"
        }
    } catch {
        Write-Warn "Could not read config file: $_"
    }
}

# ── Start backend ─────────────────────────────────────────────────────────────
Write-Info "Starting backend..."
$backendLogFile = Join-Path $ProjectRoot ".openzigs-dev.log"

Push-Location $ProjectRoot
$backendJob = Start-Job -ScriptBlock {
    param($root, $log)
    Set-Location $root
    pnpm dev 2>&1 | Tee-Object -FilePath $log
} -ArgumentList $ProjectRoot, $backendLogFile

Write-Info "Backend logs: $backendLogFile"

# Wait for backend to be ready
Write-Info "Waiting for backend on port 3000..."
$maxAttempts = 30
$attempt = 0
do {
    Start-Sleep -Seconds 1
    $attempt++
    $listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
} while (-not $listening -and $attempt -lt $maxAttempts)

if ($listening) {
    Write-Ok "Backend ready on port 3000"
} else {
    Write-Warn "Backend did not start within ${maxAttempts}s - check logs"
}

# ── Start UI ──────────────────────────────────────────────────────────────────
Write-Info "Starting UI..."
$uiLogFile = Join-Path $ProjectRoot ".openzigs-ui.log"

$uiJob = Start-Job -ScriptBlock {
    param($root, $log)
    Set-Location (Join-Path $root "ui")
    $env:PORT = "3001"
    pnpm dev 2>&1 | Tee-Object -FilePath $log
} -ArgumentList $ProjectRoot, $uiLogFile

Write-Info "UI logs: $uiLogFile"

# Wait for UI to be ready
Write-Info "Waiting for UI on port 3001..."
$attempt = 0
do {
    Start-Sleep -Seconds 1
    $attempt++
    $listening = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
} while (-not $listening -and $attempt -lt $maxAttempts)

if ($listening) {
    Write-Ok "UI ready on port 3001"
} else {
    Write-Warn "UI did not start within ${maxAttempts}s - check logs"
}

Pop-Location

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Ok "OpenZigs dev servers started!"
Write-Host ""
Write-Host "  Backend: http://localhost:3000"
Write-Host "  UI:      http://localhost:3001"
Write-Host ""
Write-Host "  Logs:"
Write-Host "    Backend: $backendLogFile"
Write-Host "    UI:      $uiLogFile"
Write-Host ""
Write-Host "  To stop: Close this window or press Ctrl+C"
Write-Host ""
Write-Host "  NOTE: AI sidecars (image-gen, audio, music, video) are not available"
Write-Host "        on Windows. These features require Apple Silicon."
Write-Host ""

# ── Tail logs ─────────────────────────────────────────────────────────────────
Write-Info "Tailing logs (Ctrl+C to stop)..."

try {
    # Create a simple log watcher
    $lastBackendPos = 0
    $lastUiPos = 0
    
    while ($true) {
        # Check backend log
        if (Test-Path $backendLogFile) {
            $content = Get-Content $backendLogFile -Raw -ErrorAction SilentlyContinue
            if ($content -and $content.Length -gt $lastBackendPos) {
                $newContent = $content.Substring($lastBackendPos)
                Write-Host $newContent -NoNewline
                $lastBackendPos = $content.Length
            }
        }
        
        # Check UI log
        if (Test-Path $uiLogFile) {
            $content = Get-Content $uiLogFile -Raw -ErrorAction SilentlyContinue
            if ($content -and $content.Length -gt $lastUiPos) {
                $newContent = $content.Substring($lastUiPos)
                Write-Host $newContent -NoNewline
                $lastUiPos = $content.Length
            }
        }
        
        Start-Sleep -Milliseconds 500
    }
} finally {
    # Cleanup on exit
    Write-Info "Shutting down..."
    
    if ($backendJob) {
        Stop-Job -Job $backendJob -ErrorAction SilentlyContinue
        Remove-Job -Job $backendJob -Force -ErrorAction SilentlyContinue
    }
    if ($uiJob) {
        Stop-Job -Job $uiJob -ErrorAction SilentlyContinue
        Remove-Job -Job $uiJob -Force -ErrorAction SilentlyContinue
    }
    
    # Kill any remaining processes on the ports
    foreach ($Port in @(3000, 3001, 3101)) {
        $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        foreach ($conn in $connections) {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
    
    Write-Ok "Shutdown complete."
}
