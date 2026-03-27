import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RouteConflictError, RouteStore } from "./routes.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-router-routes-"));
});

describe("RouteStore", () => {
  it("persists and loads routes", () => {
    const store = new RouteStore(tempDir);
    store.addRoute("algo.localhost", 4011, process.pid, false, {
      appName: "algo",
      command: "npm run dev",
      cwd: "/tmp/algo",
      syncToHosts: false,
    });

    expect(store.loadRoutes()).toEqual([
      {
        hostname: "algo.localhost",
        port: 4011,
        pid: process.pid,
        appName: "algo",
        command: "npm run dev",
        cwd: "/tmp/algo",
        syncToHosts: false,
      },
    ]);
  });

  it("rejects conflicts for another live process", () => {
    const store = new RouteStore(tempDir);
    store.addRoute("algo.localhost", 4011, process.pid);

    expect(() => store.addRoute("algo.localhost", 4012, process.pid + 999_999)).toThrow(
      RouteConflictError
    );
  });
});
