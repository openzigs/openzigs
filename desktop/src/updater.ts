/**
 * Auto-updater stub.
 *
 * This module will integrate electron-updater in Phase 4 (#591).
 * For now it's a no-op placeholder so the main process can call
 * `setupUpdater()` without error.
 *
 * When signing is configured and GitHub Releases artifacts are published,
 * this will check for updates on launch and on a periodic interval,
 * then prompt the user to install.
 */
export function setupUpdater(): void {
  // TODO: Phase 4 (#591) — integrate electron-updater
  // - Check for updates on launch + configurable interval
  // - Notify user of available update (never silent/forced)
  // - Download and install with progress
  // - Rollback on failure
  // - Support stable/beta channels
}
