import type { SecureContext } from "node:tls";

export interface RouteInfo {
  hostname: string;
  port: number;
}

export interface RouteMapping extends RouteInfo {
  pid: number;
}

export interface ProxyRuntimeConfig {
  httpPort: number;
  httpsPort: number;
  httpEnabled: boolean;
  httpsEnabled: boolean;
  autoStopWhenIdle?: boolean;
}

export interface ProxyState extends ProxyRuntimeConfig {
  pid: number;
  autoStopWhenIdle?: boolean;
}

export interface LocalRouterConfig {
  name?: string;
  hosts?: string[];
}

export interface ResolvedProjectHosts {
  name: string;
  baseHostname: string;
  hostnames: string[];
  configPath?: string;
  nameSource: string;
}

export interface ProxyTlsOptions {
  cert: Buffer;
  key: Buffer;
  SNICallback?: (servername: string, cb: (err: Error | null, ctx?: SecureContext) => void) => void;
}
