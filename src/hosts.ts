import * as dns from "node:dns";
import * as fs from "node:fs";
import * as path from "node:path";

const isWindows = process.platform === "win32";

const HOSTS_PATH = isWindows
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts")
  : "/etc/hosts";

const MARKER_START = "# local-router-start";
const MARKER_END = "# local-router-end";

function readHostsFile(): string {
  try {
    return fs.readFileSync(HOSTS_PATH, "utf-8");
  } catch {
    return "";
  }
}

function removeManagedBlock(content: string): string {
  const startIndex = content.indexOf(MARKER_START);
  const endIndex = content.indexOf(MARKER_END);

  if (startIndex === -1 || endIndex === -1) return content;

  const before = content.slice(0, startIndex);
  const after = content.slice(endIndex + MARKER_END.length);
  return (before + after).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function buildManagedBlock(hostnames: string[]): string {
  if (hostnames.length === 0) return "";

  const ipv4Entries = hostnames.map((hostname) => `127.0.0.1 ${hostname}`).join("\n");
  const ipv6Entries = hostnames.map((hostname) => `::1 ${hostname}`).join("\n");

  return `${MARKER_START}\n${ipv4Entries}\n${ipv6Entries}\n${MARKER_END}`;
}

export function syncHostsFile(hostnames: string[]): boolean {
  try {
    const uniqueHostnames = Array.from(new Set(hostnames)).sort();
    const current = readHostsFile();
    const cleaned = removeManagedBlock(current);

    if (uniqueHostnames.length === 0) {
      fs.writeFileSync(HOSTS_PATH, cleaned);
      return true;
    }

    const managedBlock = buildManagedBlock(uniqueHostnames);
    fs.writeFileSync(HOSTS_PATH, `${cleaned.trimEnd()}\n\n${managedBlock}\n`);
    return true;
  } catch {
    return false;
  }
}

export function cleanHostsFile(): boolean {
  try {
    const content = readHostsFile();
    if (!content.includes(MARKER_START)) return true;
    fs.writeFileSync(HOSTS_PATH, removeManagedBlock(content));
    return true;
  } catch {
    return false;
  }
}

export function checkHostResolution(hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true }, (error, addresses) => {
      if (error) {
        resolve(false);
        return;
      }

      resolve(addresses.some((entry) => entry.address === "127.0.0.1" || entry.address === "::1"));
    });
  });
}
