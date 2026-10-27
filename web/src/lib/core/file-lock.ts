import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { careerOpsRoot } from "@/lib/career-ops";

/**
 * Per-file cross-process lock for the web's settings and CV writers, built on
 * the core's `pipeline-lock.mjs` (lock dir `<file>.lock`, dir-lock protocol).
 *
 * These routes are load-edit-write: `atomicWriteWithBackup` makes the rename
 * atomic, not the read before it. A second writer (another tab, the cloud inbox
 * runner, a core script locking the same path) that reads in between has its
 * change silently replaced. Any core writer that wants to coordinate with the
 * web just calls `withPipelineLock(<same absolute path>, fn)`.
 *
 * Not reentrant, same as every dir lock here: never shell out to a core script
 * that locks the same file while holding this.
 */

type CoreWithLock = (file: string, fn: () => unknown, options?: Record<string, unknown>) => Promise<unknown>;

// Failures are never cached, so a repaired checkout is picked up next request.
const modCache = new Map<string, CoreWithLock>();

async function loadCoreLock(): Promise<CoreWithLock | null> {
  const file = path.join(careerOpsRoot(), "pipeline-lock.mjs");
  const cached = modCache.get(file);
  if (cached) return cached;
  // A data-only root has no core scripts to race, so running unlocked is right.
  if (!fs.existsSync(file)) return null;
  const mod = await import(/* webpackIgnore: true */ pathToFileURL(file).href);
  if (typeof mod.withPipelineLock !== "function") throw new Error("pipeline-lock.mjs has no withPipelineLock export");
  modCache.set(file, mod.withPipelineLock as CoreWithLock);
  return mod.withPipelineLock as CoreWithLock;
}

/** Thrown when another writer holds the file past the web timeout. */
export class FileBusyError extends Error {
  constructor(file: string) {
    super(`${path.basename(file)} is being written by another process`);
    this.name = "FileBusyError";
  }
}

/**
 * Run `fn` holding the lock on `file`; the core releases it on every path.
 * Short timeout for the same reason as withTrackerLock: inside an HTTP handler,
 * answering 409 beats a request that hangs for the CLI's default wait.
 */
export async function withFileLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const core = await loadCoreLock();
  if (!core) return await fn();
  try {
    return (await core(path.resolve(file), fn as () => unknown, {
      timeoutMs: Number(process.env.CAREER_OPS_WEB_LOCK_TIMEOUT_MS) || 5_000,
      retryMs: 50,
      maxWaitMs: Number(process.env.CAREER_OPS_WEB_LOCK_TIMEOUT_MS) || 5_000,
    })) as T;
  } catch (e) {
    // Only the acquire throws LockTimeoutError; fn's own errors pass through.
    if ((e as { name?: string } | null)?.name === "LockTimeoutError") throw new FileBusyError(file);
    throw e;
  }
}
