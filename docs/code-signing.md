# Code Signing Guide

This document covers code signing configuration for OpenZigs desktop builds.

> **Status**: Code signing is **deferred** — builds are currently unsigned. The signing stubs are in place; enable them by configuring the relevant secrets and uncommenting workflow steps.

## Overview

| Platform | Mechanism | Cost | SmartScreen / Gatekeeper |
|----------|-----------|------|--------------------------|
| Windows | Authenticode (EV certificate) | ~$10–500/yr | Trusted from day 1 with EV |
| macOS | Developer ID + Notarization | $99/yr | Trusted after notarization |

## Windows Signing Options

### Option A: Azure Trusted Signing (Recommended)

- **Cost**: ~$10/month (Azure pay-as-you-go)
- **SmartScreen**: Immediate trust (Microsoft-backed)
- **Setup**:
  1. Create an Azure account and subscription
  2. Register for Azure Trusted Signing (formerly Azure Code Signing)
  3. Complete identity validation (organization or individual)
  4. Create a signing profile and certificate
  5. Configure GitHub Actions secrets:
     - `AZURE_TENANT_ID`
     - `AZURE_CLIENT_ID`
     - `AZURE_CLIENT_SECRET`
     - `AZURE_CODE_SIGNING_ACCOUNT`
     - `AZURE_CERTIFICATE_PROFILE`
  6. Use `@aspect-build/rules_sign` or Azure CLI in the workflow

**Pros**: Cheapest, no hardware token, cloud-native, immediate SmartScreen trust.
**Cons**: Requires Azure account, Microsoft identity verification process.

### Option B: SSL.com EV Certificate + Cloud Signing

- **Cost**: ~$240/year (eSigner EV)
- **SmartScreen**: Immediate trust (EV certificate)
- **Setup**:
  1. Purchase EV code signing certificate from SSL.com
  2. Enable eSigner (cloud signing service)
  3. Configure GitHub Actions secrets:
     - `SSL_COM_CREDENTIAL_ID`
     - `SSL_COM_TOTP_SECRET`
     - `SSL_COM_USERNAME`
     - `SSL_COM_PASSWORD`
  4. Use CodeSignTool in the workflow

### Option C: DigiCert / Sectigo EV + Hardware Token

- **Cost**: ~$350–500/year
- **SmartScreen**: Immediate trust
- **Notes**: Requires physical USB hardware token — not CI-friendly without HSM bridging. Not recommended for automated builds.

## macOS Signing

### Apple Developer ID ($99/year)

1. **Enroll** in the Apple Developer Program ($99/year)
2. **Create** a "Developer ID Application" certificate in Xcode or developer.apple.com
3. **Export** the certificate + private key as a `.p12` file
4. **Base64-encode** it: `base64 -i cert.p12 | pbcopy`
5. **Configure** GitHub Actions secrets:
   - `MAC_CSC_LINK`: Base64-encoded `.p12` file
   - `MAC_CSC_KEY_PASSWORD`: The `.p12` export password
   - `APPLE_ID`: Your Apple ID email
   - `APPLE_APP_PASSWORD`: App-specific password (appleid.apple.com → Security)
   - `APPLE_TEAM_ID`: Your 10-character team ID

### Notarization

The `desktop/scripts/notarize.cjs` script automatically submits signed builds to Apple's notarization service via the `afterSign` hook. It's a no-op when the `APPLE_ID` environment variables are not set.

## Enabling Signing in CI

1. Add the required secrets to GitHub repository settings → Secrets and Variables → Actions
2. Uncomment the signing steps in `.github/workflows/desktop-release.yml`
3. Remove `CSC_IDENTITY_AUTO_DISCOVERY: "false"` from the package step
4. Push a version tag (`git tag v0.2.0 && git push --tags`) to trigger a signed build

## Unsigned Builds (Current State)

- **Windows**: NSIS installer works but shows SmartScreen warning on first run. Users must click "More info" → "Run anyway".
- **macOS**: DMG works but Gatekeeper blocks it. Users must right-click → Open → confirm, or run `xattr -cr /Applications/OpenZigs.app`.
- **Scoop/Homebrew**: Both package managers install unsigned apps without issue.
