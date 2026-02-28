type DesktopNotificationArgs = {
  title: string;
  body: string;
  tag?: string;
};

const isSupported = (): boolean =>
  typeof window !== "undefined" &&
  typeof Notification !== "undefined";

const canUseServiceWorkerNotifications = (): boolean =>
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator;

export const requestDesktopNotificationPermission = async (): Promise<NotificationPermission | "unsupported"> => {
  if (!isSupported()) {
    return "unsupported";
  }

  if (Notification.permission === "default") {
    try {
      return await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  }

  return Notification.permission;
};

const showViaServiceWorker = async (args: DesktopNotificationArgs): Promise<boolean> => {
  if (!canUseServiceWorkerNotifications()) {
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) {
      return false;
    }

    await registration.showNotification(args.title, {
      body: args.body,
      tag: args.tag,
    });
    return true;
  } catch {
    return false;
  }
};

const showViaWindowNotification = (args: DesktopNotificationArgs): boolean => {
  if (!isSupported() || Notification.permission !== "granted") {
    return false;
  }

  try {
    const notification = new Notification(args.title, {
      body: args.body,
      tag: args.tag,
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    return true;
  } catch {
    return false;
  }
};

export const showDesktopNotification = async (args: DesktopNotificationArgs): Promise<boolean> => {
  if (!isSupported() || Notification.permission !== "granted") {
    return false;
  }

  const serviceWorkerShown = await showViaServiceWorker(args);
  if (serviceWorkerShown) {
    return true;
  }

  return showViaWindowNotification(args);
};

export const notifyJobCompleted = async (args: {
  jobName: string;
  rowsCount?: number;
  savedToSheet?: boolean;
  savedToBigQuery?: boolean;
}): Promise<void> => {
  const parts: string[] = [];
  if (typeof args.rowsCount === "number") {
    parts.push(`Rows: ${args.rowsCount}`);
  }
  if (typeof args.savedToSheet === "boolean") {
    parts.push(`Saved to sheet: ${args.savedToSheet ? "Yes" : "No"}`);
  }
  if (typeof args.savedToBigQuery === "boolean") {
    parts.push(`Saved to BigQuery: ${args.savedToBigQuery ? "Yes" : "No"}`);
  }

  const body = parts.length > 0 ? parts.join(" | ") : "Processing completed.";

  await showDesktopNotification({
    title: `${args.jobName} completed`,
    body,
    tag: `${args.jobName}-done`,
  });
};

export const notifyJobFailed = async (args: {
  jobName: string;
  errorMessage?: string;
}): Promise<void> => {
  const body = args.errorMessage ? `Error: ${args.errorMessage}` : "Processing failed.";

  await showDesktopNotification({
    title: `${args.jobName} failed`,
    body,
    tag: `${args.jobName}-failed`,
  });
};
