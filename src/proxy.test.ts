import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureCerts, createSNICallback } from "./certs.js";
import { createProxyServers } from "./proxy.js";

let appServer: http.Server;
let appPort = 0;
let tempDir: string;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-router-proxy-"));
  appServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ host: req.headers.host ?? null }));
  });

  await new Promise<void>((resolve) => {
    appServer.listen(0, "127.0.0.1", () => {
      appPort = (appServer.address() as { port: number }).port;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
});

describe("proxy servers", () => {
  it("proxies HTTP and HTTPS requests to the registered app", async () => {
    const certs = ensureCerts(tempDir);
    const bundle = createProxyServers({
      getRoutes: () => [{ hostname: "algo.localhost", port: appPort }],
      httpEnabled: true,
      httpsEnabled: true,
      httpPort: 18080,
      httpsPort: 18443,
      tls: {
        cert: fs.readFileSync(certs.certPath),
        key: fs.readFileSync(certs.keyPath),
        SNICallback: createSNICallback(
          tempDir,
          fs.readFileSync(certs.certPath),
          fs.readFileSync(certs.keyPath)
        ),
      },
    });

    await new Promise<void>((resolve) => bundle.httpServer!.listen(0, "127.0.0.1", () => resolve()));
    await new Promise<void>((resolve) => bundle.httpsServer!.listen(0, "127.0.0.1", () => resolve()));

    const httpPort = (bundle.httpServer!.address() as { port: number }).port;
    const httpsPort = (bundle.httpsServer!.address() as { port: number }).port;

    const httpBody = await new Promise<string>((resolve, reject) => {
      http.get(
        {
          hostname: "127.0.0.1",
          port: httpPort,
          path: "/",
          headers: { host: "algo.localhost" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk.toString("utf-8");
          });
          res.on("end", () => resolve(body));
        }
      ).on("error", reject);
    });

    const httpsBody = await new Promise<string>((resolve, reject) => {
      https.get(
        {
          hostname: "127.0.0.1",
          port: httpsPort,
          path: "/",
          headers: { host: "algo.localhost" },
          servername: "algo.localhost",
          rejectUnauthorized: false,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk.toString("utf-8");
          });
          res.on("end", () => resolve(body));
        }
      ).on("error", reject);
    });

    expect(httpBody).toBe(JSON.stringify({ host: "algo.localhost" }));
    expect(httpsBody).toBe(JSON.stringify({ host: "algo.localhost" }));

    await new Promise<void>((resolve) => bundle.httpServer!.close(() => resolve()));
    await new Promise<void>((resolve) => bundle.httpsServer!.close(() => resolve()));
  });

  it("matches routes case-insensitively and ignores a trailing dot", async () => {
    const certs = ensureCerts(tempDir);
    const bundle = createProxyServers({
      getRoutes: () => [{ hostname: "www.rafaelbigarelli.com.br", port: appPort }],
      httpEnabled: true,
      httpsEnabled: true,
      httpPort: 18080,
      httpsPort: 18443,
      tls: {
        cert: fs.readFileSync(certs.certPath),
        key: fs.readFileSync(certs.keyPath),
        SNICallback: createSNICallback(
          tempDir,
          fs.readFileSync(certs.certPath),
          fs.readFileSync(certs.keyPath)
        ),
      },
    });

    await new Promise<void>((resolve) => bundle.httpServer!.listen(0, "127.0.0.1", () => resolve()));
    await new Promise<void>((resolve) => bundle.httpsServer!.listen(0, "127.0.0.1", () => resolve()));

    const httpPort = (bundle.httpServer!.address() as { port: number }).port;
    const httpsPort = (bundle.httpsServer!.address() as { port: number }).port;

    const httpBody = await new Promise<string>((resolve, reject) => {
      http.get(
        {
          hostname: "127.0.0.1",
          port: httpPort,
          path: "/",
          headers: { host: "WWW.RAFAELBIGARELLI.COM.BR" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk.toString("utf-8");
          });
          res.on("end", () => resolve(body));
        }
      ).on("error", reject);
    });

    const httpsBody = await new Promise<string>((resolve, reject) => {
      https.get(
        {
          hostname: "127.0.0.1",
          port: httpsPort,
          path: "/",
          headers: { host: "WWW.RAFAELBIGARELLI.COM.BR." },
          servername: "WWW.RAFAELBIGARELLI.COM.BR.",
          rejectUnauthorized: false,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk.toString("utf-8");
          });
          res.on("end", () => resolve(body));
        }
      ).on("error", reject);
    });

    expect(httpBody).toBe(JSON.stringify({ host: "WWW.RAFAELBIGARELLI.COM.BR" }));
    expect(httpsBody).toBe(JSON.stringify({ host: "WWW.RAFAELBIGARELLI.COM.BR." }));

    await new Promise<void>((resolve) => bundle.httpServer!.close(() => resolve()));
    await new Promise<void>((resolve) => bundle.httpsServer!.close(() => resolve()));
  });

  it("forwards the configured upstream host when a route overrides it", async () => {
    const bundle = createProxyServers({
      getRoutes: () => [
        {
          hostname: "demo-share.localhost.run",
          port: appPort,
          upstreamHost: "algo.localhost",
        },
      ],
      httpEnabled: true,
      httpsEnabled: false,
      httpPort: 18080,
      httpsPort: 18443,
    });

    await new Promise<void>((resolve) => bundle.httpServer!.listen(0, "127.0.0.1", () => resolve()));

    const httpPort = (bundle.httpServer!.address() as { port: number }).port;

    const httpBody = await new Promise<string>((resolve, reject) => {
      http.get(
        {
          hostname: "127.0.0.1",
          port: httpPort,
          path: "/",
          headers: { host: "demo-share.localhost.run" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk.toString("utf-8");
          });
          res.on("end", () => resolve(body));
        }
      ).on("error", reject);
    });

    expect(httpBody).toBe(JSON.stringify({ host: "algo.localhost" }));

    await new Promise<void>((resolve) => bundle.httpServer!.close(() => resolve()));
  });
});
