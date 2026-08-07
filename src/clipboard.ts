import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

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
  kind: "text" | "files" | "image" | "empty";
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

const POWERSHELL_CLIPBOARD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$files = @(Get-Clipboard -Format FileDropList -ErrorAction SilentlyContinue | Where-Object { $null -ne $_ })
if ($files.Count -gt 0) {
  $paths = @($files | ForEach-Object {
    if ($null -ne $_.FullName -and $_.FullName.Length -gt 0) { [string]$_.FullName }
    else { [string]$_ }
  })
  $result = @{ kind = 'files'; files = @($paths) }
} else {
  $image = Get-Clipboard -Format Image -ErrorAction SilentlyContinue
  if ($null -ne $image) {
    $result = @{ kind = 'image' }
  } else {
    $text = Get-Clipboard -Raw -ErrorAction SilentlyContinue
    if ($null -eq $text) { $result = @{ kind = 'empty' } }
    else { $result = @{ kind = 'text'; text = [string]$text }
  }
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
  throw new Error("PowerShell clipboard reader returned an invalid response");
}

class PowerShellClipboardBackend implements ClipboardBackend {
  private availability?: Promise<boolean>;

  supportsRightClick(): Promise<boolean> {
    if (process.platform !== "win32") return Promise.resolve(false);
    this.availability ??= execFileAsync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand",
      encodedPowerShell("$ErrorActionPreference = 'Stop'; $null = Get-Command Get-Clipboard -ErrorAction Stop; $null = Get-Clipboard -Raw -ErrorAction Stop"),
    ], { windowsHide: true, timeout: 5_000, maxBuffer: 256 * 1024 }).then(() => true).catch(() => false);
    return this.availability;
  }

  async read(imageOutputPath: string): Promise<ClipboardPayload> {
    if (!(await this.supportsRightClick())) throw new Error("Windows Get-Clipboard is unavailable or blocked by policy");
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
      throw new Error(`Could not read the clipboard with Windows PowerShell: ${error instanceof Error ? error.message : String(error)}`);
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
    if (await this.native.supportsRightClick?.()) return true;
    return await this.imageHelper.hasCachedHelper?.() ?? false;
  }

  async read(imageOutputPath: string): Promise<ClipboardPayload> {
    let nativeFailure: unknown;
    try {
      const payload = await this.native.read(imageOutputPath);
      if (payload.kind !== "image" || payload.imagePath) return payload;
      try {
        return await this.imageHelper.read(imageOutputPath);
      } catch (error) {
        throw new Error(`The clipboard contains a bitmap, but the optional clipboard helper is blocked. Save the image as a file and paste or reference its path instead. ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      nativeFailure = error;
      if (error instanceof Error && error.message.includes("clipboard contains a bitmap")) throw error;
    }
    try {
      return await this.imageHelper.read(imageOutputPath);
    } catch (helperFailure) {
      throw new Error(`No permitted Windows clipboard backend is available. Native reader: ${nativeFailure instanceof Error ? nativeFailure.message : String(nativeFailure)}. Helper: ${helperFailure instanceof Error ? helperFailure.message : String(helperFailure)}`);
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

  constructor(private readonly cwd: string, backend?: ClipboardBackend) {
    this.backend = backend ?? new WindowsClipboardBackend();
  }

  async supportsRightClickPaste(): Promise<boolean> {
    return await this.backend.supportsRightClick?.() ?? true;
  }

  async paste(): Promise<ClipboardPasteResult> {
    const attachmentDirectory = path.join(this.cwd, ".xiu", "attachments");
    await fs.mkdir(attachmentDirectory, { recursive: true });
    const imageOutput = path.join(attachmentDirectory, `${timestamp()}-clipboard.png`);
    const payload = await this.backend.read(imageOutput);
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
