export const logInfo = (message: string, payload?: unknown): void => {
  if (payload === undefined) {
    // eslint-disable-next-line no-console
    console.log(`[INFO] ${message}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[INFO] ${message}`, payload);
};

export const logError = (message: string, payload?: unknown): void => {
  if (payload === undefined) {
    // eslint-disable-next-line no-console
    console.error(`[ERROR] ${message}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.error(`[ERROR] ${message}`, payload);
};
