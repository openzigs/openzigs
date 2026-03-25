// Notarization stub — activated when APPLE_ID + APPLE_APP_PASSWORD are set.
// See docs/code-signing.md for setup instructions.
//
// When code signing is configured:
// 1. Set APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID env vars
// 2. This script runs automatically via electron-builder afterSign hook
// 3. It submits the signed .app to Apple's notarization service

const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log("⏭  Skipping notarization — APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID not set");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  console.log(`🔏 Notarizing ${appName}...`);

  await notarize({
    appBundleId: "com.openzigs.desktop",
    appPath: `${appOutDir}/${appName}.app`,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log("✅ Notarization complete");
};
