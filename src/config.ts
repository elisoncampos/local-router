import * as fs from "node:fs";
import * as path from "node:path";
import JSON5 from "json5";
import { inferProjectName, sanitizeForHostname } from "./auto.js";
import type { LocalRouterConfig, ResolvedProjectHosts } from "./types.js";
import { normalizeExplicitHostname } from "./utils.js";

const CONFIG_FILENAMES = [".local-router", ".local-router.json", "local-router.config.json"];

export interface LoadedConfig {
  config: LocalRouterConfig;
  path: string;
}

export function findLocalRouterConfig(cwd: string = process.cwd()): string | null {
  let dir = cwd;

  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = path.join(dir, filename);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export function loadLocalRouterConfig(cwd: string = process.cwd()): LoadedConfig | null {
  const configPath = findLocalRouterConfig(cwd);
  if (!configPath) return null;

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON5.parse(raw) as LocalRouterConfig;

  if (parsed && typeof parsed === "object") {
    if (parsed.name !== undefined && typeof parsed.name !== "string") {
      throw new Error(`Invalid "name" in ${configPath}: expected a string.`);
    }

    if (parsed.hosts !== undefined) {
      if (!Array.isArray(parsed.hosts) || parsed.hosts.some((item) => typeof item !== "string")) {
        throw new Error(`Invalid "hosts" in ${configPath}: expected an array of strings.`);
      }
    }
  } else {
    throw new Error(`Invalid ${configPath}: expected an object.`);
  }

  return { config: parsed, path: configPath };
}

function buildLocalhostName(name: string): string {
  const sanitized = sanitizeForHostname(name);
  if (!sanitized) {
    throw new Error(`Invalid project name "${name}".`);
  }

  return `${sanitized}.localhost`;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function resolveProjectHosts(options?: {
  cwd?: string;
  explicitName?: string;
  extraDomains?: string[];
}): ResolvedProjectHosts {
  const cwd = options?.cwd ?? process.cwd();
  const loadedConfig = loadLocalRouterConfig(cwd);
  const inferred = inferProjectName(cwd);

  let effectiveName: string;
  let nameSource: string;

  if (options?.explicitName) {
    effectiveName = options.explicitName;
    nameSource = "--name";
  } else if (loadedConfig?.config.name) {
    effectiveName = loadedConfig.config.name;
    nameSource = loadedConfig.path;
  } else {
    effectiveName = inferred.name;
    nameSource = inferred.source;
  }

  const baseHostname = buildLocalhostName(effectiveName);
  const configHosts = loadedConfig?.config.hosts ?? [];
  const cliHosts = options?.extraDomains ?? [];

  const hostnames = dedupe([
    baseHostname,
    ...configHosts.map((host) => normalizeExplicitHostname(host)),
    ...cliHosts.map((host) => normalizeExplicitHostname(host)),
  ]);

  return {
    name: sanitizeForHostname(effectiveName),
    baseHostname,
    hostnames,
    configPath: loadedConfig?.path,
    nameSource,
  };
}
