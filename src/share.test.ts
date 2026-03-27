import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractLocalhostRunUrl, startSharedTunnel } from "./share.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("share", () => {
  it("extracts a localhost.run URL from ssh output", () => {
    const output = `
channel 3: open failed: administratively prohibited: open failed
demo-share.localhost.run tunneled with tls termination, https://demo-share.localhost.run
`;

    expect(extractLocalhostRunUrl(output)).toBe("https://demo-share.localhost.run");
  });

  it("ignores localhost.run docs links and waits for the real tunnel hostname", () => {
    const output = `
Welcome to localhost.run!
https://localhost.run/docs/
https://localhost.run/docs/custom-domains
demo-share.localhost.run tunneled with tls termination, https://demo-share.localhost.run
`;

    expect(extractLocalhostRunUrl(output)).toBe("https://demo-share.localhost.run");
  });

  it("extracts a URL from localhost.run JSON output", () => {
    const output = `
{"connection_id":"abc","event":"authn","message":"authenticated as anonymous user"}
{"connection_id":"abc","event":"tcpip-forward","message":"demo-share.localhost.run tunneled with tls termination, https://demo-share.localhost.run","address":"demo-share.localhost.run","listen_host":"demo-share.localhost.run","status":"success"}
`;

    expect(extractLocalhostRunUrl(output)).toBe("https://demo-share.localhost.run");
  });

  it("extracts an lhr.life URL from ssh output", () => {
    const output = "0b20df995bc7ac.lhr.life tunneled with tls termination";

    expect(extractLocalhostRunUrl(output)).toBe("https://0b20df995bc7ac.lhr.life");
  });

  it("does not accept the localhost.run root domain as a tunnel URL", () => {
    const output = `
To explore using localhost.run visit:
https://localhost.run/docs/
`;

    expect(extractLocalhostRunUrl(output)).toBeUndefined();
  });

  it(
    "starts a localhost.run tunnel process and returns the public hostname",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-router-share-test-"));
      tempDirs.push(tempDir);

      const mockSshPath = path.join(tempDir, "mock-ssh.cjs");
      fs.writeFileSync(
        mockSshPath,
        `
          process.stdout.write("demo-share.localhost.run tunneled with tls termination, https://demo-share.localhost.run\\n");
          process.on("SIGTERM", () => process.exit(0));
          setInterval(() => {}, 1000);
        `
      );

      const tunnel = await startSharedTunnel({
        targetPort: 18080,
        binary: process.execPath,
        binaryArgs: [mockSshPath],
      });

      expect(tunnel.publicUrl).toBe("https://demo-share.localhost.run");
      expect(tunnel.publicHostname).toBe("demo-share.localhost.run");

      await tunnel.stop();
    },
    15_000
  );
});
