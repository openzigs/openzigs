<#
.SYNOPSIS
    PowerShell wrapper for the cross-platform GPU stress-test harness.

.DESCRIPTION
    Runs scripts/gpu-stress-test.py against the local sidecars. Reads the
    workerSecret from ~/.openzigs/config.json (falls back to OPENZIGS_API_TOKEN
    env var). Issue #887 (Epic #883).

.PARAMETER Scenario
    Test scenario: smoke (default), full, or oom.

.EXAMPLE
    pwsh ./scripts/gpu-stress-test.ps1 -Scenario smoke

.EXAMPLE
    pwsh ./scripts/gpu-stress-test.ps1 -Scenario full
#>
param(
    [ValidateSet("smoke", "full", "oom")]
    [string]$Scenario = "smoke",
    [string]$Token,
    [double]$PollInterval = 2.0
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repoRoot "scripts/gpu-stress-test.py"
if (-not (Test-Path $script)) {
    throw "Stress-test script not found at $script"
}

if (-not $Token) {
    $configPath = Join-Path $env:USERPROFILE ".openzigs/config.json"
    if (Test-Path $configPath) {
        try {
            $config = Get-Content $configPath -Raw | ConvertFrom-Json
            $Token = $config.auth.workerSecret
        } catch {
            Write-Warning "Failed to read worker secret from $configPath : $_"
        }
    }
    if (-not $Token) { $Token = $env:OPENZIGS_API_TOKEN }
}

$pythonExe = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonExe) {
    $pythonExe = Get-Command python3 -ErrorAction SilentlyContinue
}
if (-not $pythonExe) {
    throw "Could not find python or python3 on PATH"
}

$argList = @(
    $script,
    "--scenario", $Scenario,
    "--poll-interval", $PollInterval
)
if ($Token) {
    $argList += @("--token", $Token)
}

Write-Host "Running GPU stress test: scenario=$Scenario" -ForegroundColor Cyan
& $pythonExe.Source @argList
exit $LASTEXITCODE
