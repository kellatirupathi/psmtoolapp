export {};

declare global {
  interface DesktopUpdaterCheckResult {
    ok: boolean;
    hasUpdate?: boolean;
    currentVersion?: string;
    availableVersion?: string;
    message: string;
  }

  interface Window {
    desktopUpdater?: {
      checkForUpdates: () => Promise<DesktopUpdaterCheckResult>;
    };
  }
}
