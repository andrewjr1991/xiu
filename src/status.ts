import process from "node:process";

export class StatusLine {
  private timer?: NodeJS.Timeout;
  private startedAt = 0;
  private label = "";
  private frame = 0;
  private readonly frames = [".", "o", "O", "o"];

  start(label: string): void {
    this.stop();
    this.label = label;
    this.startedAt = Date.now();
    this.frame = 0;
    if (!process.stdout.isTTY) {
      console.log(`... ${label}`);
      return;
    }
    this.render();
    this.timer = setInterval(() => this.render(), 120);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (process.stdout.isTTY && this.startedAt) process.stdout.write("\r\x1b[2K");
    this.startedAt = 0;
  }

  private render(): void {
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const frame = this.frames[this.frame++ % this.frames.length];
    process.stdout.write(`\r\x1b[2K${frame} ${this.label} (${elapsed}s)`);
  }
}
