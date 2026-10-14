import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { EnvHttpProxyAgent, fetch as undiciFetch, ProxyAgent } from "undici";

/**
 * A pinned uv for local free-search, so users do not have to install it themselves.
 *
 * The desktop installer ships the Windows build; the CLI downloads the build for its platform on
 * the first local search when no uv is on PATH. Either way the file is the official PyPI wheel,
 * accepted only when its size and SHA-256 match the values below, so a mirror cannot alter it.
 * To update: choose a release at least two weeks old and copy each wheel's path, size and sha256
 * from https://pypi.org/pypi/uv/<version>/json (Linux uses the static musllinux builds).
 */
export const UV_VERSION = "0.12.21";

export interface UvWheel {
  /** Path below a PyPI file host, identical on the official host and its mirrors. */
  path: string;
  size: number;
  sha256: string;
}

export const UV_WHEELS: Readonly<Record<string, UvWheel>> = {
  "win32-x64": { path: "packages/2a/06/bda383b338dd21bcd74c9b4ba47301315573fdb5aba46fe40835f8299482/uv-0.12.21-py3-none-win_amd64.whl", size: 18087242, sha256: "8c7c3eb32d84c711906dedd09df7379cf4d9f5bb84b8e58a1244ca0a8a1209d4" },
  "win32-arm64": { path: "packages/2c/76/1b6478ff9dcc3b58b2025828e00f06bac4915b7442c8254d5b6265707561/uv-0.12.21-py3-none-win_arm64.whl", size: 19369672, sha256: "79dc0c11e7f169f1b32cf6838b6a0d651ba054cc8013e0b2e5fe34392c1d1528" },
  "darwin-x64": { path: "packages/51/f0/8673a5aeb771f99aadd269aa069874b10b8ed43fcb3a08a88d3770c27ad9/uv-0.12.21-py3-none-macosx_10_12_x86_64.whl", size: 20942550, sha256: "9c6fab087f35c8f8c0c79ad4c8a94f6804b983369c2887250fb753a70d8080fd" },
  "darwin-arm64": { path: "packages/66/72/389b430ec12bd15547d4d3641622479cbf7a5c94af0ffb14fee2ed58f891/uv-0.12.21-py3-none-macosx_11_0_arm64.whl", size: 17124497, sha256: "eb4f75e8ed770e1f142e03a134b9507e7f4710c4b2cec385d4bf8c5810a91094" },
  "linux-x64": { path: "packages/e9/1b/d359f667826d67bf1acd2a80ce4e2fe0bb661e796c296a8b7ff6c386db9f/uv-0.12.21-py3-none-musllinux_1_1_x86_64.whl", size: 23403470, sha256: "26aaa1dce3ae90502b2d7aa15577587aa185e5ba13480afd03df6c95dc2bb55b" },
  "linux-arm64": { path: "packages/0e/05/6c536d9cf7977d3c55b8835a90d1e9e58def00309bec0e2ad062157d4499/uv-0.12.21-py3-none-manylinux_2_17_aarch64.manylinux2014_aarch64.musllinux_1_1_aarch64.whl", size: 22122033, sha256: "b7db8b4913e6cd34e6aabbe08ff82fbac7c1edae57747ea23118ca460f060d44" },
};

/** Tried in order. The pinned SHA-256 makes every mirror as trustworthy as the official host. */
export const UV_WHEEL_HOSTS = [
  "https://files.pythonhosted.org/",
  "https://pypi.tuna.tsinghua.edu.cn/",
  "https://mirrors.aliyun.com/pypi/",
];

const DOWNLOAD_TIMEOUT_MS = 120_000;

export function uvWheelFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch): UvWheel | undefined {
  return UV_WHEELS[`${platform}-${arch}`];
}

export function uvExecutableName(name: "uv" | "uvx", platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${name}.exe` : name;
}

export function verifyUvWheel(bytes: Buffer, wheel: UvWheel): void {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== wheel.size || digest !== wheel.sha256) {
    throw new Error(`uv ${UV_VERSION} download does not match its pinned size and SHA-256.`);
  }
}

/** Reads only the named entries of a zip archive (stored or deflated). */
export function readZipEntries(bytes: Buffer, names: readonly string[]): Map<string, Buffer> {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error("Not a zip archive.");
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const found = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Corrupt zip central directory.");
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    if (!names.includes(name)) continue;
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error(`Corrupt zip entry ${name}.`);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + compressedSize);
    const content = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : undefined;
    if (!content || content.length !== size) throw new Error(`Unsupported or corrupt zip entry ${name}.`);
    found.set(name, content);
  }
  const missing = names.filter((name) => !found.has(name));
  if (missing.length) throw new Error(`Zip archive is missing ${missing.join(", ")}.`);
  return found;
}

/** Writes uv, uvx and their licenses from a verified wheel into `directory`. */
export async function extractUv(bytes: Buffer, wheel: UvWheel, directory: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  verifyUvWheel(bytes, wheel);
  const files: Record<string, string> = {
    [`uv-${UV_VERSION}.data/scripts/${uvExecutableName("uv", platform)}`]: uvExecutableName("uv", platform),
    [`uv-${UV_VERSION}.data/scripts/${uvExecutableName("uvx", platform)}`]: uvExecutableName("uvx", platform),
    [`uv-${UV_VERSION}.dist-info/licenses/LICENSE-APACHE`]: "LICENSE-APACHE",
    [`uv-${UV_VERSION}.dist-info/licenses/LICENSE-MIT`]: "LICENSE-MIT",
  };
  const entries = readZipEntries(bytes, Object.keys(files));
  await fs.mkdir(directory, { recursive: true });
  for (const [name, target] of Object.entries(files)) {
    await fs.writeFile(path.join(directory, target), entries.get(name)!, { mode: target.startsWith("LICENSE") ? 0o644 : 0o755 });
  }
  // Written last: its presence marks a complete extraction.
  await fs.writeFile(path.join(directory, "VERSION"), `${UV_VERSION}\n`, "utf8");
}

export type UvDownload = (url: string, signal: AbortSignal) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/** Uses Xiu's web proxy when set, else the terminal's HTTPS_PROXY/NO_PROXY like uv itself does. */
export function uvDownloader(proxy?: string): UvDownload {
  const dispatcher = proxy ? new ProxyAgent(proxy) : new EnvHttpProxyAgent();
  return (url, signal) => undiciFetch(url, { signal, dispatcher });
}

/** Fetches the pinned wheel from the first host that returns the exact pinned bytes. */
export async function downloadUvWheel(wheel: UvWheel, download: UvDownload, hosts: readonly string[] = UV_WHEEL_HOSTS): Promise<Buffer> {
  const failures: string[] = [];
  for (const host of hosts) {
    const url = new URL(wheel.path, host).toString();
    try {
      const response = await download(url, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      verifyUvWheel(bytes, wheel);
      return bytes;
    } catch (error) {
      failures.push(`${new URL(host).hostname}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Could not download uv ${UV_VERSION} (${failures.join("; ")}).`);
}

export function managedUvHome(): string {
  return path.join(os.homedir(), ".xiu", "uv");
}

async function installed(directory: string, platform: NodeJS.Platform): Promise<string | undefined> {
  const uvx = path.join(directory, uvExecutableName("uvx", platform));
  try {
    if ((await fs.readFile(path.join(directory, "VERSION"), "utf8")).trim() !== UV_VERSION) return undefined;
    await fs.access(uvx);
    await fs.access(path.join(directory, uvExecutableName("uv", platform)));
    return uvx;
  } catch {
    return undefined;
  }
}

export interface ManagedUvOptions {
  home?: string;
  proxy?: string;
  download?: UvDownload;
  hosts?: readonly string[];
  platform?: NodeJS.Platform;
  arch?: string;
  /** Tests only: a wheel other than the pinned one for this platform. */
  wheel?: UvWheel;
}

/** Returns the path of Xiu's own pinned uvx, downloading and verifying it on first use. */
export async function ensureManagedUv(options: ManagedUvOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const wheel = options.wheel ?? uvWheelFor(platform, arch);
  if (!wheel) throw new Error(`No pinned uv build for ${platform}-${arch}; install uv (https://docs.astral.sh/uv/) to use local free-search.`);
  const home = options.home ?? managedUvHome();
  const directory = path.join(home, UV_VERSION);
  const existing = await installed(directory, platform);
  if (existing) return existing;
  const bytes = await downloadUvWheel(wheel, options.download ?? uvDownloader(options.proxy), options.hosts);
  // Extract beside the target and rename into place, so concurrent processes and interrupted
  // runs never leave a half-written uv at the path that is executed.
  const staging = path.join(home, `.${UV_VERSION}-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    await extractUv(bytes, wheel, staging, platform);
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rename(staging, directory).catch(async (error: unknown) => {
      if (!(await installed(directory, platform))) throw error;
    });
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
  const ready = await installed(directory, platform);
  if (!ready) throw new Error(`uv ${UV_VERSION} could not be installed under ${home}.`);
  return ready;
}
