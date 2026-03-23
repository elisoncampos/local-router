import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

describe("launcher", () => {
  it("falls back to a working node when the first node in PATH is broken", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-router-launcher-"));
    const fakeBinDir = path.join(tempDir, "bin");
    fs.mkdirSync(fakeBinDir, { recursive: true });

    const fakeNodePath = path.join(fakeBinDir, "node");
    fs.writeFileSync(
      fakeNodePath,
      '#!/bin/sh\necho "asdf: No version is set for command node" >&2\nexit 126\n'
    );
    fs.chmodSync(fakeNodePath, 0o755);

    const launcherPath = path.join(process.cwd(), "bin", "local-router");

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(launcherPath, ["--version"], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
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
      }
    );

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
    expect(result.stderr).toContain("Falling back to");
  });
});
