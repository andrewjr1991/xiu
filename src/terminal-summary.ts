import { stripVTControlCharacters } from "node:util";

/** Single-line display text only; never use this value as a saved identifier or command. */
export function plainTerminalSummary(value: string, maximum = Infinity): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, maximum);
}
