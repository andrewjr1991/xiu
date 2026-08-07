import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { localize, type UiLanguage } from "./i18n.js";

const execFileAsync = promisify(execFile);
const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const WINDOWS_HELPER_SOURCE = String.raw`
using System;
using System.Collections.Specialized;
using System.Drawing;
using System.Drawing.Imaging;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class XiuClipboardHelper {
  private static void Emit(string kind, string value) {
    Console.WriteLine(kind + "\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? "")));
  }

  [STAThread]
  private static int Main(string[] args) {
    if (args.Length != 1) return 2;
    Exception last = null;
    for (int attempt = 0; attempt < 6; attempt++) {
      try {
        if (Clipboard.ContainsFileDropList()) {
          StringCollection files = Clipboard.GetFileDropList();
          foreach (string file in files) Emit("file", file);
          return 0;
        }
        if (Clipboard.ContainsImage()) {
          using (Image image = Clipboard.GetImage()) image.Save(args[0], ImageFormat.Png);
          Emit("image", args[0]);
          return 0;
        }
        if (Clipboard.ContainsText()) {
          Emit("text", Clipboard.GetText());
          return 0;
        }
        Emit("empty", "");
        return 0;
      } catch (Exception error) {
        last = error;
        Thread.Sleep(60 * (attempt + 1));
      }
    }
    Emit("error", last == null ? "Clipboard unavailable" : last.Message);
    return 1;
  }
}
`;

export interface ClipboardPayload {
  kind: "text" | "files" | "image" | "empty" | "restricted";
  text?: string;
  files?: string[];
  imagePath?: string;
}

export interface ClipboardPasteResult {
  insertText: string;
  notice?: string;
  attachments: string[];
}

export interface ClipboardBackend {
  read(imageOutputPath: string): Promise<ClipboardPayload>;
  supportsRightClick?(): Promise<boolean>;
}

class ClipboardPolicyError extends Error {
  constructor(readonly kind: "access" | "image") {
    super(kind === "image"
      ? "The clipboard contains a bitmap, but image extraction is blocked."
      : "Windows clipboard access is restricted.");
    this.name = "ClipboardPolicyError";
  }
}

const POWERSHELL_CLIPBOARD_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$result = $null
$restricted = $false
try {
  $files = @(Get-Clipboard -Format FileDropList -ErrorAction Stop | Where-Object { $null -ne $_ })
  if ($files.Count -gt 0) {
    $paths = @($files | ForEach-Object {
      if ($null -ne $_.FullName -and $_.FullName.Length -gt 0) { [string]$_.FullName }
      else { [string]$_ }
    })
    $result = @{ kind = 'files'; files = @($paths) }
  }
} catch { $restricted = $true }
if ($null -eq $result) {
  try {
    $text = Get-Clipboard -Raw -ErrorAction Stop
    if ($null -ne $text -and [string]$text -ne '') { $result = @{ kind = 'text'; text = [string]$text } }
  } catch { $restricted = $true }
}
if ($null -eq $result) {
  try {
    $image = Get-Clipboard -Format Image -ErrorAction Stop
    if ($null -ne $image) { $result = @{ kind = 'image' } }
  } catch { $restricted = $true }
}
if ($null -eq $result) {
  if ($restricted) { $result = @{ kind = 'restricted' } }
  else { $result = @{ kind = 'empty' } }
}
$result | ConvertTo-Json -Compress -Depth 3 | Set-Content -LiteralPath $env:XIU_CLIPBOARD_RESPONSE -Encoding UTF8
`;

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function parsePowerShellClipboardResponse(value: string): ClipboardPayload {
  const parsed = JSON.parse(value.replace(/^\uFEFF/, "")) as { kind?: unknown; text?: unknown; files?: unknown };
  if (parsed.kind === "text" && typeof parsed.text === "string") return { kind: "text", text: parsed.text };
  if (parsed.kind === "files" && Array.isArray(parsed.files) && parsed.files.every((item) => typeof item === "string")) {
    return { kind: "files", files: parsed.files };
  }
  if (parsed.kind === "image") return { kind: "image" };
  if (parsed.kind === "empty") return { kind: "empty" };
  if (parsed.kind === "restricted") return { kind: "restricted" };
  throw new Error("PowerShell clipboard reader returned an invalid response");
}

class PowerShellClipboardBackend implements ClipboardBackend {
  supportsRightClick(): Promise<boolean> {
    // Right-click belongs to the terminal host. Capturing it through mouse
    // reporting disables the host's own paste implementation and breaks in
    // enterprise environments where programmatic clipboard access is blocked.
    return Promise.resolve(false);
  }

  async read(imageOutputPath: string): Promise<ClipboardPayload> {
    if (process.platform !== "win32") throw new Error("Windows Get-Clipboard is unavailable on this platform");
    const responsePath = `${imageOutputPath}.json`;
    try {
      await execFileAsync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
        encodedPowerShell(POWERSHELL_CLIPBOARD_SCRIPT),
      ], {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, XIU_CLIPBOARD_RESPONSE: responsePath },
      });
      return parsePowerShellClipboardResponse(await fs.readFile(responsePath, "utf8"));
    } catch (error) {
      throw new Error("Windows policy blocked programmatic clipboard access");
    } finally {
      await fs.unlink(responsePath).catch(() => undefined);
    }
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function reference(pathname: string): string {
  const normalized = pathname.split(path.sep).join("/");
  return /\s/.test(normalized) ? `@"${normalized}"` : `@${normalized}`;
}

function safeName(value: string): string {
  const parsed = path.parse(value);
  const stem = parsed.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").trim().slice(0, 80) || "attachment";
  const extension = parsed.ext.replace(/[^.A-Za-z0-9_-]/g, "").slice(0, 16);
  return `${stem}${extension}`;
}

async function uniqueDestination(directory: string, sourceName: string, index: number): Promise<string> {
  const parsed = path.parse(safeName(sourceName));
  const prefix = `${timestamp()}-${index + 1}-${parsed.name}`;
  for (let suffix = 0; suffix < 100; suffix++) {
    const candidate = path.join(directory, `${prefix}${suffix ? `-${suffix}` : ""}${parsed.ext}`);
    if (!(await fs.stat(candidate).then(() => true).catch(() => false))) return candidate;
  }
  throw new Error(`Could not allocate a destination for ${sourceName}`);
}

function parseHelperOutput(stdout: string): ClipboardPayload {
  const records = stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("\t");
    if (separator < 0) throw new Error("Clipboard helper returned an invalid response");
    return { kind: line.slice(0, separator), value: Buffer.from(line.slice(separator + 1), "base64").toString("utf8") };
  });
  const error = records.find((record) => record.kind === "error");
  if (error) throw new Error(error.value || "Clipboard is unavailable");
  const files = records.filter((record) => record.kind === "file").map((record) => record.value);
  if (files.length) return { kind: "files", files };
  const image = records.find((record) => record.kind === "image");
  if (image) return { kind: "image", imagePath: image.value };
  const text = records.find((record) => record.kind === "text");
  if (text) return { kind: "text", text: text.value };
  return { kind: "empty" };
}

class WindowsHelperClipboardBackend implements ClipboardBackend {
  private helperPath?: string;

  private async helper(): Promise<string> {
    if (this.helperPath) return this.helperPath;
    const directory = path.join(os.homedir(), ".xiu", "cache", "clipboard-helper-v1");
    const executable = path.join(directory, "xiu-clipboard.exe");
    if (!(await fs.stat(executable).then((stat) => stat.isFile()).catch(() => false))) {
      await fs.mkdir(directory, { recursive: true });
      const source = path.join(directory, "xiu-clipboard.cs");
      await fs.writeFile(source, WINDOWS_HELPER_SOURCE, "utf8");
      const windowsDirectory = process.env.WINDIR || "C:\\Windows";
      const candidates = [
        path.join(windowsDirectory, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
        path.join(windowsDirectory, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
      ];
      const compiler = (await Promise.all(candidates.map(async (candidate) => ({ candidate, exists: await fs.stat(candidate).then(() => true).catch(() => false) })))).find((item) => item.exists)?.candidate;
      if (!compiler) throw new Error("Windows clipboard image support requires the built-in .NET Framework compiler, but csc.exe was not found");
      try {
        await execFileAsync(compiler, ["/nologo", "/target:exe", `/out:${executable}`, "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", source], {
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
      } catch (error) {
        const detail = error as Error & { stdout?: string; stderr?: string };
        throw new Error(`Could not prepare clipboard image support: ${detail.stderr?.trim() || detail.stdout?.trim() || detail.message}`);
      }
    }
    this.helperPath = executable;
    return executable;
  }

  async hasCachedHelper(): Promise<boolean> {
    const executable = path.join(os.homedir(), ".xiu", "cache", "clipboard-helper-v1", "xiu-clipboard.exe");
    return await fs.stat(executable).then((stat) => stat.isFile()).catch(() => false);
  }

  async read(imageOutputPath: string): Promise<ClipboardPayload> {
    if (process.platform !== "win32") throw new Error("Binary clipboard attachments are currently supported on Windows; paste a file path on this platform");
    const executable = await this.helper();
    try {
      const result = await execFileAsync(executable, [imageOutputPath], { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
      return parseHelperOutput(result.stdout);
    } catch (error) {
      const detail = error as Error & { stdout?: string };
      if (detail.stdout) return parseHelperOutput(detail.stdout);
      throw new Error(`Could not read the clipboard: ${detail.message}`);
    }
  }
}

export class WindowsClipboardBackend implements ClipboardBackend {
  constructor(
    private readonly native: ClipboardBackend = new PowerShellClipboardBackend(),
    private readonly imageHelper: ClipboardBackend & { hasCachedHelper?: () => Promise<boolean> } = new WindowsHelperClipboardBackend(),
  ) {}

  async supportsRightClick(): Promise<boolean> {
    // Never intercept right-click. Windows Terminal and PowerShell can paste
    // text and Explorer-provided paths without Xiu reading the clipboard.
    return false;
  }

  async read(imageOutputPath: string): Promise<ClipboardPayload> {
    let payload: ClipboardPayload;
    try {
      payload = await this.native.read(imageOutputPath);
    } catch (error) {
      void error;
      throw new ClipboardPolicyError("access");
    }
    if (payload.kind === "restricted") {
      throw new ClipboardPolicyError("access");
    }
    if (payload.kind !== "image" || payload.imagePath) return payload;
    try {
      return await this.imageHelper.read(imageOutputPath);
    } catch (error) {
      void error;
      throw new ClipboardPolicyError("image");
    }
  }
}

function textFilePaths(text: string): string[] | undefined {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim().replace(/^"|"$/g, "")).filter(Boolean);
  if (!lines.length || lines.length > MAX_ATTACHMENTS) return undefined;
  return lines.every((line) => path.isAbsolute(line)) ? lines : undefined;
}

export class ClipboardAttachmentManager {
  private readonly backend: ClipboardBackend;

  constructor(private readonly cwd: string, backend?: ClipboardBackend, private readonly language: UiLanguage = "en-US") {
    this.backend = backend ?? new WindowsClipboardBackend();
  }

  async supportsRightClickPaste(): Promise<boolean> {
    return await this.backend.supportsRightClick?.() ?? false;
  }

  async paste(): Promise<ClipboardPasteResult> {
    const attachmentDirectory = path.join(this.cwd, ".xiu", "attachments");
    await fs.mkdir(attachmentDirectory, { recursive: true });
    const imageOutput = path.join(attachmentDirectory, `${timestamp()}-clipboard.png`);
    let payload: ClipboardPayload;
    try {
      payload = await this.backend.read(imageOutput);
    } catch (error) {
      if (error instanceof ClipboardPolicyError) {
        throw new Error(error.kind === "image"
          ? localize(this.language, "剪贴板中是位图，但系统禁止提取图片。请先保存成图片文件，再使用 @路径 引用。", "The clipboard contains a bitmap, but image extraction is blocked. Save it as a file and reference it with @path.")
          : localize(this.language, "系统策略禁止程序读取剪贴板。请使用终端原生右键粘贴文字或文件路径；剪贴板图片请先保存成文件，再使用 @路径 引用。", "Windows clipboard access is restricted. Use native terminal right-click for text or file paths; save clipboard images as files and reference them with @path."));
      }
      throw error;
    }
    if (payload.kind === "restricted") {
      throw new Error(localize(this.language, "系统策略禁止程序读取剪贴板。请使用终端原生右键粘贴，或使用 @路径 引用文件。", "Windows clipboard access is restricted. Use native terminal paste or reference a saved file with @path."));
    }
    if (payload.kind === "empty") throw new Error("The clipboard does not contain text, an image, or files");
    if (payload.kind === "text") {
      const possibleFiles = textFilePaths(payload.text ?? "");
      if (!possibleFiles) return { insertText: payload.text ?? "", attachments: [] };
      const existing = await Promise.all(possibleFiles.map(async (file) => ({ file, exists: await fs.stat(file).then((stat) => stat.isFile()).catch(() => false) })));
      if (!existing.every((item) => item.exists)) return { insertText: payload.text ?? "", attachments: [] };
      return await this.importFiles(possibleFiles, attachmentDirectory);
    }
    if (payload.kind === "image") {
      if (!payload.imagePath) throw new Error("Clipboard image was not saved");
      const resolvedImage = path.resolve(payload.imagePath);
      if (resolvedImage !== path.resolve(imageOutput)) throw new Error("Clipboard backend returned an unexpected image path");
      const stat = await fs.stat(resolvedImage).catch(() => undefined);
      if (!stat?.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Clipboard image is missing or exceeds the 25 MB limit");
      const relative = path.relative(this.cwd, resolvedImage);
      return { insertText: `${reference(relative)} `, notice: `Attached clipboard image: ${relative}`, attachments: [relative] };
    }
    return await this.importFiles(payload.files ?? [], attachmentDirectory);
  }

  private async importFiles(files: string[], attachmentDirectory: string): Promise<ClipboardPasteResult> {
    if (!files.length) throw new Error("The clipboard file list is empty");
    if (files.length > MAX_ATTACHMENTS) throw new Error(`Paste at most ${MAX_ATTACHMENTS} files at once`);
    const attachments: string[] = [];
    let totalBytes = 0;
    for (const [index, source] of files.entries()) {
      const stat = await fs.lstat(source).catch(() => undefined);
      if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Clipboard attachment is not a regular file: ${source}`);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`Clipboard attachment exceeds 25 MB: ${source}`);
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Clipboard attachments exceed the 50 MB total limit");
      const relativeSource = path.relative(this.cwd, source);
      const alreadyInWorkspace = relativeSource && !relativeSource.startsWith("..") && !path.isAbsolute(relativeSource);
      if (alreadyInWorkspace) {
        attachments.push(relativeSource);
        continue;
      }
      const destination = await uniqueDestination(attachmentDirectory, path.basename(source), index);
      await fs.copyFile(source, destination);
      attachments.push(path.relative(this.cwd, destination));
    }
    const references = attachments.map(reference).join(" ");
    return {
      insertText: `${references} `,
      notice: `Attached ${attachments.length} file(s): ${attachments.join(", ")}`,
      attachments,
    };
  }
}
