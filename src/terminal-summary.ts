import { stripVTControlCharacters } from "node:util";

/** Strip OSC strings consistently on supported Node versions, including multiline payloads. */
export function stripTerminalControls(value: string): string {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length;) {
    const prefix = value[index] === "\u009d" ? 1 : value[index] === "\u001b" && value[index + 1] === "]" ? 2 : 0;
    if (!prefix) { index++; continue; }
    parts.push(value.slice(start, index));
    index += prefix;
    // Consume once, without rescanning the remaining text for each delimiter.
    // An unfinished OSC owns the rest of the display text too.
    while (index < value.length) {
      if (value[index] === "\u0007" || value[index] === "\u009c") { index++; break; }
      if (value[index] === "\u001b" && value[index + 1] === "\\") { index += 2; break; }
      index++;
    }
    start = index;
  }
  parts.push(value.slice(start));
  return stripVTControlCharacters(parts.join(""));
}

/** Single-line display text only; never use this value as a saved identifier or command. */
export function plainTerminalSummary(value: string, maximum = Infinity): string {
  return stripTerminalControls(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, maximum);
}
