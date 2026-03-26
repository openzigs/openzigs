# OpenZigs winget Manifest

This directory contains the winget manifest template for Windows distribution via the Microsoft Store / Windows Package Manager.

## ⚠️ Requires Code Signing

**winget submission to `microsoft/winget-pkgs` requires a code-signed installer.**

The manifest template in this directory is provided for reference. Actual submission must wait until:
1. Code signing certificate is obtained (Azure Trusted Signing or EV certificate)
2. NSIS installer is signed during the build process
3. The signed installer passes winget validation

See [docs/code-signing.md](../../docs/code-signing.md) for signing options.

## Manual Submission Process

Once code signing is implemented:

```powershell
# Install wingetcreate
winget install Microsoft.WingetCreate

# Generate manifest from signed installer
wingetcreate new https://github.com/openzigs/openzigs/releases/download/v0.1.0/OpenZigs-Setup-0.1.0.exe

# This opens a PR to microsoft/winget-pkgs
# First submission requires manual review (1-2 weeks)
```

## Automated Updates

After the initial submission is merged, the `update-package-manifests.yml` workflow can automatically:
1. Generate an updated manifest on each release
2. Submit a PR to `microsoft/winget-pkgs` using `wingetcreate update`

## User Installation

Once published to winget:

```powershell
# Install
winget install openzigs

# Or with explicit ID
winget install openzigs.OpenZigs

# Update
winget upgrade openzigs

# Uninstall
winget uninstall openzigs
```

## Manifest Structure

- **PackageIdentifier**: `openzigs.OpenZigs` (publisher.name format)
- **InstallerType**: `nullsoft` (NSIS installer)
- **InstallerSha256**: Must match the signed installer exactly
- **Tags**: Searchable keywords for `winget search`
- **InstallerSwitches**: Silent install flags for NSIS
