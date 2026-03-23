import * as fs from "node:fs";

export function fixOwnership(...paths: string[]): void {
  if (process.platform === "win32") return;
  const uid = process.env.SUDO_UID;
  const gid = process.env.SUDO_GID;
  if (!uid || process.getuid?.() !== 0) return;

  for (const targetPath of paths) {
    try {
      fs.chownSync(targetPath, Number(uid), Number(gid ?? uid));
    } catch {
      // Best effort.
    }
  }
}

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatUrl(hostname: string, https: boolean, port?: number): string {
  const defaultPort = https ? 443 : 80;
  if (!port || port === defaultPort) {
    return `${https ? "https" : "http"}://${hostname}`;
  }

  return `${https ? "https" : "http"}://${hostname}:${port}`;
}

export function removeProtocol(hostname: string): string {
  return hostname.replace(/^https?:\/\//i, "").split("/")[0].trim();
}

function trimTrailingDots(hostname: string): string {
  return hostname.replace(/\.+$/, "");
}

export function normalizeExplicitHostname(hostname: string): string {
  const normalized = trimTrailingDots(removeProtocol(hostname).toLowerCase());

  if (!normalized) {
    throw new Error("Hostname cannot be empty.");
  }

  if (normalized.includes("..")) {
    throw new Error(`Invalid hostname "${normalized}": consecutive dots are not allowed.`);
  }

  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(normalized)) {
    throw new Error(
      `Invalid hostname "${normalized}": use lowercase letters, digits, dots, and hyphens only.`
    );
  }

  const labels = normalized.split(".");
  for (const label of labels) {
    if (label.length > 63) {
      throw new Error(
        `Invalid hostname "${normalized}": label "${label}" exceeds the 63-character DNS limit.`
      );
    }
  }

  return normalized;
}

export function normalizeRequestHostname(hostname: string): string {
  const authority = removeProtocol(hostname);
  if (!authority) return "";

  if (authority.startsWith("[")) {
    const closingBracketIndex = authority.indexOf("]");
    const bracketedHost =
      closingBracketIndex === -1 ? authority.slice(1) : authority.slice(1, closingBracketIndex);
    return trimTrailingDots(bracketedHost.toLowerCase());
  }

  const lastColonIndex = authority.lastIndexOf(":");
  const withoutPort =
    lastColonIndex === -1 || authority.includes(":", lastColonIndex + 1)
      ? authority
      : authority.slice(0, lastColonIndex);

  return trimTrailingDots(withoutPort.toLowerCase());
}
