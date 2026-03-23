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

let fixtureDir: string;
let appDir: string;
let stateDir: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-router-lifecycle-test-"));
  appDir = path.join(fixtureDir, "app");
  stateDir = path.join(fixtureDir, "state");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "lifecycle-app" }));
  fs.writeFileSync(
    path.join(appDir, ".local-router"),
    `{ name: "demo", hosts: ["app.example.com"] }`
  );
  fs.writeFileSync(
    path.join(appDir, "server.cjs"),
    'const http = require("node:http"); const port = Number(process.env.PORT || 3000); http.createServer((_req,res)=>{res.writeHead(200,{"content-type":"text/plain"}); res.end("ok");}).listen(port,"127.0.0.1");\n'
  );
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
});

describe("local-router lifecycle", () => {
  it(
    "stops the auto-started proxy after the run process exits",
    async () => {
      const httpPort = await getFreePort();
      const httpsPort = await getFreePort();

      child = spawn(TSX_CLI, [CLI_PATH, "run", "node", "server.cjs"], {
        cwd: appDir,
        env: {
          ...process.env,
          LOCAL_ROUTER_STATE_DIR: stateDir,
          LOCAL_ROUTER_HTTP_PORT: String(httpPort),
          LOCAL_ROUTER_HTTPS_PORT: String(httpsPort),
        },
        stdio: "ignore",
      });

      await waitFor(async () => {
        try {
          return (await request("demo.localhost", httpPort)) === "ok";
        } catch {
          return false;
        }
      }, 25_000);

      expect(fs.existsSync(path.join(stateDir, "proxy-state.json"))).toBe(true);

      child.kill("SIGINT");
      await waitFor(() => child!.exitCode !== null || child!.signalCode !== null, 5_000);

      await waitFor(() => !fs.existsSync(path.join(stateDir, "proxy-state.json")), 15_000);

      await expect(request("demo.localhost", httpPort)).rejects.toThrow();

      const routesPath = path.join(stateDir, "routes.json");
      expect(fs.existsSync(routesPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(routesPath, "utf-8"))).toEqual([]);
    },
    40_000
  );
});
