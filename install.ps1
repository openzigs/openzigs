#Requires -Version 5.1
<#
.SYNOPSIS
    OpenZigs installation script for Windows

.DESCRIPTION
    Installs OpenZigs on Windows using native Node.js.
    Note: AI sidecars (Audio, Image Gen, Music, Video) require Apple Silicon and are not available on Windows.

.EXAMPLE
    .\install.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

# ── ANSI Colors (Windows Terminal / PowerShell 7+) ────────────────────────────
$script:SupportsAnsi = $Host.UI.SupportsVirtualTerminal -or $PSVersionTable.PSVersion.Major -ge 7

function Write-Color {
    param(
        [string]$Message,
        [string]$Color = "White"
    )
    
    $colorMap = @{
        "Red"     = "`e[31m"
        "Yellow"  = "`e[33m"
        "Green"   = "`e[32m"
        "Cyan"    = "`e[36m"
        "White"   = "`e[0m"
        "Bold"    = "`e[1m"
        "Reset"   = "`e[0m"
    }
    
    if ($script:SupportsAnsi) {
        Write-Host "$($colorMap[$Color])$Message$($colorMap['Reset'])"
    } else {
        Write-Host $Message -ForegroundColor $Color
    }
}

# ── Banner ────────────────────────────────────────────────────────────────────
function Show-Banner {
    Write-Host ""
    Write-Color "   ___                ______              " "Cyan"
    Write-Color "  / _ \ _ __  ___ _ _|__  (_) __ _ ___   " "Cyan"
    Write-Color " | | | | '_ \/ _ \ '_ \/ /| |/ _`` / __| " "Cyan"
    Write-Color " | |_| | |_) |  __/ | | / /_| | (_| \__ \" "Cyan"
    Write-Color "  \___/| .__/ \___|_| /_\__|_|\__, |___/ " "Cyan"
    Write-Color "       |_|                    |___/       " "Cyan"
    Write-Host ""
    Write-Host "  Local-first AI agent platform"
    Write-Host "  Windows Installation"
    Write-Host ""
}

# ── Prerequisites Check ───────────────────────────────────────────────────────
function Test-Prerequisites {
    $failed = $false

    Write-Host ""
    Write-Color "=== Checking Prerequisites ===" "Bold"
    Write-Host ""

    # Check Git
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
        Write-Color "  [X] Git is required. Install from https://git-scm.com" "Red"
        $failed = $true
    } else {
        $gitVersion = git --version
        Write-Color "  [OK] $gitVersion" "Green"
    }

    # Check Node.js
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Color "  [X] Node.js 22+ is required. Install from https://nodejs.org" "Red"
        $failed = $true
    } else {
        $nodeVersion = node --version
        Write-Color "  [OK] Node.js: $nodeVersion" "Green"
    }

    # Check pnpm
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        Write-Color "  [!] pnpm not found - will install automatically" "Yellow"
    } else {
        $pnpmVersion = pnpm --version
        Write-Color "  [OK] pnpm: $pnpmVersion" "Green"
    }

    Write-Host ""

    if ($failed) {
        Write-Color "Please install the missing prerequisites and try again." "Red"
        exit 1
    }
}

# ── Install to User Directory ─────────────────────────────────────────────────
function Install-OpenZigs {
    $installDir = Join-Path $env:USERPROFILE ".openzigs"

    # Handle existing installation
    if (Test-Path $installDir) {
        Write-Host ""
        Write-Color "OpenZigs is already installed at $installDir" "Yellow"
        Write-Host ""
        Write-Host "  What would you like to do?"
        Write-Host "  1) Update existing installation"
        Write-Host "  2) Reinstall (removes existing data)"
        Write-Host "  3) Exit"
        Write-Host ""
        
        $choice = Read-Host "  Choice [1/2/3]"
        
        switch ($choice) {
            "1" {
                Write-Host ""
                Write-Host "  Updating existing installation..."
                Set-Location $installDir
                git pull --ff-only
            }
            "2" {
                Write-Host ""
                Write-Color "  Removing existing installation..." "Yellow"
                Set-Location $env:USERPROFILE
                Remove-Item -Recurse -Force $installDir
            }
            default {
                Write-Host "  Exiting."
                exit 0
            }
        }
    }

    # Clone repository
    if (-not (Test-Path $installDir)) {
        Write-Host ""
        Write-Host "  Cloning OpenZigs to $installDir..."
        git clone https://github.com/openzigs/openzigs.git $installDir
    }

    Set-Location $installDir
}

# ── Environment Configuration ─────────────────────────────────────────────────
function Set-Environment {
    $envFile = ".env"
    
    if (-not (Test-Path $envFile)) {
        Write-Host ""
        Write-Color "=== Environment Configuration ===" "Bold"
        Write-Host ""
        Write-Host "  Creating .env file with defaults..."
        
        $envContent = @"
# ── Required ──
# GITHUB_CLIENT_ID=your-github-oauth-client-id

# ── Optional: Brave Search ──
# BRAVE_API_KEY=your-brave-api-key

# ── Optional: Messaging Channels ──
# TELEGRAM_BOT_TOKEN=your-telegram-bot-token
# DISCORD_BOT_TOKEN=your-discord-bot-token

# ── Optional: Chrome DevTools ──
CHROME_DEBUG_HOST=localhost
CHROME_DEBUG_PORT=9222

# ── Server ──
PORT=3000
"@
        Set-Content -Path $envFile -Value $envContent
        Write-Color "  [OK] Created .env file" "Green"
        Write-Host "       Edit .env to add your API keys"
    } else {
        Write-Color "  [OK] .env file already exists" "Green"
    }
}

# ── Create Data Directories ───────────────────────────────────────────────────
function New-DataDirectories {
    Write-Host ""
    Write-Host "  Creating data directories..."
    
    $dirs = @(
        (Join-Path $env:USERPROFILE ".openzigs\sessions"),
        (Join-Path $env:USERPROFILE ".openzigs\logs"),
        (Join-Path $env:USERPROFILE ".openzigs\sentinel"),
        (Join-Path $env:USERPROFILE ".openzigs\knowledge"),
        (Join-Path $env:USERPROFILE ".openzigs\voice-references")
    )
    
    foreach ($dir in $dirs) {
        if (-not (Test-Path $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }
    
    Write-Color "  [OK] Data directories created" "Green"
}

# ── Start Services ────────────────────────────────────────────────────────────
function Start-Services {
    Write-Host ""
    Write-Color "=== Installing Dependencies ===" "Bold"
    Write-Host ""

    # Install pnpm if not present
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        Write-Host "  Installing pnpm..."
        npm install -g pnpm
    }
    
    Write-Host "  Installing backend dependencies..."
    pnpm install
    
    if ($LASTEXITCODE -ne 0) {
        Write-Color "  [X] Failed to install dependencies" "Red"
        exit 1
    }
    
    Write-Host "  Installing UI dependencies..."
    Push-Location ui
    pnpm install
    Pop-Location
    
    if ($LASTEXITCODE -eq 0) {
        Write-Color "  [OK] Dependencies installed successfully" "Green"
    } else {
        Write-Color "  [X] Failed to install UI dependencies" "Red"
        exit 1
    }
}

# ── Print Summary ─────────────────────────────────────────────────────────────
function Show-Summary {
    $installDir = Join-Path $env:USERPROFILE ".openzigs"
    
    Write-Host ""
    Write-Color "================================================================" "Green"
    Write-Color "          OpenZigs installed successfully!                      " "Green"
    Write-Color "================================================================" "Green"
    Write-Host ""
    Write-Host "  Installation directory: $installDir"
    Write-Host ""
    Write-Color "  To start OpenZigs:" "Bold"
    Write-Host "    cd $installDir"
    Write-Host ""
    Write-Host "    # Terminal 1: Start the backend"
    Write-Host "    pnpm dev"
    Write-Host ""
    Write-Host "    # Terminal 2: Start the UI"
    Write-Host "    cd ui && pnpm dev"
    Write-Host ""
    Write-Host "  Access the UI at: http://localhost:3001"
    Write-Host "  Admin panel at:   http://localhost:3001/admin"
    Write-Host ""
    Write-Color "  Useful commands:" "Bold"
    Write-Host "    pnpm build          # Build for production"
    Write-Host "    pnpm start          # Run production build"
    Write-Host "    notepad .env        # Update API credentials"
    Write-Host ""
    Write-Color "  Note: AI sidecars (Audio, Image Gen, Music, Video) require" "Yellow"
    Write-Color "        Apple Silicon and are not available on Windows." "Yellow"
    Write-Host ""
}

# ── Optional: Install Prerequisites with winget ───────────────────────────────
function Install-Prerequisites {
    Write-Host ""
    Write-Color "=== Optional: Install Missing Prerequisites ===" "Bold"
    Write-Host ""
    
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        Write-Color "  winget not available. Please install prerequisites manually:" "Yellow"
        Write-Host "    Node.js: https://nodejs.org"
        Write-Host "    Git: https://git-scm.com"
        return
    }

    Write-Host "  Do you want to install missing prerequisites with winget? [y/N]"
    $response = Read-Host
    
    if ($response -eq "y" -or $response -eq "Y") {
        $git = Get-Command git -ErrorAction SilentlyContinue
        if (-not $git) {
            Write-Host "  Installing Git..."
            winget install --id Git.Git -e --source winget
        }

        $node = Get-Command node -ErrorAction SilentlyContinue
        if (-not $node) {
            Write-Host "  Installing Node.js..."
            winget install --id OpenJS.NodeJS.LTS -e --source winget
        }

        Write-Host ""
        Write-Color "  Prerequisites installed. Please restart your terminal and run this script again." "Yellow"
        exit 0
    }
}

# ── Dev Clean (Windows equivalent) ────────────────────────────────────────────
function Stop-DevProcesses {
    Write-Host ""
    Write-Host "  Stopping any existing OpenZigs processes..."
    
    # Kill processes on common ports
    $ports = @(3000, 3001, 3101, 5005, 5006, 5009, 5010)
    foreach ($port in $ports) {
        $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | 
                       Where-Object { $_.State -eq "Listen" }
        foreach ($conn in $connections) {
            $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
            if ($proc -and $proc.Name -ne "System") {
                Write-Host "    Stopping process on port $port (PID: $($conn.OwningProcess))"
                Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# ════════════════════════════════════════════════════════════════════════════════
# MAIN
# ════════════════════════════════════════════════════════════════════════════════

Show-Banner
Test-Prerequisites
Install-OpenZigs
Set-Environment
New-DataDirectories
Stop-DevProcesses
Start-Services
Show-Summary
