import chalk from "chalk";

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function displayWidth(value: string): number {
  return [...value].reduce((width, character) => width + (/[^\u0000-\u00ff]/.test(character) ? 2 : 1), 0);
}

function clipDisplay(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  const selected: string[] = [];
  let used = 0;
  const ellipsisWidth = displayWidth("…");
  for (const character of value) {
    const next = /[^\u0000-\u00ff]/.test(character) ? 2 : 1;
    if (used + next > Math.max(1, width - ellipsisWidth)) break;
    selected.push(character);
    used += next;
  }
  return `${selected.join("")}…`;
}

function padDisplay(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`;
}

function inline(value: string): string {
  const protectedCode: string[] = [];
  let rendered = value.replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = protectedCode.push(chalk.cyan(code)) - 1;
    return `\u0000CODE${index}\u0000`;
  });
  rendered = rendered
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => `${chalk.underline(label)} ${chalk.dim(`(${url})`)}`)
    .replace(/\*\*([^*]+)\*\*/g, (_match, text: string) => chalk.bold(text))
    .replace(/__([^_]+)__/g, (_match, text: string) => chalk.bold(text))
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_match, text: string) => chalk.italic(text));
  return rendered.replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) => protectedCode[Number(index)] ?? "");
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderTable(header: string, body: string[]): string[] {
  const rows = [cells(header), ...body.map(cells)];
  const columns = Math.max(...rows.map((row) => row.length));
  const available = Math.max(24, Math.min(118, (process.stdout.columns || 100) - 3));
  const separatorWidth = displayWidth(" │ ");
  const perColumn = Math.max(6, Math.floor((available - Math.max(0, columns - 1) * separatorWidth) / columns));
  const widths = Array.from({ length: columns }, (_, index) => Math.min(36, perColumn, Math.max(...rows.map((row) => displayWidth(row[index] ?? "")))));
  return rows.map((row, rowIndex) => row.map((cell, index) => {
    const clipped = clipDisplay(cell, widths[index]!);
    const padded = padDisplay(clipped, widths[index]!);
    return rowIndex === 0 ? chalk.bold(inline(padded)) : inline(padded);
  }).join(chalk.dim(" │ ")).trimEnd());
}

/** Render the stable Markdown subset commonly returned by coding models without changing code content. */
export function renderTerminalMarkdown(markdown: string): string {
  const source = markdown.replace(/\r\n/g, "\n").trim();
  if (!source) return "";
  const lines = source.split("\n");
  const output: string[] = [];
  let codeFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*```/.test(line)) {
      codeFence = !codeFence;
      if (codeFence) output.push(chalk.dim("┌─ code"));
      else output.push(chalk.dim("└─"));
      continue;
    }
    if (codeFence) {
      output.push(`${chalk.dim("│ ")}${chalk.cyan(line)}`);
      continue;
    }
    if (index + 1 < lines.length && line.includes("|") && TABLE_SEPARATOR.test(lines[index + 1] ?? "")) {
      const body: string[] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index -= 1;
      output.push(...renderTable(line, body));
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      output.push(chalk.bold.cyan(inline(heading[2]!)));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      output.push(`${bullet[1]}${chalk.cyan("•")} ${inline(bullet[2]!)}`);
      continue;
    }
    const numbered = /^(\s*)(\d+\.)\s+(.+)$/.exec(line);
    if (numbered) {
      output.push(`${numbered[1]}${chalk.cyan(numbered[2]!)} ${inline(numbered[3]!)}`);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      output.push(`${chalk.dim("│")} ${chalk.dim(inline(quote[1]!))}`);
      continue;
    }
    output.push(inline(line));
  }
  return output.join("\n");
}
