import * as http from "node:http";
import * as http2 from "node:http2";
import * as net from "node:net";
import type { ProxyTlsOptions, RouteInfo } from "./types.js";
import { escapeHtml, formatUrl, normalizeRequestHostname } from "./utils.js";
import { getHealthHeader } from "./state.js";

function getRequestAuthority(req: http.IncomingMessage): string {
  const authority = req.headers[":authority"];
  if (typeof authority === "string" && authority) return authority;
  if (Array.isArray(req.headers.host)) {
    return req.headers.host[0] ?? "";
  }
  return req.headers.host ?? "";
}

function getRequestHost(req: http.IncomingMessage): string {
  return normalizeRequestHostname(getRequestAuthority(req));
}

function getAuthorityPort(authority: string): string | undefined {
  if (!authority) return undefined;

  if (authority.startsWith("[")) {
    const closingBracketIndex = authority.indexOf("]");
    if (closingBracketIndex !== -1 && authority[closingBracketIndex + 1] === ":") {
      return authority.slice(closingBracketIndex + 2);
    }
    return undefined;
  }

  const lastColonIndex = authority.lastIndexOf(":");
  if (lastColonIndex === -1) return undefined;
  return authority.slice(lastColonIndex + 1);
}

function buildForwardedHeaders(
  req: http.IncomingMessage,
  authority: string,
  tls: boolean
): Record<string, string> {
  const remoteAddress = req.socket.remoteAddress || "127.0.0.1";

  return {
    "x-forwarded-for": req.headers["x-forwarded-for"]
      ? `${req.headers["x-forwarded-for"]}, ${remoteAddress}`
      : remoteAddress,
    "x-forwarded-proto": (req.headers["x-forwarded-proto"] as string) || (tls ? "https" : "http"),
    "x-forwarded-host": (req.headers["x-forwarded-host"] as string) || authority,
    "x-forwarded-port":
      (req.headers["x-forwarded-port"] as string) || getAuthorityPort(authority) || (tls ? "443" : "80"),
  };
}

function findRoute(routes: RouteInfo[], host: string): RouteInfo | undefined {
  return routes.find((route) => route.hostname === host);
}

export interface ProxyServerBundle {
  httpServer?: http.Server;
  httpsServer?: http2.Http2SecureServer;
}

function createNotFoundResponse(
  host: string,
  routes: RouteInfo[],
  https: boolean,
  port: number
): string {
  const links = routes
    .map(
      (route) =>
        `<li><a href="${escapeHtml(formatUrl(route.hostname, https, port))}">${escapeHtml(route.hostname)}</a></li>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Route not found</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; line-height: 1.5; }
      h1 { margin: 0 0 12px; }
      code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <h1>No route for <code>${escapeHtml(host)}</code></h1>
    <p>Start an app with <code>local-router run ...</code> or check the configured hostnames.</p>
    ${links ? `<ul>${links}</ul>` : "<p>No apps are currently registered.</p>"}
  </body>
</html>`;
}

export function createProxyServers(options: {
  getRoutes: () => RouteInfo[];
  httpEnabled: boolean;
  httpsEnabled: boolean;
  httpPort: number;
  httpsPort: number;
  tls?: ProxyTlsOptions;
  onError?: (message: string) => void;
}): ProxyServerBundle {
  const onError = options.onError ?? ((message: string) => console.error(message));

  const handleRequest = (httpsRequest: boolean) => (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader(getHealthHeader(), "1");

    if (req.method === "HEAD" && req.url === "/__local_router/health") {
      res.writeHead(200);
      res.end();
      return;
    }

    const authority = getRequestAuthority(req);
    const host = normalizeRequestHostname(authority);
    if (!host) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Missing Host header.");
      return;
    }

    const route = findRoute(options.getRoutes(), host);
    if (!route) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      res.end(
        createNotFoundResponse(
          host,
          options.getRoutes(),
          httpsRequest,
          httpsRequest ? options.httpsPort : options.httpPort
        )
      );
      return;
    }

    const headers: http.OutgoingHttpHeaders = { ...req.headers, ...buildForwardedHeaders(req, authority, httpsRequest) };
    headers.host = authority;
    for (const key of Object.keys(headers)) {
      if (key.startsWith(":")) {
        delete headers[key];
      }
    }

    const proxyRequest = http.request(
      {
        hostname: "127.0.0.1",
        port: route.port,
        path: req.url,
        method: req.method,
        headers,
      },
      (proxyResponse) => {
        const responseHeaders: http.OutgoingHttpHeaders = { ...proxyResponse.headers };
        if (httpsRequest) {
          delete responseHeaders.connection;
          delete responseHeaders["keep-alive"];
          delete responseHeaders["proxy-connection"];
          delete responseHeaders["transfer-encoding"];
          delete responseHeaders.upgrade;
        }

        res.writeHead(proxyResponse.statusCode || 502, responseHeaders);
        proxyResponse.on("error", () => {
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "text/plain" });
          }
          res.end();
        });
        proxyResponse.pipe(res);
      }
    );

    proxyRequest.on("error", (error) => {
      onError(`Proxy error for ${host}: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("Target app is not responding.");
      }
    });

    res.on("close", () => {
      if (!proxyRequest.destroyed) {
        proxyRequest.destroy();
      }
    });

    req.pipe(proxyRequest);
  };

  const handleUpgrade = (httpsRequest: boolean) => (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());

    const authority = getRequestAuthority(req);
    const host = normalizeRequestHostname(authority);
    const route = findRoute(options.getRoutes(), host);
    if (!route) {
      socket.destroy();
      return;
    }

    const headers: http.OutgoingHttpHeaders = { ...req.headers, ...buildForwardedHeaders(req, authority, httpsRequest) };
    headers.host = authority;
    for (const key of Object.keys(headers)) {
      if (key.startsWith(":")) {
        delete headers[key];
      }
    }

    const proxyRequest = http.request({
      hostname: "127.0.0.1",
      port: route.port,
      path: req.url,
      method: req.method,
      headers,
    });

    proxyRequest.on("upgrade", (proxyResponse, proxySocket, proxyHead) => {
      let response = "HTTP/1.1 101 Switching Protocols\r\n";
      for (let index = 0; index < proxyResponse.rawHeaders.length; index += 2) {
        response += `${proxyResponse.rawHeaders[index]}: ${proxyResponse.rawHeaders[index + 1]}\r\n`;
      }
      response += "\r\n";

      socket.write(response);
      if (proxyHead.length > 0) {
        socket.write(proxyHead);
      }

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);

      proxySocket.on("error", () => socket.destroy());
      socket.on("error", () => proxySocket.destroy());
    });

    proxyRequest.on("response", (response) => {
      if (!socket.destroyed) {
        let raw = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          raw += `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`;
        }
        raw += "\r\n";
        socket.write(raw);
        response.pipe(socket);
      }
    });

    proxyRequest.on("error", (error) => {
      onError(`WebSocket proxy error for ${host}: ${error.message}`);
      socket.destroy();
    });

    if (head.length > 0) {
      proxyRequest.write(head);
    }

    proxyRequest.end();
  };

  const bundle: ProxyServerBundle = {};

  if (options.httpEnabled) {
    const server = http.createServer(handleRequest(false));
    server.on("upgrade", handleUpgrade(false));
    bundle.httpServer = server;
  }

  if (options.httpsEnabled && options.tls) {
    const server = http2.createSecureServer({
      cert: options.tls.cert,
      key: options.tls.key,
      allowHTTP1: true,
      ...(options.tls.SNICallback ? { SNICallback: options.tls.SNICallback } : {}),
    });

    server.on("request", (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
      handleRequest(true)(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
    });
    server.on("upgrade", handleUpgrade(true));
    bundle.httpsServer = server;
  }

  return bundle;
}
