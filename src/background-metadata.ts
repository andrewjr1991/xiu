/** Retry only metadata reads during Windows delete-pending races, never commands or writes. */
export function readLaunchMetadata<T>(read: () => T, wait: () => void, platform = process.platform): T | undefined {
  for (let attempt = 0; ; attempt++) {
    try { return read(); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      if (platform !== "win32" || !["EPERM", "EBUSY"].includes(code ?? "") || attempt >= 3) throw error;
      wait();
    }
  }
}
