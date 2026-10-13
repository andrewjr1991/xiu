// Fallback typings for `node-pty`, used by tsconfig.test.json only when the
// desktop app's dependencies are not installed (the root CI job runs `npm ci`
// at the repository root only). It mirrors the subset of node-pty 1.x that
// apps/desktop/main/terminal-controller.ts uses; when
// apps/desktop/node_modules/node-pty exists, its real typings win.
export interface IDisposable {
  dispose(): void;
}

export interface IEvent<T> {
  (listener: (e: T) => unknown): IDisposable;
}

export interface IPty {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  readonly process: string;
  handleFlowControl: boolean;
  readonly onData: IEvent<string>;
  readonly onExit: IEvent<{ exitCode: number; signal?: number }>;
  resize(columns: number, rows: number): void;
  clear(): void;
  write(data: string | Buffer): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}
