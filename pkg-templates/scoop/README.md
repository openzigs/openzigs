# OpenZigs Scoop Bucket

This directory contains the Scoop manifest template for Windows distribution.

## Bucket Setup

To create the actual Scoop bucket, copy `openzigs.json` to a new repository:

```bash
# Create the bucket repository
gh repo create openzigs/scoop-openzigs --public --description "Scoop bucket for OpenZigs"
git clone https://github.com/openzigs/scoop-openzigs.git
cp openzigs.json scoop-openzigs/bucket/openzigs.json
cd scoop-openzigs
git add . && git commit -m "Add openzigs manifest"
git push
```

## User Installation

Once the bucket is published:

```powershell
# Add the bucket
scoop bucket add openzigs https://github.com/openzigs/scoop-openzigs

# Install
scoop install openzigs

# Update
scoop update openzigs

# Uninstall
scoop uninstall openzigs
```

## Automated Updates

The `update-package-manifests.yml` GitHub Actions workflow automatically:
1. Downloads the new release artifacts
2. Computes SHA256 hashes
3. Updates the manifest version and hash
4. Commits and pushes to the bucket repository

## Manifest Structure

- `version`: Current release version (auto-updated)
- `url`: Direct download link to the NSIS installer
- `hash`: SHA256 hash of the installer (auto-updated)
- `installer.script`: Silent NSIS install command
- `uninstaller.script`: Silent uninstall command
- `checkver`: GitHub releases API for version checking
- `autoupdate`: URL template for automatic hash updates
