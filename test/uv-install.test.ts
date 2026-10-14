import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { downloadUvWheel, ensureManagedUv, readZipEntries, UV_VERSION, UV_WHEEL_HOSTS, UV_WHEELS, uvWheelFor, type UvDownload, type UvWheel } from "../src/uv-install.js";

/** A minimal zip with deflated entries, laid out like a uv wheel. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const content = Buffer.from(text);
    const compressed = deflateRawSync(content);
    const fileName = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(content), 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, compressed);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const fakeWheel = (platform: NodeJS.Platform) => {
  const exe = platform === "win32" ? ".exe" : "";
  const bytes = zip({
    [`uv/__init__.py`]: "",
    [`uv-${UV_VERSION}.data/scripts/uv${exe}`]: "uv binary",
    [`uv-${UV_VERSION}.data/scripts/uvx${exe}`]: "uvx binary",
    [`uv-${UV_VERSION}.dist-info/licenses/LICENSE-APACHE`]: "apache",
    [`uv-${UV_VERSION}.dist-info/licenses/LICENSE-MIT`]: "mit",
  });
  const wheel: UvWheel = { path: "packages/aa/bb/uv-test.whl", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  return { bytes, wheel };
};

const serve = (files: Record<string, Buffer>, log: string[] = []): UvDownload => async (url) => {
  log.push(url);
  const body = files[new URL(url).hostname];
  return { ok: Boolean(body), status: body ? 200 : 404, arrayBuffer: async () => body!.buffer.slice(body!.byteOffset, body!.byteOffset + body!.byteLength) as ArrayBuffer };
};

test("every supported platform has a pinned uv wheel of the same version", () => {
  for (const key of ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]) {
    const wheel = UV_WHEELS[key]!;
    assert.match(wheel.path, new RegExp(`^packages/[0-9a-f/]+/uv-${UV_VERSION.replaceAll(".", "\\.")}-py3-none-[a-z0-9_.]+\\.whl$`), key);
    assert.match(wheel.sha256, /^[0-9a-f]{64}$/);
    assert.ok(wheel.size > 10_000_000);
  }
  assert.equal(uvWheelFor("linux", "x64"), UV_WHEELS["linux-x64"]);
  assert.match(UV_WHEELS["linux-x64"]!.path, /musllinux/, "Linux uses the static musl build so it runs on any libc");
  assert.equal(uvWheelFor("freebsd", "x64"), undefined);
  assert.ok(UV_WHEEL_HOSTS.every((host) => host.startsWith("https://") && host.endsWith("/")));
});

test("the wheel is accepted only with its pinned bytes, trying the next host otherwise", async () => {
  const { bytes, wheel } = fakeWheel("linux");
  const tampered = Buffer.from(bytes); tampered[tampered.length - 30] ^= 1;
  const log: string[] = [];
  const hosts = ["https://a.example/", "https://b.example/pypi/", "https://c.example/"];
  const result = await downloadUvWheel(wheel, serve({ "a.example": tampered, "b.example": bytes }, log), hosts);
  assert.ok(result.equals(bytes));
  assert.deepEqual(log, [`https://a.example/${wheel.path}`, `https://b.example/pypi/${wheel.path}`]);
  await assert.rejects(downloadUvWheel(wheel, serve({ "a.example": tampered }), hosts), /a\.example: uv .* does not match its pinned size and SHA-256\.; b\.example: HTTP 404; c\.example: HTTP 404/);
});

test("zip entries are read by name and a missing entry is an error", () => {
  const archive = zip({ "a.txt": "alpha", "dir/b.txt": "beta" });
  const entries = readZipEntries(archive, ["dir/b.txt"]);
  assert.equal(entries.get("dir/b.txt")!.toString(), "beta");
  assert.equal(entries.has("a.txt"), false);
  assert.throws(() => readZipEntries(archive, ["c.txt"]), /missing c\.txt/);
  assert.throws(() => readZipEntries(Buffer.from("not a zip at all, definitely not"), ["a"]), /Not a zip/);
});

for (const platform of ["linux", "win32"] as const) {
  test(`the managed uv is installed once into a versioned directory (${platform} layout)`, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "xiu-uv-"));
    try {
      const { bytes, wheel } = fakeWheel(platform);
      const log: string[] = [];
      const options = { home, platform, arch: "x64", wheel, hosts: ["https://a.example/"], download: serve({ "a.example": bytes }, log) };
      const uvx = await ensureManagedUv(options);
      const exe = platform === "win32" ? ".exe" : "";
      assert.equal(uvx, path.join(home, UV_VERSION, `uvx${exe}`));
      assert.equal(await fs.readFile(uvx, "utf8"), "uvx binary");
      assert.equal(await fs.readFile(path.join(home, UV_VERSION, `uv${exe}`), "utf8"), "uv binary");
      assert.equal(await fs.readFile(path.join(home, UV_VERSION, "LICENSE-MIT"), "utf8"), "mit");
      if (process.platform !== "win32") assert.equal((await fs.stat(uvx)).mode & 0o777, 0o755);
      assert.deepEqual((await fs.readdir(home)).sort(), [UV_VERSION], "no staging directory is left behind");
      assert.equal(await ensureManagedUv(options), uvx);
      assert.equal(log.length, 1, "an installed uv is reused without downloading");

      // An interrupted install (no VERSION marker) is replaced, not executed.
      await fs.rm(path.join(home, UV_VERSION, "VERSION"));
      assert.equal(await ensureManagedUv(options), uvx);
      assert.equal(log.length, 2);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
}

test("a platform without a pinned build asks the user to install uv", async () => {
  await assert.rejects(ensureManagedUv({ home: os.tmpdir(), platform: "freebsd", arch: "x64", download: async () => { throw new Error("no download"); } }), /No pinned uv build for freebsd-x64; install uv/);
});
