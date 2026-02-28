import { fetchJobStatus } from "../api/client";
import type { ApiResult, JobStatusResponse } from "../types";

export class PollingAbortedError extends Error {
  constructor(message = "Polling aborted.") {
    super(message);
    this.name = "PollingAbortedError";
  }
}

export class JobCancelledByUserError extends Error {
  constructor(message = "Job cancelled by user.") {
    super(message);
    this.name = "JobCancelledByUserError";
  }
}

export const isPollingAbortedError = (error: unknown): boolean =>
  error instanceof PollingAbortedError;

export const isJobCancelledByUserError = (error: unknown): boolean =>
  error instanceof JobCancelledByUserError;

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new PollingAbortedError();
  }
};

const MAX_TRANSIENT_POLL_ERRORS = 30;

const isTransientPollingError = (error: unknown): boolean => {
  const message = String(error ?? "");
  return (
    message.includes("504 Gateway Time-out") ||
    message.includes("504 Gateway Timeout") ||
    message.includes("502 Bad Gateway") ||
    message.includes("upstream timed out") ||
    message.includes("Request timed out after") ||
    message.includes("Failed to fetch") ||
    message.includes("NetworkError when attempting to fetch resource")
  );
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new PollingAbortedError());
    };

    const timeout = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeout);
        reject(new PollingAbortedError());
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
    }
  });

export const waitForJobCompletion = async (
  jobId: string,
  onUpdate: (status: JobStatusResponse) => void,
  pollIntervalMs = 1200,
  options?: { signal?: AbortSignal },
): Promise<ApiResult> => {
  let transientPollFailures = 0;

  for (;;) {
    throwIfAborted(options?.signal);
    let status: JobStatusResponse;
    try {
      status = await fetchJobStatus(jobId);
      transientPollFailures = 0;
    } catch (error) {
      if (isTransientPollingError(error)) {
        transientPollFailures += 1;
        if (transientPollFailures <= MAX_TRANSIENT_POLL_ERRORS) {
          await sleep(pollIntervalMs, options?.signal);
          continue;
        }
      }
      throw error;
    }

    onUpdate(status);

    if (status.state === "success") {
      if (!status.result) {
        throw new Error("Job completed without result.");
      }
      return status.result;
    }

    if (status.state === "error") {
      throw new Error(status.error || status.message || "Job failed.");
    }

    if (status.state === "cancelled") {
      throw new JobCancelledByUserError(status.message || "Job cancelled by user.");
    }

    await sleep(pollIntervalMs, options?.signal);
  }
};
