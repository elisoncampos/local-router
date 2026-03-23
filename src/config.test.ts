import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findLocalRouterConfig, loadLocalRouterConfig, resolveProjectHosts } from "./config.js";

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-router-config-"));
});

describe("config discovery", () => {
  it("finds a .local-router file in parent directories", () => {
    const root = path.join(fixtureDir, "app");
    const child = path.join(root, "src", "pages");
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(path.join(root, ".local-router"), `{ name: "algo" }`);

    expect(findLocalRouterConfig(child)).toBe(path.join(root, ".local-router"));
  });

  it("ignores a .local-router directory and keeps searching", () => {
    const root = path.join(fixtureDir, "app");
    const child = path.join(root, "src");
    fs.mkdirSync(path.join(child, ".local-router"), { recursive: true });
    fs.writeFileSync(path.join(root, ".local-router.json"), `{ name: "algo" }`);

    expect(findLocalRouterConfig(child)).toBe(path.join(root, ".local-router.json"));
  });

  it("loads JSON5 config", () => {
    fs.writeFileSync(
      path.join(fixtureDir, ".local-router"),
      `{
        name: "algo",
        hosts: ["rapha.com.br", "bozo.com.br"]
      }`
    );

    const loaded = loadLocalRouterConfig(fixtureDir);
    expect(loaded?.config).toEqual({
      name: "algo",
      hosts: ["rapha.com.br", "bozo.com.br"],
    });
  });

  it("resolves base localhost and extra hosts", () => {
    fs.writeFileSync(path.join(fixtureDir, "package.json"), JSON.stringify({ name: "my-app" }));
    fs.writeFileSync(
      path.join(fixtureDir, ".local-router"),
      `{
        hosts: ["rapha.com.br"]
      }`
    );

    const resolved = resolveProjectHosts({
      cwd: fixtureDir,
      extraDomains: ["bozo.com.br"],
    });

    expect(resolved.baseHostname).toBe("my-app.localhost");
    expect(resolved.hostnames).toEqual(["my-app.localhost", "rapha.com.br", "bozo.com.br"]);
  });
});
