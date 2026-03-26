# OpenZigs Homebrew Tap

This directory contains the Homebrew cask formula template for macOS distribution.

## Tap Setup

To create the actual Homebrew tap, copy the formula to a new repository:

```bash
# Create the tap repository
gh repo create openzigs/homebrew-tap --public --description "Homebrew tap for OpenZigs"
git clone https://github.com/openzigs/homebrew-tap.git
mkdir -p homebrew-tap/Casks
cp openzigs.rb homebrew-tap/Casks/openzigs.rb
cd homebrew-tap
git add . && git commit -m "Add openzigs cask"
git push
```

## User Installation

Once the tap is published:

```bash
# Tap and install (combined)
brew install openzigs/tap/openzigs

# Or separately
brew tap openzigs/tap
brew install openzigs

# Update
brew upgrade openzigs

# Uninstall
brew uninstall openzigs
```

## Automated Updates

The `update-package-manifests.yml` GitHub Actions workflow automatically:
1. Downloads the new release artifacts (arm64 and x64 DMGs)
2. Computes SHA256 hashes for both architectures
3. Updates the formula version and hashes
4. Commits and pushes to the tap repository

## Formula Structure

- **cask**: Desktop app formula type (vs `formula` for CLI tools)
- **arch**: Multi-architecture support (Apple Silicon + Intel)
- **sha256**: Separate hashes for arm64 and x64 builds
- **livecheck**: Enables `brew livecheck` for version tracking
- **auto_updates**: App has built-in auto-update (electron-updater)
- **depends_on**: Minimum macOS version requirement
- **postflight**: Removes quarantine for unsigned builds
- **zap**: Cleanup paths for complete uninstall

## Development

Test locally before publishing:

```bash
# Lint the formula
brew audit --cask openzigs.rb

# Install from local file
brew install --cask openzigs.rb
```
