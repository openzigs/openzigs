# Installing OpenZigs

OpenZigs is available for Windows and macOS. Choose your platform and preferred installation method below.

---

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| **OS** | Windows 10 (x64) / macOS 13+ | Windows 11 / macOS 14+ |
| **CPU** | 4 cores | 8+ cores, Apple Silicon |
| **RAM** | 8 GB | 16 GB |
| **Disk** | 2 GB | 10 GB (for media caches) |
| **Node.js** | 20.x | 22.x (for development) |
| **Docker** | Optional | Recommended (for sidecars) |

---

## Windows

### Option 1: Direct Download (Recommended)

1. Download the latest installer from [GitHub Releases](https://github.com/openzigs/openzigs/releases/latest)
   - File: `OpenZigs-Setup-{version}.exe`

2. Run the installer
   - The installer is **unsigned**. Windows SmartScreen may show a warning.
   - Click **"More info"** → **"Run anyway"** to proceed.

3. Launch OpenZigs from the Start Menu or desktop shortcut

4. Complete the setup wizard at `http://localhost:3001/setup`

### Option 2: Scoop (Developer-Friendly)

```powershell
# Add the OpenZigs bucket
scoop bucket add openzigs https://github.com/openzigs/scoop-openzigs

# Install
scoop install openzigs

# Update to latest version
scoop update openzigs
```

### Option 3: winget (Coming Soon)

> ⚠️ winget distribution requires code-signed installers. Coming in a future release.

```powershell
# Once available:
winget install openzigs
```

### Windows Notes

- **Firewall**: Allow OpenZigs through Windows Firewall when prompted (required for localhost server)
- **Antivirus**: Some antivirus software may flag unsigned installers. Add an exception if needed.
- **Data Location**: `%USERPROFILE%\.openzigs\`

---

## macOS

### Option 1: Direct Download (Recommended)

1. Download the DMG for your Mac from [GitHub Releases](https://github.com/openzigs/openzigs/releases/latest)
   - **Apple Silicon** (M1/M2/M3): `OpenZigs-{version}-arm64.dmg`
   - **Intel**: `OpenZigs-{version}-x64.dmg`

2. Open the DMG and drag OpenZigs to Applications

3. **First launch** (unsigned app):
   - Right-click OpenZigs.app → **Open** → Click **Open** in the dialog
   - Or: System Settings → Privacy & Security → **Open Anyway**

4. Complete the setup wizard at `http://localhost:3001/setup`

### Option 2: Homebrew

```bash
# Tap and install
brew install openzigs/tap/openzigs

# Update to latest version
brew upgrade openzigs
```

### macOS Notes

- **Gatekeeper**: The app is currently unsigned. You must bypass Gatekeeper on first launch.
- **Terminal Access**: Grant Terminal access if you plan to use shell execution tools
- **Data Location**: `~/.openzigs/`
- **Xcode Command Line Tools**: Not required, but recommended for development

---

## Linux (Development Only)

Linux desktop builds are not currently provided. For development or server use:

```bash
# Clone and install
git clone --recurse-submodules https://github.com/openzigs/openzigs.git
cd openzigs
pnpm install
pnpm build

# Run
pnpm start      # Production server
pnpm dev        # Development server with hot reload
```

---

## Docker

For headless/server deployment:

```bash
# Clone the repo
git clone --recurse-submodules https://github.com/openzigs/openzigs.git
cd openzigs

# Start with Docker Compose
docker compose up -d

# Or development mode with hot reload
docker compose -f docker-compose.dev.yml up
```

---

## Post-Installation Setup

### 1. Complete the Setup Wizard

On first launch, navigate to `http://localhost:3001/setup` to:
- Check system prerequisites
- Configure GitHub Copilot authentication
- Set up optional channels (Telegram, Discord)
- Enable optional features (media sidecars, social MCPs)

### 2. Authenticate with GitHub Copilot

OpenZigs uses GitHub Copilot SDK. You'll need:
- A GitHub account with Copilot access (personal, business, or enterprise)
- Device code authentication (automatic during setup)

### 3. Optional: Configure Environment Variables

For advanced configuration, create `~/.openzigs/config.json`:

```json
{
  "port": 3000,
  "ui_port": 3001,
  "log_level": "info"
}
```

Or use a `.env` file in the project root for development.

---

## Updating

### Desktop App (Windows/macOS)

OpenZigs includes auto-update functionality:
1. Look for the update notification in the system tray
2. Click to download and install the update
3. Restart when prompted

Or update manually via your package manager.

### Package Managers

```powershell
# Scoop (Windows)
scoop update openzigs
```

```bash
# Homebrew (macOS)
brew upgrade openzigs
```

---

## Uninstalling

### Windows

- **Direct install**: Control Panel → Programs → Uninstall OpenZigs
- **Scoop**: `scoop uninstall openzigs`

### macOS

- **Direct install**: Drag OpenZigs.app to Trash
- **Homebrew**: `brew uninstall --cask openzigs`

### Data Cleanup

User data is stored separately from the application:

| Platform | Data Directory |
|----------|---------------|
| Windows | `%USERPROFILE%\.openzigs\` |
| macOS | `~/.openzigs/` |
| Linux | `~/.openzigs/` |

Delete this directory to remove all configuration, sessions, and cached data.

---

## Troubleshooting

### "Windows protected your PC" (SmartScreen)

The installer is not code-signed. Click **"More info"** → **"Run anyway"**.

### "OpenZigs can't be opened because it is from an unidentified developer" (macOS)

Right-click the app → **Open** → **Open** (in dialog), or go to System Settings → Privacy & Security → **Open Anyway**.

### App won't start / health check fails

1. Check if port 3000 is already in use: `lsof -i :3000` (macOS) or `netstat -ano | findstr :3000` (Windows)
2. Check logs: `~/.openzigs/logs/`
3. Try starting from terminal for error output: `/Applications/OpenZigs.app/Contents/MacOS/OpenZigs`

### Backend fails to start

Ensure Node.js 20+ is installed and in PATH. The desktop app bundles Node.js, but some features may require a system installation.

---

## Verifying Downloads

Each release includes a `checksums.txt` file with SHA256 hashes:

```bash
# macOS / Linux
shasum -a 256 OpenZigs-*.dmg
shasum -a 256 OpenZigs-Setup-*.exe

# Windows PowerShell
Get-FileHash .\OpenZigs-Setup-*.exe -Algorithm SHA256
```

Compare with the checksums in the release notes.

---

## Getting Help

- **Documentation**: [USER_GUIDE.md](USER_GUIDE.md)
- **Issues**: [GitHub Issues](https://github.com/openzigs/openzigs/issues)
- **Discussions**: [GitHub Discussions](https://github.com/openzigs/openzigs/discussions)
