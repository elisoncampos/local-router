import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

const TSX_CLI = path.join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx"
);
const CLI_PATH = path.join(process.cwd(), "src", "cli.ts");

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-router-list-"));
});

describe("local-router list", () => {
  it("prints a grouped table of registered apps", async () => {
    fs.writeFileSync(
      path.join(stateDir, "routes.json"),
      JSON.stringify(
        [
          {
            hostname: "algo.localhost",
            port: 4011,
            pid: process.pid,
            appName: "algo",
            command: "npm run dev",
          },
          {
            hostname: "api.example.com",
            port: 4011,
            pid: process.pid,
            appName: "algo",
            command: "npm run dev",
          },
        ],
        null,
        2
      )
    );

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(TSX_CLI, [CLI_PATH, "list"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LOCAL_ROUTER_STATE_DIR: stateDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf-8");
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        resolve({ code, stdout, stderr });
      });
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("APP");
    expect(result.stdout).toContain("PORT");
    expect(result.stdout).toContain("DOMAINS");
    expect(result.stdout).toContain("CMD");
    expect(result.stdout).toContain("algo");
    expect(result.stdout).toContain("4011");
    expect(result.stdout).toContain("algo.localhost, api.example.com");
    expect(result.stdout).toContain("npm run dev");
  });
});
