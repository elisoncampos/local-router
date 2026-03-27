import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SharedTunnel } from "./types.js";

const TUNNEL_TIMEOUT_MS = 30_000;
const TUNNEL_KILL_TIMEOUT_MS = 5_000;
const LOCALHOST_RUN_HOST_PATTERN = /\b(?:[a-z0-9-]+\.)+(?:localhost\.run|lhr\.life)\b/gi;
const HTTPS_URL_PATTERN = /https:\/\/[a-z0-9.-]+\b/gi;

interface StartSharedTunnelOptions {
  targetPort: number;
  binary?: string;
  binaryArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

function formatTunnelError(message: string): Error {
  return new Error(`Failed to start a localhost.run tunnel: ${message}`);
}

function extractTunnelUrlFromJsonLines(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;

    try {
      const parsed = JSON.parse(trimmed) as { address?: unknown; listen_host?: unknown; message?: unknown };
      if (typeof parsed.address === "string" && LOCALHOST_RUN_HOST_PATTERN.test(parsed.address)) {
        return `https://${parsed.address}`;
      }
      LOCALHOST_RUN_HOST_PATTERN.lastIndex = 0;

      if (typeof parsed.listen_host === "string" && LOCALHOST_RUN_HOST_PATTERN.test(parsed.listen_host)) {
        return `https://${parsed.listen_host}`;
      }
      LOCALHOST_RUN_HOST_PATTERN.lastIndex = 0;

      if (typeof parsed.message === "string") {
        const fromMessage = extractLocalhostRunUrl(parsed.message);
        if (fromMessage) return fromMessage;
      }
    } catch {
      // Ignore non-JSON lines in mixed output mode.
    }
  }

  return undefined;
}

export function extractLocalhostRunUrl(output: string): string | undefined {
  const jsonUrl = extractTunnelUrlFromJsonLines(output);
  if (jsonUrl) return jsonUrl;

  const explicitUrls = output.match(HTTPS_URL_PATTERN);
  if (explicitUrls && explicitUrls.length > 0) {
    return explicitUrls.at(-1);
  }

  const hostnames = output.match(LOCALHOST_RUN_HOST_PATTERN);
  if (!hostnames || hostnames.length === 0) {
    return undefined;
  }

  return `https://${hostnames.at(-1)}`;
}

export async function startSharedTunnel(options: StartSharedTunnelOptions): Promise<SharedTunnel> {
  const binary = options.binary ?? process.env.LOCAL_ROUTER_SSH_BIN ?? "ssh";
  const args = [
    ...(options.binaryArgs ?? []),
    "-T",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=60",
    "-R",
    `80:127.0.0.1:${options.targetPort}`,
    "nokey@localhost.run",
    "--",
    "--output",
    "json",
  ];

  return await new Promise<SharedTunnel>((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    child.stdin.end();

    let settled = false;
    let stopping = false;
    let output = "";

    const exitPromise = new Promise<void>((resolveExit) => {
      child.once("exit", () => resolveExit());
    });

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      reject(error);
    };

    const finishResolve = (tunnel: SharedTunnel) => {
      if (settled) return;
      settled = true;
      resolve(tunnel);
    };

    const timeout = setTimeout(() => {
      finishReject(
        formatTunnelError("timed out while waiting for localhost.run to print the public URL.")
      );
    }, TUNNEL_TIMEOUT_MS);
    timeout.unref();

    const stop = async (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) {
        await exitPromise;
        return;
      }

      stopping = true;
      child.kill("SIGTERM");

      const forcedKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, TUNNEL_KILL_TIMEOUT_MS);
      forcedKillTimer.unref();

      await exitPromise;
      clearTimeout(forcedKillTimer);
    };

    const maybeResolveFromOutput = (chunk: string) => {
      output += chunk;
      const publicUrl = extractLocalhostRunUrl(output);
      if (!publicUrl) return;

      clearTimeout(timeout);

      try {
        const publicHostname = new URL(publicUrl).hostname;
        finishResolve({
          publicUrl,
          publicHostname,
          stop,
        });
      } catch {
        finishReject(formatTunnelError(`localhost.run returned an invalid URL: ${publicUrl}`));
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      maybeResolveFromOutput(chunk.toString("utf-8"));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      maybeResolveFromOutput(chunk.toString("utf-8"));
    });

    child.on("error", (error: Error) => {
      clearTimeout(timeout);
      const maybeErrno = error as NodeJS.ErrnoException;
      if (maybeErrno.code === "ENOENT") {
        finishReject(formatTunnelError("ssh was not found in PATH. Install OpenSSH to use --share."));
        return;
      }

      finishReject(formatTunnelError(error.message));
    });

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      if (settled || stopping) return;

      const lastOutput = output
        .trim()
        .split(/\r?\n/)
        .slice(-3)
        .join(" ");
      const reason =
        lastOutput ||
        `ssh exited before reporting a public URL (code ${code ?? "null"}, signal ${signal ?? "null"}).`;
      finishReject(formatTunnelError(reason));
    });
  });
}
