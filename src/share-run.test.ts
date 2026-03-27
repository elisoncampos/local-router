import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const TSX_CLI = path.join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx"
);
const CLI_PATH = path.join(process.cwd(), "src", "cli.ts");
const SHARED_TUNNEL_HOSTNAME = "demo-share.localhost.run";
const SHARED_TUNNEL_URL = `https://${SHARED_TUNNEL_HOSTNAME}`;

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a free port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitFor(
  callback: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<void> {
  const start = Date.now();

  for (;;) {
    if (await callback()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function request(hostname: string, port: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "GET",
        headers: {
          host: hostname,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(body));
      }
    );

    req.on("error", reject);
    req.end();
  });
}

function createMockSshBinary(dir: string): string {
  const scriptPath = path.join(dir, "mock-ssh.cjs");
  fs.writeFileSync(
    scriptPath,
    `
      process.stdout.write("${SHARED_TUNNEL_HOSTNAME} tunneled with tls termination, ${SHARED_TUNNEL_URL}\\n");
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1000);
    `
  );

  if (process.platform === "win32") {
    const wrapperPath = path.join(dir, "mock-ssh.cmd");
    fs.writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return wrapperPath;
  }

  const wrapperPath = path.join(dir, "mock-ssh");
  fs.writeFileSync(
    wrapperPath,
    `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`
  );
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

let fixtureDir: string;
let appDir: string;
let stateDir: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-router-share-run-"));
  appDir = path.join(fixtureDir, "app");
  stateDir = path.join(fixtureDir, "state");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "share-app" }));
  fs.writeFileSync(
    path.join(appDir, "server.cjs"),
    'const http = require("node:http"); const port = Number(process.env.PORT || 3000); http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"}); res.end(JSON.stringify({ host: req.headers.host ?? null }));}).listen(port,"127.0.0.1");\n'
  );
});

afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
});

describe("local-router run --share", () => {
  it(
    "registers the localhost.run hostname without syncing it to hosts",
    async () => {
      const mockSsh = createMockSshBinary(fixtureDir);
      const httpPort = await getFreePort();
      const httpsPort = await getFreePort();

      child = spawn(TSX_CLI, [CLI_PATH, "run", "node", "server.cjs", "--share"], {
        cwd: appDir,
        env: {
          ...process.env,
          LOCAL_ROUTER_STATE_DIR: stateDir,
          LOCAL_ROUTER_HTTP_PORT: String(httpPort),
          LOCAL_ROUTER_HTTPS_PORT: String(httpsPort),
          LOCAL_ROUTER_SSH_BIN: mockSsh,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf-8");
      });

      await waitFor(async () => {
        try {
          return (
            await request(SHARED_TUNNEL_HOSTNAME, httpPort)
          ) === JSON.stringify({ host: "share-app.localhost" });
        } catch {
          return false;
        }
      }, 25_000);

      const routes = JSON.parse(fs.readFileSync(path.join(stateDir, "routes.json"), "utf-8")) as Array<{
        hostname: string;
        syncToHosts?: boolean;
      }>;
      const sharedRoute = routes.find((route) => route.hostname === SHARED_TUNNEL_HOSTNAME);

      expect(sharedRoute).toMatchObject({
        hostname: SHARED_TUNNEL_HOSTNAME,
        syncToHosts: false,
        upstreamHost: "share-app.localhost",
      });
      expect(stdout).toContain(SHARED_TUNNEL_URL);

      child.kill("SIGINT");
      await waitFor(() => child!.exitCode !== null || child!.signalCode !== null, 10_000);
      await waitFor(() => !fs.existsSync(path.join(stateDir, "proxy-state.json")), 15_000);
    },
    45_000
  );
});
