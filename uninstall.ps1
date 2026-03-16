#Requires -Version 5.1
<#
.SYNOPSIS
    OpenZigs uninstallation script for Windows

.DESCRIPTION
    Removes OpenZigs installation from Windows.

.EXAMPLE
    .\uninstall.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$installDir = Join-Path $env:USERPROFILE ".openzigs"

if (-not (Test-Path $installDir)) {
    Write-Host "OpenZigs is not installed in $installDir"
    exit 0
}

Write-Host ""
Write-Host "This will remove OpenZigs and all its data from:"
Write-Host "  $installDir"
Write-Host ""
Write-Host "Are you sure? [y/N]"
$response = Read-Host

if ($response -ne "y" -and $response -ne "Y") {
    Write-Host "Cancelled."
    exit 0
}

Set-Location $installDir

Write-Host ""
Write-Host "Stopping any running OpenZigs processes..."
$ports = @(3000, 3001, 3101)
foreach ($port in $ports) {
    $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | 
                   Where-Object { $_.State -eq "Listen" }
    foreach ($conn in $connections) {
        $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.Name -ne "System") {
            Write-Host "  Stopping process on port $port (PID: $($conn.OwningProcess))"
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
}

Set-Location $env:USERPROFILE

Write-Host "Removing installation directory..."
Remove-Item -Recurse -Force $installDir

Write-Host ""
Write-Host "OpenZigs uninstalled."
