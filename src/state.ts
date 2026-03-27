import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { execSync, spawn } from "node:child_process";
import type { ProxyRuntimeConfig, ProxyState } from "./types.js";

export const isWindows = process.platform === "win32";
export const PRIVILEGED_PORT_THRESHOLD = 1024;
export const DEFAULT_HTTP_PORT = 80;
export const DEFAULT_HTTPS_PORT = 443;
export const SYSTEM_STATE_DIR = isWindows ? path.join(os.tmpdir(), "local-router") : "/tmp/local-router";
export const USER_STATE_DIR = path.join(os.homedir(), ".local-router");
const MIN_APP_PORT = 4000;
const MAX_APP_PORT = 4999;
const RANDOM_PORT_ATTEMPTS = 50;
const SOCKET_TIMEOUT_MS = 750;
const WAIT_FOR_PROXY_MAX_ATTEMPTS = 60;
const WAIT_FOR_PROXY_INTERVAL_MS = 250;
const HEALTH_HEADER = "x-local-router";

const SIGNAL_CODES: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGTERM: 15,
};

export function getDefaultHttpPort(): number {
  const value = Number(process.env.LOCAL_ROUTER_HTTP_PORT);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : DEFAULT_HTTP_PORT;
}

export function getDefaultHttpsPort(): number {
  const value = Number(process.env.LOCAL_ROUTER_HTTPS_PORT);
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : DEFAULT_HTTPS_PORT;
}

export function resolveStateDir(runtime?: ProxyRuntimeConfig): string {
  if (process.env.LOCAL_ROUTER_STATE_DIR) return process.env.LOCAL_ROUTER_STATE_DIR;

  const httpPort = runtime?.httpPort ?? getDefaultHttpPort();
  const httpsPort = runtime?.httpsPort ?? getDefaultHttpsPort();
  const needsSystemDir =
    !isWindows &&
    ((runtime?.httpEnabled ?? true) && httpPort < PRIVILEGED_PORT_THRESHOLD ||
      (runtime?.httpsEnabled ?? true) && httpsPort < PRIVILEGED_PORT_THRESHOLD);

  return needsSystemDir ? SYSTEM_STATE_DIR : USER_STATE_DIR;
}

function readProxyState(dir: string): ProxyState | null {
  try {
    const raw = fs.readFileSync(path.join(dir, "proxy-state.json"), "utf-8");
    return JSON.parse(raw) as ProxyState;
  } catch {
    return null;
  }
}

function getKnownStateDirsInternal(): string[] {
  if (process.env.LOCAL_ROUTER_STATE_DIR) {
    return [process.env.LOCAL_ROUTER_STATE_DIR];
  }

  return [USER_STATE_DIR, SYSTEM_STATE_DIR];
}

function stateMatchesRuntime(state: ProxyState, runtime: ProxyRuntimeConfig): boolean {
  return (
    state.httpPort === runtime.httpPort &&
    state.httpsPort === runtime.httpsPort &&
    state.httpEnabled === runtime.httpEnabled &&
    state.httpsEnabled === runtime.httpsEnabled
  );
}

export function getKnownStateDirs(): string[] {
  return Array.from(new Set(getKnownStateDirsInternal()));
}

export function writeProxyState(dir: string, state: ProxyState): void {
  fs.writeFileSync(path.join(dir, "proxy-state.json"), JSON.stringify(state, null, 2), { mode: 0o644 });
}

export function removeProxyState(dir: string): void {
  try {
    fs.unlinkSync(path.join(dir, "proxy-state.json"));
  } catch {
    // Non-fatal.
  }
}

function requestHealth(port: number, tls: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const request = (tls ? https : http).request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/__local_router/health",
        method: "HEAD",
        timeout: SOCKET_TIMEOUT_MS,
        ...(tls ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        response.resume();
        resolve(response.headers[HEALTH_HEADER] === "1");
      }
    );

    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}

export async function isProxyRunning(runtime: ProxyRuntimeConfig): Promise<boolean> {
  const checks: Promise<boolean>[] = [];

  if (runtime.httpEnabled) {
    checks.push(requestHealth(runtime.httpPort, false));
  }

  if (runtime.httpsEnabled) {
    checks.push(requestHealth(runtime.httpsPort, true));
  }

  if (checks.length === 0) return false;

  const results = await Promise.all(checks);
  return results.every(Boolean);
}

export async function discoverState(): Promise<{ dir: string; state: ProxyState | null }> {
  if (process.env.LOCAL_ROUTER_STATE_DIR) {
    const dir = process.env.LOCAL_ROUTER_STATE_DIR;
    return { dir, state: readProxyState(dir) };
  }

  for (const dir of [USER_STATE_DIR, SYSTEM_STATE_DIR]) {
    const state = readProxyState(dir);
    if (!state) continue;

    if (await isProxyRunning(state)) {
      return { dir, state };
    }
  }

  const fallback: ProxyState = {
    pid: 0,
    httpPort: getDefaultHttpPort(),
    httpsPort: getDefaultHttpsPort(),
    httpEnabled: true,
    httpsEnabled: true,
  };

  return { dir: resolveStateDir(fallback), state: null };
}

export async function discoverStateForRuntime(
  runtime: ProxyRuntimeConfig
): Promise<{ dir: string; state: ProxyState | null }> {
  for (const dir of getKnownStateDirsInternal()) {
    const state = readProxyState(dir);
    if (!state || !stateMatchesRuntime(state, runtime)) continue;

    if (await isProxyRunning(state)) {
      return { dir, state };
    }
  }

  return { dir: resolveStateDir(runtime), state: null };
}

export async function listRunningStates(): Promise<Array<{ dir: string; state: ProxyState }>> {
  const states: Array<{ dir: string; state: ProxyState }> = [];

  for (const dir of getKnownStateDirsInternal()) {
    const state = readProxyState(dir);
    if (!state) continue;

    if (await isProxyRunning(state)) {
      states.push({ dir, state });
    }
  }

  return states;
}

export async function waitForProxy(runtime: ProxyRuntimeConfig): Promise<boolean> {
  for (let attempt = 0; attempt < WAIT_FOR_PROXY_MAX_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_FOR_PROXY_INTERVAL_MS));
    if (await isProxyRunning(runtime)) {
      return true;
    }
  }

  return false;
}

export async function findFreePort(minPort = MIN_APP_PORT, maxPort = MAX_APP_PORT): Promise<number> {
  if (minPort > maxPort) {
    throw new Error(`Invalid app port range: ${minPort}-${maxPort}.`);
  }

  const tryPort = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.listen(port, () => server.close(() => resolve(true)));
      server.on("error", () => resolve(false));
    });

  for (let attempt = 0; attempt < RANDOM_PORT_ATTEMPTS; attempt += 1) {
    const port = minPort + Math.floor(Math.random() * (maxPort - minPort + 1));
    if (await tryPort(port)) return port;
  }

  for (let port = minPort; port <= maxPort; port += 1) {
    if (await tryPort(port)) return port;
  }

  throw new Error(`Could not find a free port between ${minPort} and ${maxPort}.`);
}

function collectBinPaths(cwd: string): string[] {
  const results: string[] = [];
  let dir = cwd;

  for (;;) {
    const binDir = path.join(dir, "node_modules", ".bin");
    if (fs.existsSync(binDir)) {
      results.push(binDir);
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return results;
}

function augmentedPath(env: NodeJS.ProcessEnv | undefined): string {
  const source = env ?? process.env;
  const basePath = source.PATH ?? source.Path ?? "";
  const nodeBin = path.dirname(process.execPath);
  return [...collectBinPaths(process.cwd()), nodeBin, basePath].join(path.delimiter);
}

export function spawnCommand(
  commandArgs: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    onCleanup?: () => void | Promise<void>;
  }
): void {
  const env = { ...(options?.env ?? process.env), PATH: augmentedPath(options?.env) };
  const commandText = commandArgs.join(" ").trim();
  const runThroughShell = commandArgs.length === 1 && /\s/.test(commandArgs[0]);

  const child = isWindows
    ? spawn(runThroughShell ? commandText : commandArgs[0], runThroughShell ? [] : commandArgs.slice(1), {
        stdio: "inherit",
        env,
        shell: true,
      })
    : runThroughShell
      ? spawn("/bin/sh", ["-lc", commandArgs[0]], {
          stdio: "inherit",
          env,
        })
      : spawn(commandArgs[0], commandArgs.slice(1), {
          stdio: "inherit",
          env,
        });

  let exiting = false;

  const cleanup = async () => {
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
    process.removeListener("SIGHUP", onSigHup);
    process.removeListener("uncaughtException", onUncaughtException);
    process.removeListener("unhandledRejection", onUnhandledRejection);
    await options?.onCleanup?.();
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    if (exiting) return;
    exiting = true;
    child.kill(signal);
    void cleanup().finally(() => {
      process.exit(128 + (SIGNAL_CODES[signal] || 15));
    });
  };

  const onSigInt = () => handleSignal("SIGINT");
  const onSigTerm = () => handleSignal("SIGTERM");
  const onSigHup = () => handleSignal("SIGHUP");
  const onUncaughtException = (error: Error) => {
    if (exiting) return;
    exiting = true;
    console.error(error.stack || error.message);
    child.kill("SIGTERM");
    void cleanup().finally(() => {
      process.exit(1);
    });
  };
  const onUnhandledRejection = (reason: unknown) => {
    if (exiting) return;
    exiting = true;
    console.error(reason instanceof Error ? reason.stack || reason.message : String(reason));
    child.kill("SIGTERM");
    void cleanup().finally(() => {
      process.exit(1);
    });
  };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  process.on("SIGHUP", onSigHup);
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  child.on("error", (error) => {
    if (exiting) return;
    exiting = true;
    console.error(`Failed to run command: ${error.message}`);
    void cleanup().finally(() => {
      process.exit(1);
    });
  });

  child.on("exit", (code, signal) => {
    if (exiting) return;
    exiting = true;
    void cleanup().finally(() => {
      if (signal) {
        process.exit(128 + (SIGNAL_CODES[signal] || 15));
      }

      process.exit(code ?? 1);
    });
  });
}

export function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export function findPidOnPort(port: number): number | null {
  try {
    if (isWindows) {
      const output = execSync("netstat -ano -p tcp", { encoding: "utf-8", timeout: 5000 });
      for (const line of output.split(/\r?\n/)) {
        if (!line.includes("LISTENING") || !line.includes(`:${port}`)) continue;
        const pid = Number(line.trim().split(/\s+/).at(-1));
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
      return null;
    }

    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    const pid = Number(output.split("\n")[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const FRAMEWORKS_NEEDING_PORT: Record<string, { strictPort: boolean }> = {
  vite: { strictPort: true },
  "react-router": { strictPort: true },
  astro: { strictPort: false },
  ng: { strictPort: false },
  "react-native": { strictPort: false },
  expo: { strictPort: false },
};

const PACKAGE_RUNNERS: Record<string, string[]> = {
  npx: [],
  bunx: [],
  pnpx: [],
  yarn: ["dlx", "exec"],
  pnpm: ["dlx", "exec"],
};

function findFrameworkBasename(commandArgs: string[]): string | null {
  if (commandArgs.length === 0) return null;

  const first = path.basename(commandArgs[0]);
  if (FRAMEWORKS_NEEDING_PORT[first]) return first;

  const subcommands = PACKAGE_RUNNERS[first];
  if (!subcommands) return null;

  let index = 1;

  if (subcommands.length > 0) {
    while (index < commandArgs.length && commandArgs[index].startsWith("-")) index += 1;
    if (index >= commandArgs.length) return null;

    if (!subcommands.includes(commandArgs[index])) {
      const name = path.basename(commandArgs[index]);
      return FRAMEWORKS_NEEDING_PORT[name] ? name : null;
    }

    index += 1;
  }

  while (index < commandArgs.length && commandArgs[index].startsWith("-")) index += 1;
  if (index >= commandArgs.length) return null;

  const name = path.basename(commandArgs[index]);
  return FRAMEWORKS_NEEDING_PORT[name] ? name : null;
}

export function injectFrameworkFlags(commandArgs: string[], port: number): void {
  const basename = findFrameworkBasename(commandArgs);
  if (!basename) return;

  if (!commandArgs.includes("--port")) {
    commandArgs.push("--port", String(port));
  }

  if (!commandArgs.includes("--host")) {
    const hostValue = basename === "expo" ? "localhost" : "127.0.0.1";
    commandArgs.push("--host", hostValue);
  }

  if (FRAMEWORKS_NEEDING_PORT[basename].strictPort && !commandArgs.includes("--strictPort")) {
    commandArgs.push("--strictPort");
  }
}

export function getHealthHeader(): string {
  return HEALTH_HEADER;
}
