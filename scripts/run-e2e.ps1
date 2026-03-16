<#
.SYNOPSIS
    Run Playwright E2E tests on Windows.

.DESCRIPTION
    Starts the backend and UI dev servers (if not already running) and runs
    the Playwright E2E test suite. This is the Windows equivalent of run-e2e.sh.

.PARAMETER TestFile
    Optional specific test file to run.

.PARAMETER Headed
    Run tests in headed mode (visible browser).

.PARAMETER UI
    Open Playwright UI mode.

.EXAMPLE
    .\scripts\run-e2e.ps1
    .\scripts\run-e2e.ps1 -Headed
    .\scripts\run-e2e.ps1 -TestFile "e2e/dashboard.spec.ts"
    .\scripts\run-e2e.ps1 -UI
#>

[CmdletBinding()]
param(
    [string]$TestFile,
    [switch]$Headed,
    [switch]$UI
)

$ErrorActionPreference = "Stop"

# ── Colors ────────────────────────────────────────────────────────────────────
function Write-Info { Write-Host "[e2e] $args" -ForegroundColor Cyan }
function Write-Ok { Write-Host "[e2e] $args" -ForegroundColor Green }
function Write-Warn { Write-Host "[e2e] $args" -ForegroundColor Yellow }
function Write-Err { Write-Host "[e2e] ERROR: $args" -ForegroundColor Red }

# ── Resolve paths ─────────────────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$UiDir = Join-Path $ProjectRoot "ui"

$BackendPort = 3000
$UiPort = 3101

$BackendPid = $null
$UiPid = $null

# ── Helpers ───────────────────────────────────────────────────────────────────
function Test-PortInUse {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $conn
}

function Wait-ForPort {
    param(
        [int]$Port,
        [string]$Name,
        [int]$TimeoutSeconds = 60
    )
    
    $elapsed = 0
    Write-Host -NoNewline "  Waiting for $Name on :$Port"
    
    while (-not (Test-PortInUse $Port) -and $elapsed -lt $TimeoutSeconds) {
        Start-Sleep -Seconds 1
        $elapsed++
        Write-Host -NoNewline "."
    }
    
    if (Test-PortInUse $Port) {
        Write-Host " ready"
        return $true
    } else {
        Write-Host " timed out after ${TimeoutSeconds}s"
        return $false
    }
}

# ── Cleanup handler ───────────────────────────────────────────────────────────
$CleanupBlock = {
    Write-Host ""
    Write-Info "Shutting down servers..."
    
    if ($BackendPid) {
        Stop-Process -Id $BackendPid -Force -ErrorAction SilentlyContinue
    }
    if ($UiPid) {
        Stop-Process -Id $UiPid -Force -ErrorAction SilentlyContinue
    }
}

trap { & $CleanupBlock }

# ── Pre-flight checks ─────────────────────────────────────────────────────────
Push-Location $ProjectRoot

# Start backend if not running
if (Test-PortInUse $BackendPort) {
    Write-Info "Backend already running on :$BackendPort - skipping start"
} else {
    Write-Info "Starting backend..."
    $env:CHROME_AUTO_LAUNCH = "false"
    $backendProc = Start-Process -FilePath "pnpm" -ArgumentList "dev" `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput "$env:TEMP\openzigs-backend.log" `
        -RedirectStandardError "$env:TEMP\openzigs-backend-err.log" `
        -PassThru -WindowStyle Hidden
    $BackendPid = $backendProc.Id
    
    if (-not (Wait-ForPort -Port $BackendPort -Name "backend")) {
        Write-Err "Backend failed to start on :$BackendPort"
        Get-Content "$env:TEMP\openzigs-backend.log" -Tail 20
        exit 1
    }
}

# Start UI if not running
if (Test-PortInUse $UiPort) {
    Write-Info "UI dev server already running on :$UiPort - skipping start"
} else {
    Write-Info "Starting UI dev server..."
    $uiProc = Start-Process -FilePath "pnpm" -ArgumentList "dev" `
        -WorkingDirectory $UiDir `
        -RedirectStandardOutput "$env:TEMP\openzigs-ui.log" `
        -RedirectStandardError "$env:TEMP\openzigs-ui-err.log" `
        -PassThru -WindowStyle Hidden
    $UiPid = $uiProc.Id
    
    if (-not (Wait-ForPort -Port $UiPort -Name "UI dev server" -TimeoutSeconds 120)) {
        Write-Err "UI failed to start on :$UiPort"
        Get-Content "$env:TEMP\openzigs-ui.log" -Tail 20
        exit 1
    }
}

# ── Install Playwright browser if missing ─────────────────────────────────────
Push-Location $UiDir

$playwrightCheck = & npx playwright install --dry-run chromium 2>&1
if ($playwrightCheck -notmatch "chromium.*is already installed") {
    Write-Info "Installing Playwright Chromium browser..."
    & npx playwright install chromium
}

# ── Build Playwright arguments ────────────────────────────────────────────────
$playwrightArgs = @("playwright", "test")

if ($UI) {
    $playwrightArgs += "--ui"
} elseif ($Headed) {
    $playwrightArgs += "--headed"
}

if ($TestFile) {
    $playwrightArgs += $TestFile
}

# ── Run the tests ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Info "Running Playwright tests..."
Write-Host ""

& npx @playwrightArgs
$testExitCode = $LASTEXITCODE

Pop-Location
Pop-Location

# ── Cleanup ───────────────────────────────────────────────────────────────────
& $CleanupBlock

exit $testExitCode
