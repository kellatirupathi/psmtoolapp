import { randomUUID } from "node:crypto";

export type JobState = "queued" | "running" | "success" | "error" | "cancelled";

export class JobCancelledError extends Error {
  constructor(message = "Cancelled by user.") {
    super(message);
    this.name = "JobCancelledError";
  }
}

export type JobProgress = {
  percent: number;
  loadedBytes?: number;
  totalBytes?: number;
};

export type JobRecord<T = unknown> = {
  id: string;
  state: JobState;
  message: string;
  result?: T;
  partialResult?: T;
  progress?: JobProgress;
  error?: string;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
};

export type JobUpdatePayload<T> = {
  partialResult?: T;
  progress?: JobProgress | null;
};

type JobUpdateCallback<T> = (message: string, payload?: JobUpdatePayload<T>) => void;

type JobRunnerControl = {
  isCancelled: () => boolean;
  throwIfCancelled: () => void;
};

const jobs = new Map<string, JobRecord>();
const JOB_TTL_MS = 1000 * 60 * 30;

const nowIso = (): string => new Date().toISOString();

const isTerminalState = (state: JobState): boolean =>
  state === "success" || state === "error" || state === "cancelled";

const cleanupExpiredJobs = (): void => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    const updatedAtMs = new Date(job.updatedAt).getTime();
    if (Number.isFinite(updatedAtMs) && now - updatedAtMs > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
};

export const createJob = <T>(
  runner: (update: JobUpdateCallback<T>, control: JobRunnerControl) => Promise<T>,
): JobRecord<T> => {
  cleanupExpiredJobs();
  const id = randomUUID();
  const initial: JobRecord<T> = {
    id,
    state: "queued",
    message: "Queued...",
    cancelRequested: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  jobs.set(id, initial);

  const update: JobUpdateCallback<T> = (message, payload) => {
    const current = jobs.get(id) as JobRecord<T> | undefined;
    if (!current) return;
    if (current.state === "cancelled") return;

    current.message = message;
    if (payload?.partialResult !== undefined) {
      current.partialResult = payload.partialResult;
    }

    if (payload && "progress" in payload) {
      current.progress = payload.progress ?? undefined;
    } else {
      current.progress = undefined;
    }

    current.updatedAt = nowIso();
    if (current.state === "queued") {
      current.state = "running";
    }
  };

  const control: JobRunnerControl = {
    isCancelled: () => {
      const current = jobs.get(id);
      return current?.cancelRequested === true || current?.state === "cancelled";
    },
    throwIfCancelled: () => {
      if (control.isCancelled()) {
        throw new JobCancelledError();
      }
    },
  };

  void (async () => {
    const current = jobs.get(id) as JobRecord<T> | undefined;
    if (!current) return;
    if (current.cancelRequested) {
      current.state = "cancelled";
      current.message = "Cancelled by user.";
      current.progress = undefined;
      current.updatedAt = nowIso();
      return;
    }

    current.state = "running";
    current.message = "Started...";
    current.progress = undefined;
    current.updatedAt = nowIso();

    try {
      const result = await runner(update, control);
      const done = jobs.get(id) as JobRecord<T> | undefined;
      if (!done) return;
      if (done.cancelRequested || done.state === "cancelled") {
        done.state = "cancelled";
        done.message = "Cancelled by user.";
        done.progress = undefined;
        done.updatedAt = nowIso();
        return;
      }

      done.state = "success";
      done.result = result;
      done.partialResult = result;
      done.message = "Completed.";
      done.progress = undefined;
      done.updatedAt = nowIso();
    } catch (error) {
      const failed = jobs.get(id) as JobRecord<T> | undefined;
      if (!failed) return;
      if (failed.cancelRequested || failed.state === "cancelled" || error instanceof JobCancelledError) {
        failed.state = "cancelled";
        failed.message = "Cancelled by user.";
        failed.progress = undefined;
        failed.updatedAt = nowIso();
        return;
      }

      failed.state = "error";
      failed.error = String(error);
      failed.message = failed.error;
      failed.progress = undefined;
      failed.updatedAt = nowIso();
    }
  })();

  return initial;
};

export const getJob = (id: string): JobRecord | null => {
  cleanupExpiredJobs();
  return jobs.get(id) ?? null;
};

export const cancelJob = (id: string): JobRecord | null => {
  cleanupExpiredJobs();
  const job = jobs.get(id);
  if (!job) return null;
  if (isTerminalState(job.state)) {
    return job;
  }

  job.cancelRequested = true;
  job.state = "cancelled";
  job.message = "Cancelled by user.";
  job.progress = undefined;
  job.updatedAt = nowIso();
  return job;
};
