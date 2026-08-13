import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PLUGIN_SIGNATURE_FILE = "xiu.plugin.sig.json";
const MAX_SIGNATURE_BYTES = 64 * 1024;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type PluginSignatureStatus = "unsigned" | "valid-untrusted" | "trusted" | "invalid";

export interface PluginSignatureVerification {
  status: PluginSignatureStatus;
  publisherName?: string;
  publisherFingerprint?: string;
  publisherPublicKey?: string;
  problem?: string;
}

interface PluginSignatureDocument {
  version: 1;
  algorithm: "ed25519";
  pluginId: string;
  pluginVersion: string;
  packageDigest: string;
  publisher: { name?: string; publicKey: string };
  signature: string;
}

export interface TrustedPluginPublisher {
  fingerprint: string;
  name?: string;
  publicKey: string;
  trustedAt: string;
}

interface TrustedPublisherFile {
  version: 1;
  publishers: Record<string, TrustedPluginPublisher>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result && result.length <= maximum ? result : undefined;
}

function decodeBase64(value: string, maximumBytes: number): Buffer | undefined {
  if (!BASE64.test(value) || value.length > Math.ceil(maximumBytes / 3) * 4 + 4) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 && decoded.length <= maximumBytes && decoded.toString("base64") === value ? decoded : undefined;
}

export function pluginPublisherFingerprint(publicKey: string): string {
  const bytes = decodeBase64(publicKey, 4 * 1024);
  if (!bytes) throw new Error("publisher public key is not canonical base64");
  return createHash("sha256").update(bytes).digest("hex");
}

export function pluginSignatureMessage(pluginId: string, pluginVersion: string, packageDigest: string): Buffer {
  if (!HEX_SHA256.test(packageDigest)) throw new Error("plugin package digest is invalid");
  return Buffer.from(`xiu-plugin-signature-v1\0${pluginId}\0${pluginVersion}\0${packageDigest}`, "utf8");
}

export async function verifyPluginSignature(
  directory: string,
  pluginId: string,
  pluginVersion: string,
  packageDigest: string,
): Promise<PluginSignatureVerification> {
  const file = path.join(directory, PLUGIN_SIGNATURE_FILE);
  let raw: Buffer;
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SIGNATURE_BYTES) {
      return { status: "invalid", problem: "plugin signature must be a bounded regular file" };
    }
    raw = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "unsigned" };
    return { status: "invalid", problem: "plugin signature could not be read" };
  }

  try {
    const document = record(JSON.parse(raw.toString("utf8")));
    const publisher = record(document?.publisher);
    const publicKey = boundedText(publisher?.publicKey, 8 * 1024);
    const signatureText = boundedText(document?.signature, 8 * 1024);
    const publisherName = boundedText(publisher?.name, 128);
    if (
      document?.version !== 1
      || document.algorithm !== "ed25519"
      || document.pluginId !== pluginId
      || document.pluginVersion !== pluginVersion
      || document.packageDigest !== packageDigest
      || !publicKey
      || !signatureText
    ) return { status: "invalid", problem: "plugin signature metadata does not match the package" };
    const publicKeyBytes = decodeBase64(publicKey, 4 * 1024);
    const signature = decodeBase64(signatureText, 256);
    if (!publicKeyBytes || !signature) return { status: "invalid", problem: "plugin signature encoding is invalid" };
    const key = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return { status: "invalid", problem: "plugin signature key is not Ed25519" };
    const valid = verify(null, pluginSignatureMessage(pluginId, pluginVersion, packageDigest), key, signature);
    if (!valid) return { status: "invalid", problem: "plugin signature verification failed" };
    return {
      status: "valid-untrusted",
      publisherName,
      publisherFingerprint: pluginPublisherFingerprint(publicKey),
      publisherPublicKey: publicKey,
    };
  } catch {
    return { status: "invalid", problem: "plugin signature is invalid" };
  }
}

export class PluginPublisherTrustStore {
  constructor(private readonly file = path.join(os.homedir(), ".xiu", "trusted-plugin-publishers.json")) {}

  private async read(): Promise<TrustedPublisherFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as TrustedPublisherFile;
      if (parsed?.version !== 1 || !parsed.publishers || typeof parsed.publishers !== "object" || Array.isArray(parsed.publishers)) {
        throw new Error("invalid trusted plugin publisher store");
      }
      for (const [fingerprint, publisher] of Object.entries(parsed.publishers)) {
        if (!HEX_SHA256.test(fingerprint) || publisher?.fingerprint !== fingerprint || pluginPublisherFingerprint(publisher.publicKey) !== fingerprint) {
          throw new Error("invalid trusted plugin publisher record");
        }
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, publishers: {} };
      throw error;
    }
  }

  private async write(data: TrustedPublisherFile): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try { await fs.rename(temporary, this.file); }
    catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async list(): Promise<TrustedPluginPublisher[]> {
    return Object.values((await this.read()).publishers).sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  }

  async isTrusted(fingerprint: string, publicKey: string): Promise<boolean> {
    const publisher = (await this.read()).publishers[fingerprint];
    return publisher?.publicKey === publicKey && pluginPublisherFingerprint(publicKey) === fingerprint;
  }

  async trust(publicKey: string, name?: string): Promise<TrustedPluginPublisher> {
    const fingerprint = pluginPublisherFingerprint(publicKey);
    const data = await this.read();
    const publisher: TrustedPluginPublisher = { fingerprint, publicKey, trustedAt: new Date().toISOString(), ...(name ? { name } : {}) };
    data.publishers[fingerprint] = publisher;
    await this.write(data);
    return publisher;
  }

  async revoke(fingerprint: string): Promise<boolean> {
    if (!HEX_SHA256.test(fingerprint)) throw new Error("publisher fingerprint must be a full SHA-256 hex value");
    const data = await this.read();
    if (!data.publishers[fingerprint]) return false;
    delete data.publishers[fingerprint];
    await this.write(data);
    return true;
  }
}
