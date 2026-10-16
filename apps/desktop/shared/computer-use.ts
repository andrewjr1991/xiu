export interface ComputerWindow { handle: string; pid: number; started: string; title: string; app: string; width: number; height: number }
/** How completely the native helper could inspect the target's controls for the current frame. */
export type ControlInspection = "complete" | "partial" | "unavailable";
export interface ComputerElement { id: string; name: string; role: string; x: number; y: number; width: number; height: number; enabled: boolean }
import type { ComputerInputKind } from "./computer-use-inputs.js";
/** Coordinates are in frame (image) pixels; the main process maps them back to client pixels with the frame's scale. */
export interface ComputerInput { kind: ComputerInputKind; frameId: string; elementId?: string; x?: number; y?: number; toX?: number; toY?: number; delta?: number; text?: string; key?: string; repeat?: number }
export type ComputerUseRequest = { action: "open" | "capture" | "stop" | "state" | "windows" | "automatic" | "automatic-revoke" } | { action: "select"; handle: string } | { action: "input"; input: ComputerInput };
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
  /** Frame pixels per client pixel (≤ 1); large windows are downscaled before they reach a model. */
  scale?: number;
  /** The user has enabled automatic computer operation for this workspace and vision route. */
  automaticGranted?: boolean;
  mode?: "manual" | "automatic";
  phase?: string;
  provider?: string;
  steps?: number;
  expiresAt?: string;
  activity?: Array<{ at: string; action: string; status: "completed" | "failed" }>;
}
