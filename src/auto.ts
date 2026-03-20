import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_DNS_LABEL_LENGTH = 63;

function truncateLabel(label: string): string {
  if (label.length <= MAX_DNS_LABEL_LENGTH) return label;

  const hash = createHash("sha256").update(label).digest("hex").slice(0, 6);
  const maxPrefixLength = MAX_DNS_LABEL_LENGTH - 7;
  const prefix = label.slice(0, maxPrefixLength).replace(/-+$/, "");
  return `${prefix}-${hash}`;
}

export function sanitizeForHostname(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return truncateLabel(sanitized);
}

function findPackageJsonName(startDir: string): string | null {
  let dir = startDir;

  for (;;) {
    const packageJsonPath = path.join(dir, "package.json");

    try {
      const raw = fs.readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(raw) as { name?: string };
      if (typeof pkg.name === "string" && pkg.name) {
        return pkg.name.replace(/^@[^/]+\//, "");
      }
    } catch {
      // Keep walking.
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function findGitRoot(startDir: string): string | null {
  try {
    const output = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (output) return output;
  } catch {
    // Fall through to filesystem lookup.
  }

  let dir = startDir;
  for (;;) {
    const gitPath = path.join(dir, ".git");
    try {
      const stats = fs.statSync(gitPath);
      if (stats.isDirectory() || stats.isFile()) {
        return dir;
      }
    } catch {
      // Keep walking.
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export interface InferredProjectName {
  name: string;
  source: string;
}

export function inferProjectName(cwd: string = process.cwd()): InferredProjectName {
  const packageName = findPackageJsonName(cwd);
  if (packageName) {
    const sanitized = sanitizeForHostname(packageName);
    if (sanitized) {
      return { name: sanitized, source: "package.json" };
    }
  }

  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    const sanitized = sanitizeForHostname(path.basename(gitRoot));
    if (sanitized) {
      return { name: sanitized, source: "git root" };
    }
  }

  const directoryName = sanitizeForHostname(path.basename(cwd));
  if (directoryName) {
    return { name: directoryName, source: "directory name" };
  }

  throw new Error("Could not infer a project name from package.json, git root, or directory name.");
}
