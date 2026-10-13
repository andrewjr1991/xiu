import { randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";

const digits = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001", "111100111001111", "111100111101111", "111001010010010", "111101111101111", "111101111001111"];
export const visionProbePrompt = 'Read the six digits in the attached image, left to right. Reply only with JSON: {"code":"six digits"}. Do not guess if the image is unavailable.';

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, checksum]);
}

/** Synthetic image only: answer never appears in prompt, filename, or metadata. */
export function createVisionChallenge(): { code: string; image: string } {
  const code = Array.from({ length: 6 }, () => randomInt(10)).join("");
  const width = 320, height = 100, scale = 10;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) pixels[y * (width * 3 + 1)] = 0;
  for (let i = 0; i < code.length; i++) for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) {
    if (digits[Number(code[i])]![row * 3 + col] !== "1") continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const offset = (25 + row * scale + dy) * (width * 3 + 1) + 1 + (20 + i * 48 + col * scale + dx) * 3;
      pixels.fill(20, offset, offset + 3);
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  return { code, image: `data:image/png;base64,${png.toString("base64")}` };
}

export function verifyVisionChallenge(answer: string, code: string): "passed" | "failed" | "unknown" {
  if (answer.length > 4096) return "unknown";
  try {
    const value: unknown = JSON.parse(answer.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (!value || typeof value !== "object" || !("code" in value) || typeof value.code !== "string" || !/^\d{6}$/.test(value.code)) return "unknown";
    return value.code === code ? "passed" : "failed";
  } catch { return "unknown"; }
}
