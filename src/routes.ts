import * as fs from "node:fs";
import * as path from "node:path";
import type { RouteMapping } from "./types.js";
import { fixOwnership, isErrnoException, normalizeExplicitHostname } from "./utils.js";

const STALE_LOCK_THRESHOLD_MS = 10_000;
const LOCK_MAX_RETRIES = 20;
const LOCK_RETRY_DELAY_MS = 50;

export const FILE_MODE = 0o644;
export const DIR_MODE = 0o755;
export const SYSTEM_DIR_MODE = 0o1777;
export const SYSTEM_FILE_MODE = 0o666;

export class RouteConflictError extends Error {
  readonly hostname: string;
  readonly existingPid: number;

  constructor(hostname: string, existingPid: number) {
    super(
      `"${hostname}" is already registered by a running process (PID ${existingPid}). Use --force to override.`
    );
    this.name = "RouteConflictError";
    this.hostname = hostname;
    this.existingPid = existingPid;
  }
}

function isValidRoute(value: unknown): value is RouteMapping {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RouteMapping).hostname === "string" &&
    typeof (value as RouteMapping).port === "number" &&
    typeof (value as RouteMapping).pid === "number" &&
    ((value as RouteMapping).appName === undefined || typeof (value as RouteMapping).appName === "string") &&
    ((value as RouteMapping).command === undefined || typeof (value as RouteMapping).command === "string") &&
    ((value as RouteMapping).cwd === undefined || typeof (value as RouteMapping).cwd === "string") &&
    ((value as RouteMapping).syncToHosts === undefined ||
      typeof (value as RouteMapping).syncToHosts === "boolean") &&
    ((value as RouteMapping).upstreamHost === undefined ||
      typeof (value as RouteMapping).upstreamHost === "string")
  );
}

function normalizeRoute(route: RouteMapping): RouteMapping | null {
  try {
    return {
      ...route,
      hostname: normalizeExplicitHostname(route.hostname),
    };
  } catch {
    return null;
  }
}

export class RouteStore {
  readonly dir: string;
  readonly routesPath: string;
  readonly lockPath: string;
  readonly pidPath: string;
  readonly statePath: string;
  private readonly isSystemDir: boolean;
  private readonly onWarning?: (message: string) => void;

  private static sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

  constructor(dir: string, options?: { isSystemDir?: boolean; onWarning?: (message: string) => void }) {
    this.dir = dir;
    this.isSystemDir = options?.isSystemDir ?? false;
    this.routesPath = path.join(dir, "routes.json");
    this.lockPath = path.join(dir, "routes.lock");
    this.pidPath = path.join(dir, "proxy.pid");
    this.statePath = path.join(dir, "proxy-state.json");
    this.onWarning = options?.onWarning;
  }

  private get dirMode(): number {
    return this.isSystemDir ? SYSTEM_DIR_MODE : DIR_MODE;
  }

  private get fileMode(): number {
    return this.isSystemDir ? SYSTEM_FILE_MODE : FILE_MODE;
  }

  ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: this.dirMode });
    }

    try {
      fs.chmodSync(this.dir, this.dirMode);
    } catch {
      // Non-fatal.
    }

    fixOwnership(this.dir);
  }

  private syncSleep(ms: number): void {
    Atomics.wait(RouteStore.sleepBuffer, 0, 0, ms);
  }

  private acquireLock(maxRetries = LOCK_MAX_RETRIES, retryDelayMs = LOCK_RETRY_DELAY_MS): boolean {
    for (let index = 0; index < maxRetries; index += 1) {
      try {
        fs.mkdirSync(this.lockPath);
        return true;
      } catch (error) {
        if (isErrnoException(error) && error.code === "EEXIST") {
          try {
            const stats = fs.statSync(this.lockPath);
            if (Date.now() - stats.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
              fs.rmSync(this.lockPath, { recursive: true, force: true });
              continue;
            }
          } catch {
            continue;
          }

          this.syncSleep(retryDelayMs);
          continue;
        }

        return false;
      }
    }

    return false;
  }

  private releaseLock(): void {
    try {
      fs.rmSync(this.lockPath, { recursive: true, force: true });
    } catch {
      // Non-fatal.
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  loadRoutes(persistCleanup = false): RouteMapping[] {
    if (!fs.existsSync(this.routesPath)) return [];

    try {
      const raw = fs.readFileSync(this.routesPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;

      if (!Array.isArray(parsed)) {
        this.onWarning?.(`Corrupted routes file: expected an array at ${this.routesPath}.`);
        return [];
      }

      const routes = parsed.filter(isValidRoute).flatMap((route) => {
        const normalized = normalizeRoute(route);
        return normalized ? [normalized] : [];
      });
      const aliveRoutes = routes.filter((route) => this.isProcessAlive(route.pid));

      if (persistCleanup && aliveRoutes.length !== routes.length) {
        this.saveRoutes(aliveRoutes);
      }

      return aliveRoutes;
    } catch {
      this.onWarning?.(`Failed to read routes from ${this.routesPath}.`);
      return [];
    }
  }

  private saveRoutes(routes: RouteMapping[]): void {
    fs.writeFileSync(this.routesPath, JSON.stringify(routes, null, 2), { mode: this.fileMode });
    fixOwnership(this.routesPath);
  }

  addRoute(
    hostname: string,
    port: number,
    pid: number,
    force = false,
    metadata?: {
      appName?: string;
      command?: string;
      cwd?: string;
      syncToHosts?: boolean;
      upstreamHost?: string;
    }
  ): void {
    const normalizedHostname = normalizeExplicitHostname(hostname);
    this.ensureDir();
    if (!this.acquireLock()) {
      throw new Error("Failed to acquire route lock.");
    }

    try {
      const routes = this.loadRoutes(true);
      const existing = routes.find((route) => route.hostname === normalizedHostname);
      if (existing && existing.pid !== pid && this.isProcessAlive(existing.pid) && !force) {
        throw new RouteConflictError(normalizedHostname, existing.pid);
      }

      const nextRoutes = routes.filter((route) => route.hostname !== normalizedHostname);
      nextRoutes.push({
        hostname: normalizedHostname,
        port,
        pid,
        ...(metadata?.appName ? { appName: metadata.appName } : {}),
        ...(metadata?.command ? { command: metadata.command } : {}),
        ...(metadata?.cwd ? { cwd: metadata.cwd } : {}),
        ...(metadata?.syncToHosts !== undefined ? { syncToHosts: metadata.syncToHosts } : {}),
        ...(metadata?.upstreamHost ? { upstreamHost: metadata.upstreamHost } : {}),
      });
      this.saveRoutes(nextRoutes);
    } finally {
      this.releaseLock();
    }
  }

  removeRoute(hostname: string): void {
    const normalizedHostname = normalizeExplicitHostname(hostname);
    this.ensureDir();
    if (!this.acquireLock()) {
      throw new Error("Failed to acquire route lock.");
    }

    try {
      const nextRoutes = this.loadRoutes(true).filter((route) => route.hostname !== normalizedHostname);
      this.saveRoutes(nextRoutes);
    } finally {
      this.releaseLock();
    }
  }
}
