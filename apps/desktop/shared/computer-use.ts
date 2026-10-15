export interface ComputerWindow { handle: string; pid: number; started: string; title: string; app: string; width: number; height: number }
/** How completely the native helper could inspect the target's controls for the current frame. */
export type ControlInspection = "complete" | "partial" | "unavailable";
export interface ComputerElement { id: string; name: string; role: string; x: number; y: number; width: number; height: number; enabled: boolean }
export interface ComputerInput { kind: "click" | "scroll" | "type" | "key"; frameId: string; elementId?: string; x?: number; y?: number; delta?: number; text?: string; key?: string }
export type ComputerUseRequest = { action: "open" | "capture" | "stop" | "state" | "windows" } | { action: "select"; handle: string } | { action: "input"; input: ComputerInput };
export interface ComputerUseState {
  state: "idle" | "observing";
  path?: string;
  screenshot?: string;
  capturedAt?: string;
  windows?: ComputerWindow[];
  target?: ComputerWindow;
  frameId?: string;
  width?: number;
  height?: number;
  elements?: ComputerElement[];
  inspection?: ControlInspection;
  mode?: "manual" | "automatic";
  phase?: string;
  provider?: string;
  steps?: number;
  expiresAt?: string;
  activity?: Array<{ at: string; action: string; status: "completed" | "failed" }>;
}
