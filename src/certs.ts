import * as crypto from "node:crypto";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as tls from "node:tls";
import { promisify } from "node:util";
import { fixOwnership } from "./utils.js";

const CA_VALIDITY_DAYS = 3650;
const SERVER_VALIDITY_DAYS = 365;
const EXPIRY_BUFFER_MS = 7 * 24 * 60 * 60 * 1000;
const CA_COMMON_NAME = "local-router Local CA";
const OPENSSL_TIMEOUT_MS = 15_000;

const CA_KEY_FILE = "ca-key.pem";
const CA_CERT_FILE = "ca.pem";
const SERVER_KEY_FILE = "server-key.pem";
const SERVER_CERT_FILE = "server.pem";
const HOST_CERTS_DIR = "host-certs";
const MAX_CN_LENGTH = 64;

const execFileAsync = promisify(execFileCb);

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function openssl(args: string[], options?: { input?: string }): string {
  try {
    return execFileSync("openssl", args, {
      encoding: "utf-8",
      input: options?.input,
      timeout: OPENSSL_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `openssl failed: ${message}\n\nInstall or expose openssl in PATH before using HTTPS.`
    );
  }
}

async function opensslAsync(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("openssl", args, {
      encoding: "utf-8",
      timeout: OPENSSL_TIMEOUT_MS,
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `openssl failed: ${message}\n\nInstall or expose openssl in PATH before using HTTPS.`
    );
  }
}

function isCertValid(certPath: string): boolean {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath, "utf-8"));
    const expiry = new Date(cert.validTo).getTime();
    return Date.now() + EXPIRY_BUFFER_MS < expiry;
  } catch {
    return false;
  }
}

function isCertSignatureStrong(certPath: string): boolean {
  try {
    const text = openssl(["x509", "-in", certPath, "-noout", "-text"]);
    const match = text.match(/Signature Algorithm:\s*(\S+)/i);
    return !!match && !match[1].toLowerCase().includes("sha1");
  } catch {
    return false;
  }
}

function generateCA(stateDir: string): { certPath: string; keyPath: string } {
  const keyPath = path.join(stateDir, CA_KEY_FILE);
  const certPath = path.join(stateDir, CA_CERT_FILE);

  openssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", keyPath]);
  openssl([
    "req",
    "-new",
    "-x509",
    "-sha256",
    "-key",
    keyPath,
    "-out",
    certPath,
    "-days",
    String(CA_VALIDITY_DAYS),
    "-subj",
    `/CN=${CA_COMMON_NAME}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);

  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o644);
  fixOwnership(keyPath, certPath);

  return { certPath, keyPath };
}

function generateBaseServerCert(stateDir: string): { certPath: string; keyPath: string } {
  const caKeyPath = path.join(stateDir, CA_KEY_FILE);
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  const serverKeyPath = path.join(stateDir, SERVER_KEY_FILE);
  const serverCertPath = path.join(stateDir, SERVER_CERT_FILE);
  const csrPath = path.join(stateDir, "server.csr");
  const extPath = path.join(stateDir, "server-ext.cnf");

  openssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", serverKeyPath]);
  openssl(["req", "-new", "-key", serverKeyPath, "-out", csrPath, "-subj", "/CN=localhost"]);

  fs.writeFileSync(
    extPath,
    [
      "authorityKeyIdentifier=keyid,issuer",
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:localhost,DNS:*.localhost",
    ].join("\n") + "\n"
  );

  openssl([
    "x509",
    "-req",
    "-sha256",
    "-in",
    csrPath,
    "-CA",
    caCertPath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
    "-out",
    serverCertPath,
    "-days",
    String(SERVER_VALIDITY_DAYS),
    "-extfile",
    extPath,
  ]);

  for (const tempPath of [csrPath, extPath]) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Non-fatal.
    }
  }

  fs.chmodSync(serverKeyPath, 0o600);
  fs.chmodSync(serverCertPath, 0o644);
  fixOwnership(serverKeyPath, serverCertPath);

  return { certPath: serverCertPath, keyPath: serverKeyPath };
}

export function ensureCerts(stateDir: string): {
  certPath: string;
  keyPath: string;
  caPath: string;
  caGenerated: boolean;
} {
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  const caKeyPath = path.join(stateDir, CA_KEY_FILE);
  const serverCertPath = path.join(stateDir, SERVER_CERT_FILE);
  const serverKeyPath = path.join(stateDir, SERVER_KEY_FILE);

  let caGenerated = false;

  if (
    !fileExists(caCertPath) ||
    !fileExists(caKeyPath) ||
    !isCertValid(caCertPath) ||
    !isCertSignatureStrong(caCertPath)
  ) {
    generateCA(stateDir);
    caGenerated = true;
  }

  if (
    caGenerated ||
    !fileExists(serverCertPath) ||
    !fileExists(serverKeyPath) ||
    !isCertValid(serverCertPath) ||
    !isCertSignatureStrong(serverCertPath)
  ) {
    generateBaseServerCert(stateDir);
  }

  return {
    certPath: serverCertPath,
    keyPath: serverKeyPath,
    caPath: caCertPath,
    caGenerated,
  };
}

function sanitizeHostForFilename(hostname: string): string {
  return hostname.replace(/\./g, "_").replace(/[^a-z0-9_-]/gi, "");
}

async function generateHostCertAsync(
  stateDir: string,
  hostname: string
): Promise<{ certPath: string; keyPath: string }> {
  const caKeyPath = path.join(stateDir, CA_KEY_FILE);
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  const hostCertDir = path.join(stateDir, HOST_CERTS_DIR);

  if (!fs.existsSync(hostCertDir)) {
    await fs.promises.mkdir(hostCertDir, { recursive: true, mode: 0o755 });
    fixOwnership(hostCertDir);
  }

  const safeName = sanitizeHostForFilename(hostname);
  const keyPath = path.join(hostCertDir, `${safeName}-key.pem`);
  const certPath = path.join(hostCertDir, `${safeName}.pem`);
  const csrPath = path.join(hostCertDir, `${safeName}.csr`);
  const extPath = path.join(hostCertDir, `${safeName}-ext.cnf`);

  await opensslAsync(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", keyPath]);

  const commonName = hostname.length > MAX_CN_LENGTH ? hostname.slice(0, MAX_CN_LENGTH) : hostname;
  await opensslAsync(["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", `/CN=${commonName}`]);

  fs.writeFileSync(
    extPath,
    [
      "authorityKeyIdentifier=keyid,issuer",
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=DNS:${hostname}`,
    ].join("\n") + "\n"
  );

  await opensslAsync([
    "x509",
    "-req",
    "-sha256",
    "-in",
    csrPath,
    "-CA",
    caCertPath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
    "-out",
    certPath,
    "-days",
    String(SERVER_VALIDITY_DAYS),
    "-extfile",
    extPath,
  ]);

  for (const tempPath of [csrPath, extPath]) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Non-fatal.
    }
  }

  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o644);
  fixOwnership(keyPath, certPath);

  return { certPath, keyPath };
}

export function createSNICallback(stateDir: string, defaultCert: Buffer, defaultKey: Buffer) {
  const cache = new Map<string, tls.SecureContext>();
  const defaultContext = tls.createSecureContext({ cert: defaultCert, key: defaultKey });

  return async (servername: string, callback: (err: Error | null, ctx?: tls.SecureContext) => void) => {
    try {
      if (!servername || servername === "localhost") {
        callback(null, defaultContext);
        return;
      }

      const cached = cache.get(servername);
      if (cached) {
        callback(null, cached);
        return;
      }

      const safeName = sanitizeHostForFilename(servername);
      const certPath = path.join(stateDir, HOST_CERTS_DIR, `${safeName}.pem`);
      const keyPath = path.join(stateDir, HOST_CERTS_DIR, `${safeName}-key.pem`);

      let resolvedCertPath = certPath;
      let resolvedKeyPath = keyPath;
      if (!fileExists(certPath) || !fileExists(keyPath) || !isCertValid(certPath) || !isCertSignatureStrong(certPath)) {
        const generated = await generateHostCertAsync(stateDir, servername);
        resolvedCertPath = generated.certPath;
        resolvedKeyPath = generated.keyPath;
      }

      const context = tls.createSecureContext({
        cert: fs.readFileSync(resolvedCertPath),
        key: fs.readFileSync(resolvedKeyPath),
      });
      cache.set(servername, context);
      callback(null, context);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)), defaultContext);
    }
  };
}

function isCATrustedMacOS(caCertPath: string): boolean {
  try {
    execFileSync("security", ["verify-cert", "-c", caCertPath, "-L", "-p", "ssl"], {
      stdio: "pipe",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function isCATrustedLinux(stateDir: string): boolean {
  const candidatePaths = [
    "/usr/local/share/ca-certificates/local-router-ca.crt",
    "/etc/pki/ca-trust/source/anchors/local-router-ca.crt",
    "/etc/ca-certificates/trust-source/anchors/local-router-ca.crt",
    "/etc/pki/trust/anchors/local-router-ca.crt",
  ];

  const localCert = path.join(stateDir, CA_CERT_FILE);
  if (!fileExists(localCert)) return false;

  for (const candidate of candidatePaths) {
    try {
      if (fs.readFileSync(candidate, "utf-8").trim() === fs.readFileSync(localCert, "utf-8").trim()) {
        return true;
      }
    } catch {
      // Keep checking.
    }
  }

  return false;
}

function isCATrustedWindows(caCertPath: string): boolean {
  try {
    const fingerprint = openssl(["x509", "-in", caCertPath, "-noout", "-fingerprint", "-sha1"])
      .trim()
      .replace(/^.*=/, "")
      .replace(/:/g, "")
      .toLowerCase();

    const result = execFileSync("certutil", ["-store", "-user", "Root"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return result.replace(/\s/g, "").toLowerCase().includes(fingerprint);
  } catch {
    return false;
  }
}

export function isCATrusted(stateDir: string): boolean {
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  if (!fileExists(caCertPath)) return false;

  if (process.platform === "darwin") return isCATrustedMacOS(caCertPath);
  if (process.platform === "linux") return isCATrustedLinux(stateDir);
  if (process.platform === "win32") return isCATrustedWindows(caCertPath);
  return false;
}

export function trustCA(stateDir: string): { trusted: boolean; error?: string } {
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  if (!fileExists(caCertPath)) {
    return { trusted: false, error: "CA certificate not found. Start the proxy with HTTPS first." };
  }

  try {
    if (process.platform === "darwin") {
      execFileSync("security", ["add-trusted-cert", "-d", "-r", "trustRoot", "-k", "/Library/Keychains/System.keychain", caCertPath], {
        stdio: "pipe",
        timeout: 10_000,
      });
      return { trusted: true };
    }

    if (process.platform === "linux") {
      const destination = fs.existsSync("/usr/local/share/ca-certificates")
        ? "/usr/local/share/ca-certificates/local-router-ca.crt"
        : "/etc/pki/ca-trust/source/anchors/local-router-ca.crt";

      fs.copyFileSync(caCertPath, destination);
      const updateCommand = fs.existsSync("/usr/sbin/update-ca-certificates") || fs.existsSync("/usr/bin/update-ca-certificates")
        ? ["update-ca-certificates"]
        : ["update-ca-trust"];

      execFileSync(updateCommand[0], [], { stdio: "pipe", timeout: 15_000 });
      return { trusted: true };
    }

    if (process.platform === "win32") {
      execFileSync("certutil", ["-addstore", "-user", "Root", caCertPath], {
        stdio: "pipe",
        timeout: 10_000,
      });
      return { trusted: true };
    }

    return { trusted: false, error: `Unsupported platform: ${process.platform}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { trusted: false, error: message };
  }
}
