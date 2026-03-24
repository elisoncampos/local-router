#!/usr/bin/env node

import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSNICallback, ensureCerts, isCATrusted, trustCA } from "./certs.js";
import { resolveProjectHosts } from "./config.js";
import { cleanHostsFile, syncHostsFile } from "./hosts.js";
import { createProxyServers } from "./proxy.js";
import { DIR_MODE, FILE_MODE, RouteConflictError, RouteStore } from "./routes.js";
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  PRIVILEGED_PORT_THRESHOLD,
  SYSTEM_STATE_DIR,
  discoverState,
  discoverStateForRuntime,
  findFreePort,
  findPidOnPort,
  getKnownStateDirs,
  getDefaultHttpPort,
  getDefaultHttpsPort,
  injectFrameworkFlags,
  isProxyRunning,
  isWindows,
  prompt,
  removeProxyState,
  resolveStateDir,
  spawnCommand,
  waitForProxy,
  writeProxyState,
} from "./state.js";
import type { ProxyRuntimeConfig, ProxyTlsOptions, RouteMapping } from "./types.js";
import { fixOwnership, formatUrl, isErrnoException } from "./utils.js";

const HOSTS_DISPLAY = isWindows ? "hosts file" : "/etc/hosts";
const SUDO_PREFIX = isWindows ? "" : "sudo ";
const DEBOUNCE_MS = 100;
const POLL_INTERVAL_MS = 3000;
const EXIT_TIMEOUT_MS = 2000;
const START_TIMEOUT_MS = 30_000;
const AUTO_STOP_IDLE_MS = 3000;
const AUTO_STOP_STARTUP_GRACE_MS = 15_000;
const LOCALHOST_ONLY_HTTP_PORT = 18080;
const LOCALHOST_ONLY_HTTPS_PORT = 18443;
const CLI_ENTRY_PATH = fileURLToPath(import.meta.url);
const PACKAGE_VERSION = getPackageVersion();

interface RunOptions {
  force: boolean;
  appPort?: number;
  name?: string;
  domains: string[];
  commandArgs: string[];
}

interface ProxyOptions extends ProxyRuntimeConfig {
  foreground: boolean;
  autoStopWhenIdle: boolean;
}

interface RuntimeSelection {
  runtime: ProxyRuntimeConfig;
  alternativeRuntimes: ProxyRuntimeConfig[];
}

interface EnsuredProxy {
  dir: string;
  store: RouteStore;
  runtime: ProxyRuntimeConfig;
  source: "started" | "existing";
  wasIdleBeforeRun: boolean;
  autoStopsWhenIdle: boolean;
}

function getPackageVersion(): string {
  try {
    const packageJsonPath = path.join(path.dirname(path.dirname(CLI_ENTRY_PATH)), "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { version?: string };
    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function maybeWarnAboutNodeFallback(): void {
  if (process.env.LOCAL_ROUTER_NODE_FALLBACK !== "1") return;

  const fallbackNode = process.env.LOCAL_ROUTER_NODE_BIN;
  if (!fallbackNode) return;

  console.warn(
    chalk.yellow(
      `Warning: the project-local Node.js runtime was not available. Falling back to ${fallbackNode}.`
    )
  );
  console.warn(
    chalk.gray("Install the project's Node version in asdf, mise, nvm, or your preferred manager.\n")
  );
}

function getSelfInvocation(args: string[]): { command: string; args: string[] } {
  if (CLI_ENTRY_PATH.endsWith(".ts")) {
    const projectRoot = path.dirname(path.dirname(CLI_ENTRY_PATH));
    const tsxBin = path.join(
      projectRoot,
      "node_modules",
      ".bin",
      isWindows ? "tsx.cmd" : "tsx"
    );

    return {
      command: tsxBin,
      args: [CLI_ENTRY_PATH, ...args],
    };
  }

  return {
    command: process.execPath,
    args: [CLI_ENTRY_PATH, ...args],
  };
}

function isLocalhostHostname(hostname: string): boolean {
  return hostname.endsWith(".localhost");
}

function hasCustomDomains(hostnames: string[]): boolean {
  return hostnames.some((hostname) => !isLocalhostHostname(hostname));
}

function hasExplicitProxyPortOverrides(): boolean {
  return process.env.LOCAL_ROUTER_HTTP_PORT !== undefined || process.env.LOCAL_ROUTER_HTTPS_PORT !== undefined;
}

function getDefaultRuntime(): ProxyRuntimeConfig {
  return {
    httpPort: getDefaultHttpPort(),
    httpsPort: getDefaultHttpsPort(),
    httpEnabled: true,
    httpsEnabled: true,
  };
}

function getLocalhostOnlyRuntime(): ProxyRuntimeConfig {
  return {
    httpPort: LOCALHOST_ONLY_HTTP_PORT,
    httpsPort: LOCALHOST_ONLY_HTTPS_PORT,
    httpEnabled: true,
    httpsEnabled: true,
  };
}

function resolveRuntimeSelection(hostnames: string[]): RuntimeSelection {
  const defaultRuntime = getDefaultRuntime();

  if (hasCustomDomains(hostnames) || hasExplicitProxyPortOverrides()) {
    return {
      runtime: defaultRuntime,
      alternativeRuntimes: [],
    };
  }

  return {
    runtime: getLocalhostOnlyRuntime(),
    alternativeRuntimes: [defaultRuntime],
  };
}

function printHelp(): void {
  console.log(`
${chalk.bold("local-router")} - Stable local domains with HTTP and HTTPS on the real hostnames you want.

${chalk.bold("Core commands:")}
  ${chalk.cyan("local-router run next dev")}                           Infer the project name and expose it as https://<name>.localhost
  ${chalk.cyan("local-router run next dev --domain rapha.com.br")}     Add a real domain override that resolves locally
  ${chalk.cyan("local-router list")}                                   List registered apps, ports, domains, and commands
  ${chalk.cyan("local-router proxy start")}                            Start the shared proxy daemon
  ${chalk.cyan("local-router proxy stop")}                             Stop the shared proxy daemon
  ${chalk.cyan("local-router trust")}                                  Trust the generated local CA for HTTPS
  ${chalk.cyan("local-router hosts sync")}                             Sync managed entries to ${HOSTS_DISPLAY}

${chalk.bold("Config file:")}
  Create ${chalk.cyan(".local-router")} in the project root:

  {
    name: "algo",
    hosts: ["rapha.com.br", "bozo.com.br"]
  }

  Then:
    ${chalk.cyan("local-router run next dev")}

  Exposes:
    ${chalk.cyan("http://algo.localhost")}
    ${chalk.cyan("https://algo.localhost")}
    ${chalk.cyan("http://rapha.com.br")}
    ${chalk.cyan("https://rapha.com.br")}
    ${chalk.cyan("http://bozo.com.br")}
    ${chalk.cyan("https://bozo.com.br")}

${chalk.bold("Options:")}
  run --name <name>                Override the inferred .localhost name
  run --domain <host>              Add a custom hostname (repeatable, can be placed after the child command)
  run --app-port <port>            Force the app port instead of auto-assigning one
  run --force                      Replace an existing route registered by another process
  proxy start --http-port <port>   Override the HTTP listener port (default: ${DEFAULT_HTTP_PORT})
  proxy start --https-port <port>  Override the HTTPS listener port (default: ${DEFAULT_HTTPS_PORT})
  proxy start --no-http            Disable the HTTP listener
  proxy start --no-https           Disable the HTTPS listener
  proxy start --keep-alive         Keep the proxy alive even when no apps are registered
  proxy start --foreground         Run in the foreground for debugging

${chalk.bold("Notes:")}
  - Ports 80 and 443 require sudo on Unix. The CLI only prompts when custom domains or explicit privileged ports require it.
  - The shared proxy stops itself when no apps remain, unless you start it with ${chalk.cyan("--keep-alive")}.
  - Custom domains are managed through ${HOSTS_DISPLAY} and are restored/cleaned automatically.
  - HTTPS uses a local CA and per-host certificates generated on demand.
`);
}

function parseNumberFlag(flag: string, value: string | undefined): number {
  if (!value || value.startsWith("-")) {
    console.error(chalk.red(`Error: ${flag} requires a numeric value.`));
    process.exit(1);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    console.error(chalk.red(`Error: Invalid port "${value}". Expected a number between 1 and 65535.`));
    process.exit(1);
  }

  return parsed;
}

function parseRunArgs(args: string[]): RunOptions {
  const options: RunOptions = {
    force: false,
    domains: [],
    commandArgs: [],
  };

  let passthrough = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (!passthrough && token === "--") {
      passthrough = true;
      continue;
    }

    if (!passthrough && token === "--force") {
      options.force = true;
      continue;
    }

    if (!passthrough && token === "--name") {
      options.name = args[index + 1];
      if (!options.name || options.name.startsWith("-")) {
        console.error(chalk.red("Error: --name requires a value."));
        process.exit(1);
      }
      index += 1;
      continue;
    }

    if (!passthrough && token === "--domain") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        console.error(chalk.red("Error: --domain requires a hostname."));
        process.exit(1);
      }
      options.domains.push(value);
      index += 1;
      continue;
    }

    if (!passthrough && token === "--app-port") {
      options.appPort = parseNumberFlag("--app-port", args[index + 1]);
      index += 1;
      continue;
    }

    if (!passthrough && (token === "--help" || token === "-h")) {
      console.log(`
${chalk.bold("local-router run")} - Infer the project name, register hostnames, and run the app.

${chalk.bold("Usage:")}
  ${chalk.cyan("local-router run <command...>")}
  ${chalk.cyan("local-router run next dev --domain rapha.com.br")}
  ${chalk.cyan('local-router run "npm run start:dev"')}

${chalk.bold("Flags accepted anywhere before '--':")}
  --name <name>          Override the base .localhost name
  --domain <host>        Add a custom hostname override
  --app-port <port>      Use a fixed port for the child app
  --force                Replace routes already claimed by another process

Use ${chalk.cyan("--")} if the child command itself needs a colliding flag name.
`);
      process.exit(0);
    }

    options.commandArgs.push(token);
  }

  return options;
}

function parseProxyArgs(args: string[]): ProxyOptions {
  const options: ProxyOptions = {
    httpPort: getDefaultHttpPort(),
    httpsPort: getDefaultHttpsPort(),
    httpEnabled: true,
    httpsEnabled: true,
    foreground: false,
    autoStopWhenIdle: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--foreground") {
      options.foreground = true;
      continue;
    }

    if (token === "--auto-stop-when-idle") {
      options.autoStopWhenIdle = true;
      continue;
    }

    if (token === "--keep-alive") {
      options.autoStopWhenIdle = false;
      continue;
    }

    if (token === "--http-port") {
      options.httpPort = parseNumberFlag("--http-port", args[index + 1]);
      index += 1;
      continue;
    }

    if (token === "--https-port") {
      options.httpsPort = parseNumberFlag("--https-port", args[index + 1]);
      index += 1;
      continue;
    }

    if (token === "--no-http") {
      options.httpEnabled = false;
      continue;
    }

    if (token === "--no-https") {
      options.httpsEnabled = false;
      continue;
    }

    if (token === "--help" || token === "-h") {
      console.log(`
${chalk.bold("local-router proxy start")} - Start the shared router daemon.

${chalk.bold("Usage:")}
  ${chalk.cyan("local-router proxy start")}
  ${chalk.cyan("local-router proxy start --foreground")}
  ${chalk.cyan("local-router proxy start --http-port 8080 --https-port 8443")}

${chalk.bold("Options:")}
  --http-port <port>     HTTP listener port (default: ${DEFAULT_HTTP_PORT})
  --https-port <port>    HTTPS listener port (default: ${DEFAULT_HTTPS_PORT})
  --no-http              Disable the HTTP listener
  --no-https             Disable the HTTPS listener
  --keep-alive           Keep the proxy alive when no routes remain
  --foreground           Run without daemonizing
`);
      process.exit(0);
    }

    console.error(chalk.red(`Error: Unknown proxy flag "${token}".`));
    process.exit(1);
  }

  if (!options.httpEnabled && !options.httpsEnabled) {
    console.error(chalk.red("Error: at least one of HTTP or HTTPS must stay enabled."));
    process.exit(1);
  }

  return options;
}

function printUrls(hostnames: string[], runtime: ProxyRuntimeConfig): void {
  console.log(chalk.blue.bold("\nURLs\n"));
  for (const hostname of hostnames) {
    if (runtime.httpEnabled) {
      console.log(chalk.cyan(`  ${formatUrl(hostname, false, runtime.httpPort)}`));
    }
    if (runtime.httpsEnabled) {
      console.log(chalk.cyan(`  ${formatUrl(hostname, true, runtime.httpsPort)}`));
    }
  }
  console.log();
}

function getStateDirs(): string[] {
  return Array.from(new Set(getKnownStateDirs()));
}

function loadRoutesFromStoreDir(dir: string): RouteMapping[] {
  const store = new RouteStore(dir, { isSystemDir: dir === SYSTEM_STATE_DIR });
  return store.loadRoutes(true);
}

function loadAllRoutes(): RouteMapping[] {
  const seen = new Set<string>();
  const routes: RouteMapping[] = [];

  for (const dir of getStateDirs()) {
    for (const route of loadRoutesFromStoreDir(dir)) {
      const key = `${route.pid}:${route.port}:${route.hostname}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push(route);
    }
  }

  return routes;
}

function syncHostsAcrossStores(): void {
  const hostnames = loadAllRoutes()
    .map((route) => route.hostname)
    .filter((hostname) => !isLocalhostHostname(hostname));

  if (hostnames.length === 0) {
    cleanHostsFile();
    return;
  }

  syncHostsFile(hostnames);
}

function formatCommand(commandArgs: string[]): string {
  return commandArgs.join(" ").trim();
}

function inferAppName(route: RouteMapping): string {
  if (route.appName) return route.appName;
  if (route.hostname.endsWith(".localhost")) {
    return route.hostname.slice(0, -".localhost".length);
  }
  return route.hostname;
}

function padCell(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function printRouteTable(routes: RouteMapping[]): void {
  if (routes.length === 0) {
    console.log(chalk.yellow("No apps are currently registered."));
    return;
  }

  const grouped = new Map<
    string,
    { appName: string; port: number; command: string; hostnames: string[] }
  >();

  for (const route of routes) {
    const appName = inferAppName(route);
    const command = route.command ?? "-";
    const key = `${route.pid}:${route.port}:${appName}:${command}`;
    const existing = grouped.get(key);

    if (existing) {
      existing.hostnames.push(route.hostname);
      continue;
    }

    grouped.set(key, {
      appName,
      port: route.port,
      command,
      hostnames: [route.hostname],
    });
  }

  const rows = Array.from(grouped.values())
    .map((row) => ({
      appName: row.appName,
      port: String(row.port),
      domains: Array.from(new Set(row.hostnames))
        .sort((left, right) => {
          if (isLocalhostHostname(left) && !isLocalhostHostname(right)) return -1;
          if (!isLocalhostHostname(left) && isLocalhostHostname(right)) return 1;
          return left.localeCompare(right);
        })
        .join(", "),
      command: row.command,
    }))
    .sort((left, right) => left.appName.localeCompare(right.appName));

  const headers = {
    appName: "APP",
    port: "PORT",
    domains: "DOMAINS",
    command: "CMD",
  };

  const widths = {
    appName: Math.max(headers.appName.length, ...rows.map((row) => row.appName.length)),
    port: Math.max(headers.port.length, ...rows.map((row) => row.port.length)),
    domains: Math.max(headers.domains.length, ...rows.map((row) => row.domains.length)),
    command: Math.max(headers.command.length, ...rows.map((row) => row.command.length)),
  };

  const divider = [
    "-".repeat(widths.appName),
    "-".repeat(widths.port),
    "-".repeat(widths.domains),
    "-".repeat(widths.command),
  ].join("-+-");

  console.log();
  console.log(
    [
      padCell(headers.appName, widths.appName),
      padCell(headers.port, widths.port),
      padCell(headers.domains, widths.domains),
      padCell(headers.command, widths.command),
    ].join(" | ")
  );
  console.log(divider);

  for (const row of rows) {
    console.log(
      [
        padCell(row.appName, widths.appName),
        padCell(row.port, widths.port),
        padCell(row.domains, widths.domains),
        padCell(row.command, widths.command),
      ].join(" | ")
    );
  }

  console.log();
}

function registerHostnames(
  store: RouteStore,
  hostnames: string[],
  port: number,
  pid: number,
  force: boolean,
  metadata?: { appName?: string; command?: string }
): void {
  const registered: string[] = [];

  try {
    for (const hostname of hostnames) {
      store.addRoute(hostname, port, pid, force, metadata);
      registered.push(hostname);
    }
  } catch (error) {
    for (const hostname of registered) {
      try {
        store.removeRoute(hostname);
      } catch {
        // Best effort rollback.
      }
    }

    throw error;
  }
}

async function stopProxy(store: RouteStore, stateDir: string, runtime: ProxyRuntimeConfig): Promise<void> {
  if (!fs.existsSync(store.pidPath)) {
    if (await isProxyRunning(runtime)) {
      const pid = findPidOnPort(runtime.httpEnabled ? runtime.httpPort : runtime.httpsPort);
      if (pid !== null) {
        try {
          process.kill(pid, "SIGTERM");
          removeProxyState(stateDir);
          console.log(chalk.green(`Stopped proxy process ${pid}.`));
          return;
        } catch (error) {
          if (isErrnoException(error) && error.code === "EPERM") {
            console.error(chalk.red("Permission denied while stopping the proxy."));
            console.error(chalk.cyan(`  ${SUDO_PREFIX}local-router proxy stop`));
            process.exit(1);
          }
        }
      }
    }

    console.log(chalk.yellow("Proxy is not running."));
    return;
  }

  try {
    const pid = Number(fs.readFileSync(store.pidPath, "utf-8"));
    if (!Number.isInteger(pid) || pid <= 0) {
      console.error(chalk.red("Corrupted PID file."));
      process.exit(1);
    }

    process.kill(pid, "SIGTERM");
    console.log(chalk.green("Proxy stopped."));
  } catch (error) {
    if (isErrnoException(error) && error.code === "EPERM") {
      console.error(chalk.red("Permission denied while stopping the proxy."));
      console.error(chalk.cyan(`  ${SUDO_PREFIX}local-router proxy stop`));
      process.exit(1);
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`Failed to stop the proxy: ${message}`));
    process.exit(1);
  }
}

function tryStopIdleExistingProxy(store: RouteStore, stateDir: string, runtime: ProxyRuntimeConfig): void {
  let pid: number | null = null;

  if (fs.existsSync(store.pidPath)) {
    try {
      const parsed = Number(fs.readFileSync(store.pidPath, "utf-8"));
      if (Number.isInteger(parsed) && parsed > 0) {
        pid = parsed;
      }
    } catch {
      pid = null;
    }
  }

  if (pid === null) {
    pid = findPidOnPort(runtime.httpEnabled ? runtime.httpPort : runtime.httpsPort);
  }

  if (pid === null) return;

  try {
    process.kill(pid, "SIGTERM");
    removeProxyState(stateDir);
  } catch {
    // Best effort.
  }
}

function writeEmptyRoutesIfNeeded(store: RouteStore): void {
  if (!fs.existsSync(store.routesPath)) {
    fs.writeFileSync(store.routesPath, "[]", { mode: FILE_MODE });
    fixOwnership(store.routesPath);
  }
}

function needsPrivileges(runtime: ProxyRuntimeConfig): boolean {
  if (isWindows) return false;

  return (
    (runtime.httpEnabled && runtime.httpPort < PRIVILEGED_PORT_THRESHOLD) ||
    (runtime.httpsEnabled && runtime.httpsPort < PRIVILEGED_PORT_THRESHOLD)
  );
}

function startProxyServer(store: RouteStore, runtime: ProxyOptions, stateDir: string): void {
  store.ensureDir();
  writeEmptyRoutesIfNeeded(store);

  let cachedRoutes = store.loadRoutes(true);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let cleaningUp = false;
  let hasSeenRoutes = cachedRoutes.length > 0;

  const clearIdleTimer = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const scheduleIdleShutdown = () => {
    if (!runtime.autoStopWhenIdle || idleTimer || cachedRoutes.length > 0) return;
    const delay = hasSeenRoutes ? AUTO_STOP_IDLE_MS : AUTO_STOP_STARTUP_GRACE_MS;

    idleTimer = setTimeout(() => {
      idleTimer = null;
      cachedRoutes = store.loadRoutes(true);
      if (cachedRoutes.length === 0) {
        cleanup();
      }
    }, delay);
    idleTimer.unref();
  };

  const reloadRoutes = () => {
    try {
      cachedRoutes = store.loadRoutes(true);
      syncHostsAcrossStores();
      if (cachedRoutes.length > 0) {
        hasSeenRoutes = true;
        clearIdleTimer();
      } else {
        scheduleIdleShutdown();
      }
    } catch {
      // Keep the previous cache if the file is mid-write.
    }
  };

  try {
    watcher = fs.watch(store.routesPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(reloadRoutes, DEBOUNCE_MS);
    });
  } catch {
    // Fall back to interval-only housekeeping below.
  }

  poller = setInterval(reloadRoutes, POLL_INTERVAL_MS);
  poller.unref();

  syncHostsAcrossStores();

  let tlsOptions: ProxyTlsOptions | undefined;
  if (runtime.httpsEnabled) {
    const certs = ensureCerts(stateDir);
    if (!isCATrusted(stateDir)) {
      const trustResult = trustCA(stateDir);
      if (!trustResult.trusted) {
        console.warn(chalk.yellow("Warning: could not trust the local CA automatically."));
        if (trustResult.error) {
          console.warn(chalk.gray(trustResult.error));
        }
      }
    }

    tlsOptions = {
      cert: fs.readFileSync(certs.certPath),
      key: fs.readFileSync(certs.keyPath),
      SNICallback: createSNICallback(stateDir, fs.readFileSync(certs.certPath), fs.readFileSync(certs.keyPath)),
    };
  }

  const servers = createProxyServers({
    getRoutes: () => cachedRoutes,
    httpEnabled: runtime.httpEnabled,
    httpsEnabled: runtime.httpsEnabled,
    httpPort: runtime.httpPort,
    httpsPort: runtime.httpsPort,
    tls: tlsOptions,
    onError: (message) => console.error(chalk.red(message)),
  });

  let pendingListeners = 0;
  const onListening = () => {
    pendingListeners -= 1;
    if (pendingListeners > 0) return;

    fs.writeFileSync(store.pidPath, String(process.pid), { mode: FILE_MODE });
    writeProxyState(stateDir, {
      pid: process.pid,
      httpPort: runtime.httpPort,
      httpsPort: runtime.httpsPort,
      httpEnabled: runtime.httpEnabled,
      httpsEnabled: runtime.httpsEnabled,
      autoStopWhenIdle: runtime.autoStopWhenIdle,
    });
    fixOwnership(store.pidPath, store.statePath);

    console.log(chalk.green("local-router proxy is listening."));
    if (runtime.httpEnabled) {
      console.log(chalk.gray(`HTTP  -> ${runtime.httpPort}`));
    }
    if (runtime.httpsEnabled) {
      console.log(chalk.gray(`HTTPS -> ${runtime.httpsPort}`));
    }

    scheduleIdleShutdown();
  };

  const registerServerError = (label: string, port: number) => (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(chalk.red(`${label} port ${port} is already in use.`));
    } else if (error.code === "EACCES") {
      console.error(chalk.red(`Permission denied while binding ${label} port ${port}.`));
    } else {
      console.error(chalk.red(`${label} server error: ${error.message}`));
    }

    process.exit(1);
  };

  if (servers.httpServer) {
    pendingListeners += 1;
    servers.httpServer.on("error", registerServerError("HTTP", runtime.httpPort));
    servers.httpServer.listen(runtime.httpPort, onListening);
  }

  if (servers.httpsServer) {
    pendingListeners += 1;
    servers.httpsServer.on("error", registerServerError("HTTPS", runtime.httpsPort));
    servers.httpsServer.listen(runtime.httpsPort, onListening);
  }

  const cleanup = () => {
    if (cleaningUp) return;
    cleaningUp = true;

    if (debounceTimer) clearTimeout(debounceTimer);
    if (poller) clearInterval(poller);
    clearIdleTimer();
    watcher?.close();

    try {
      fs.unlinkSync(store.pidPath);
    } catch {
      // Non-fatal.
    }

    removeProxyState(stateDir);
    syncHostsAcrossStores();

    const closePromises: Promise<void>[] = [];
    if (servers.httpServer) {
      closePromises.push(new Promise((resolve) => servers.httpServer!.close(() => resolve())));
    }
    if (servers.httpsServer) {
      closePromises.push(new Promise((resolve) => servers.httpsServer!.close(() => resolve())));
    }

    Promise.all(closePromises).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), EXIT_TIMEOUT_MS).unref();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

async function ensureProxy(
  runtime: ProxyRuntimeConfig,
  alternativeRuntimes: ProxyRuntimeConfig[] = []
): Promise<EnsuredProxy> {
  const exactMatch = await discoverStateForRuntime(runtime);
  if (exactMatch.state) {
    const store = new RouteStore(exactMatch.dir, { isSystemDir: exactMatch.dir === SYSTEM_STATE_DIR });
    return {
      dir: exactMatch.dir,
      store,
      runtime: exactMatch.state,
      source: "existing",
      wasIdleBeforeRun: store.loadRoutes(true).length === 0,
      autoStopsWhenIdle: exactMatch.state.autoStopWhenIdle === true,
    };
  }

  for (const alternativeRuntime of alternativeRuntimes) {
    const alternativeMatch = await discoverStateForRuntime(alternativeRuntime);
    if (!alternativeMatch.state) continue;

    const store = new RouteStore(alternativeMatch.dir, { isSystemDir: alternativeMatch.dir === SYSTEM_STATE_DIR });
    return {
      dir: alternativeMatch.dir,
      store,
      runtime: alternativeMatch.state,
      source: "existing",
      wasIdleBeforeRun: store.loadRoutes(true).length === 0,
      autoStopsWhenIdle: alternativeMatch.state.autoStopWhenIdle === true,
    };
  }

  const effectiveState = {
    pid: 0,
    ...runtime,
    autoStopWhenIdle: true,
  };

  const stateDir = resolveStateDir(runtime);
  const store = new RouteStore(stateDir, {
    isSystemDir: stateDir === SYSTEM_STATE_DIR,
    onWarning: (message) => console.warn(chalk.yellow(message)),
  });

  const requiresSudo = needsPrivileges(effectiveState);
  if (requiresSudo && (process.getuid?.() ?? -1) !== 0) {
    if (!process.stdin.isTTY) {
      console.error(chalk.red("The proxy is not running and the default ports require sudo."));
      console.error(chalk.cyan(`  ${SUDO_PREFIX}local-router proxy start`));
      process.exit(1);
    }

    const answer = await prompt(chalk.yellow("Proxy not running. Start it with sudo now? [Y/n/skip] "));
    if (answer === "n" || answer === "no") {
      process.exit(0);
    }
    if (answer === "s" || answer === "skip") {
      throw new Error("Skipping the proxy is not supported for this command.");
    }

    const invocation = getSelfInvocation(["proxy", "start"]);
    const childArgs = [...invocation.args, "--auto-stop-when-idle"];
    if (!runtime.httpEnabled) childArgs.push("--no-http");
    if (!runtime.httpsEnabled) childArgs.push("--no-https");
    if (runtime.httpPort !== getDefaultHttpPort()) childArgs.push("--http-port", String(runtime.httpPort));
    if (runtime.httpsPort !== getDefaultHttpsPort()) childArgs.push("--https-port", String(runtime.httpsPort));

    const result = spawnSync("sudo", [invocation.command, ...childArgs], {
      stdio: "inherit",
      timeout: START_TIMEOUT_MS,
    });

    if (result.status !== 0) {
      console.error(chalk.red("Failed to start the proxy with sudo."));
      process.exit(1);
    }
  } else {
    const invocation = getSelfInvocation(["proxy", "start"]);
    const childArgs = [...invocation.args, "--auto-stop-when-idle"];
    if (!runtime.httpEnabled) childArgs.push("--no-http");
    if (!runtime.httpsEnabled) childArgs.push("--no-https");
    if (runtime.httpPort !== getDefaultHttpPort()) childArgs.push("--http-port", String(runtime.httpPort));
    if (runtime.httpsPort !== getDefaultHttpsPort()) childArgs.push("--https-port", String(runtime.httpsPort));

    const result = spawnSync(invocation.command, childArgs, {
      stdio: "inherit",
      timeout: START_TIMEOUT_MS,
    });

    if (result.status !== 0) {
      console.error(chalk.red("Failed to start the proxy."));
      process.exit(1);
    }
  }

  if (!(await waitForProxy(runtime))) {
    console.error(chalk.red("Proxy failed to become ready."));
    process.exit(1);
  }

  return {
    dir: stateDir,
    store,
    runtime,
    source: "started",
    wasIdleBeforeRun: true,
    autoStopsWhenIdle: true,
  };
}

async function handleRun(args: string[]): Promise<void> {
  const parsed = parseRunArgs(args);
  if (parsed.commandArgs.length === 0) {
    console.error(chalk.red("Error: no child command provided."));
    console.error(chalk.cyan("  local-router run next dev"));
    process.exit(1);
  }

  const resolved = resolveProjectHosts({
    explicitName: parsed.name,
    extraDomains: parsed.domains,
  });

  console.log(chalk.blue.bold("\nlocal-router\n"));
  console.log(chalk.gray(`Base hostname: ${resolved.baseHostname}`));
  console.log(chalk.gray(`Name source: ${resolved.nameSource}`));
  if (resolved.configPath) {
    console.log(chalk.gray(`Config: ${resolved.configPath}`));
  }

  const runtimeSelection = resolveRuntimeSelection(resolved.hostnames);
  const commandDisplay = formatCommand(parsed.commandArgs);

  const ensuredProxy = await ensureProxy(runtimeSelection.runtime, runtimeSelection.alternativeRuntimes);
  const { dir, runtime } = ensuredProxy;
  const store = new RouteStore(dir, {
    isSystemDir: dir === SYSTEM_STATE_DIR,
    onWarning: (message) => console.warn(chalk.yellow(message)),
  });

  const cleanupRoutes = () => {
    for (const hostname of resolved.hostnames) {
      try {
        store.removeRoute(hostname);
      } catch {
        // Non-fatal on cleanup.
      }
    }

    try {
      syncHostsAcrossStores();
    } catch {
      // Best effort if hosts cannot be updated here.
    }

    const remainingRoutes = store.loadRoutes(true);
    if (
      ensuredProxy.source === "existing" &&
      ensuredProxy.wasIdleBeforeRun &&
      !ensuredProxy.autoStopsWhenIdle &&
      remainingRoutes.length === 0
    ) {
      tryStopIdleExistingProxy(store, dir, runtime);
    }
  };

  const port = parsed.appPort ?? (await findFreePort());
  console.log(chalk.green(`App port: ${port}`));

  try {
    registerHostnames(store, resolved.hostnames, port, process.pid, parsed.force, {
      appName: resolved.name,
      command: commandDisplay,
    });
  } catch (error) {
    if (error instanceof RouteConflictError) {
      console.error(chalk.red(error.message));
      process.exit(1);
    }

    throw error;
  }

  printUrls(resolved.hostnames, runtime);
  if (ensuredProxy.source === "existing") {
    const behavior = ensuredProxy.autoStopsWhenIdle
      ? "It will stop itself again when no apps remain."
      : "If it was already running before this command, it may remain alive after your app exits.";
    console.log(chalk.gray(`Reusing an existing local-router proxy. ${behavior}\n`));
  }
  if (!hasCustomDomains(resolved.hostnames) && needsPrivileges(runtime)) {
    console.log(chalk.gray("Using the existing privileged proxy because it is already running.\n"));
  } else if (!hasCustomDomains(resolved.hostnames) && !hasExplicitProxyPortOverrides()) {
    console.log(chalk.gray("Using unprivileged localhost-only proxy ports because no custom domains were requested.\n"));
  }

  injectFrameworkFlags(parsed.commandArgs, port);

  const primaryHttpsUrl = formatUrl(resolved.baseHostname, true, runtime.httpsPort);
  const allHttpsUrls = resolved.hostnames
    .map((hostname) => formatUrl(hostname, true, runtime.httpsPort))
    .join(",");
  const allHttpUrls = resolved.hostnames
    .map((hostname) => formatUrl(hostname, false, runtime.httpPort))
    .join(",");

  spawnCommand(parsed.commandArgs, {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      LOCAL_ROUTER_URL: primaryHttpsUrl,
      LOCAL_ROUTER_URLS_HTTPS: allHttpsUrls,
      LOCAL_ROUTER_URLS_HTTP: allHttpUrls,
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".localhost",
    },
    onCleanup: cleanupRoutes,
  });
}

async function handleHosts(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "clean") {
    if (!cleanHostsFile()) {
      console.error(chalk.red(`Failed to update ${HOSTS_DISPLAY}.`));
      process.exit(1);
    }
    console.log(chalk.green(`Removed managed entries from ${HOSTS_DISPLAY}.`));
    return;
  }

  if (subcommand !== "sync") {
    console.log(`
${chalk.bold("Usage:")}
  ${chalk.cyan(`${SUDO_PREFIX}local-router hosts sync`)}
  ${chalk.cyan(`${SUDO_PREFIX}local-router hosts clean`)}
`);
    return;
  }

  const hostnames = loadAllRoutes()
    .map((route) => route.hostname)
    .filter((hostname) => !isLocalhostHostname(hostname));

  if (!syncHostsFile(hostnames)) {
    console.error(chalk.red(`Failed to update ${HOSTS_DISPLAY}.`));
    process.exit(1);
  }

  console.log(chalk.green(`Synced ${hostnames.length} hostnames to ${HOSTS_DISPLAY}.`));
}

async function handleProxy(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "stop") {
    const { dir, state } = await discoverState();
    const runtime: ProxyRuntimeConfig = state ?? {
      httpPort: getDefaultHttpPort(),
      httpsPort: getDefaultHttpsPort(),
      httpEnabled: true,
      httpsEnabled: true,
    };
    const store = new RouteStore(dir, { isSystemDir: dir === SYSTEM_STATE_DIR });
    await stopProxy(store, dir, runtime);
    return;
  }

  if (subcommand !== "start") {
    console.log(`
${chalk.bold("Usage:")}
  ${chalk.cyan("local-router proxy start")}
  ${chalk.cyan("local-router proxy stop")}
`);
    return;
  }

  const options = parseProxyArgs(args.slice(1));
  const stateDir = resolveStateDir(options);
  const store = new RouteStore(stateDir, {
    isSystemDir: stateDir === SYSTEM_STATE_DIR,
    onWarning: (message) => console.warn(chalk.yellow(message)),
  });

  if (!isWindows && needsPrivileges(options) && (process.getuid?.() ?? -1) !== 0) {
    console.error(chalk.red("The selected ports require sudo."));
    console.error(chalk.cyan(`  ${SUDO_PREFIX}local-router proxy start`));
    process.exit(1);
  }

  if (await isProxyRunning(options)) {
    console.log(chalk.yellow("Proxy is already running."));
    return;
  }

  if (options.foreground) {
    console.log(chalk.blue.bold("\nlocal-router proxy\n"));
    startProxyServer(store, options, stateDir);
    return;
  }

  store.ensureDir();
  const logPath = path.join(stateDir, "proxy.log");
  const logFd = fs.openSync(logPath, "a");
  try {
    try {
      fs.chmodSync(logPath, FILE_MODE);
      fs.chmodSync(stateDir, DIR_MODE);
    } catch {
      // Non-fatal.
    }
    fixOwnership(logPath, stateDir);

    const invocation = getSelfInvocation(["proxy", "start", "--foreground"]);
    const daemonArgs = [...invocation.args];
    if (options.autoStopWhenIdle) daemonArgs.push("--auto-stop-when-idle");
    if (!options.httpEnabled) daemonArgs.push("--no-http");
    if (!options.httpsEnabled) daemonArgs.push("--no-https");
    if (options.httpPort !== getDefaultHttpPort()) daemonArgs.push("--http-port", String(options.httpPort));
    if (options.httpsPort !== getDefaultHttpsPort()) daemonArgs.push("--https-port", String(options.httpsPort));

    const child = spawn(invocation.command, daemonArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      windowsHide: true,
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }

  if (!(await waitForProxy(options))) {
    console.error(chalk.red("Proxy failed to start."));
    console.error(chalk.gray(`Logs: ${logPath}`));
    process.exit(1);
  }

  console.log(chalk.green("local-router proxy started."));
}

async function handleList(): Promise<void> {
  const routes = loadAllRoutes();
  printRouteTable(routes);
}

async function handleTrust(): Promise<void> {
  const { dir } = await discoverState();
  const result = trustCA(dir);
  if (!result.trusted) {
    console.error(chalk.red(`Failed to trust the CA: ${result.error ?? "unknown error"}`));
    process.exit(1);
  }

  console.log(chalk.green("Local CA added to the trust store."));
}

async function main(): Promise<void> {
  maybeWarnAboutNodeFallback();

  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(PACKAGE_VERSION);
    return;
  }

  if (command === "run") {
    await handleRun(args.slice(1));
    return;
  }

  if (command === "proxy") {
    await handleProxy(args.slice(1));
    return;
  }

  if (command === "hosts") {
    await handleHosts(args.slice(1));
    return;
  }

  if (command === "list") {
    await handleList();
    return;
  }

  if (command === "trust") {
    await handleTrust();
    return;
  }

  console.error(chalk.red(`Unknown command "${command}".`));
  printHelp();
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(message));
  process.exit(1);
});
