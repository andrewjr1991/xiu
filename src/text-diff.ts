/** Bounded comparison work; counts are independent of the display budget. */
export function textDiff(before: string, after: string) {
  const lines = (text: string) => text ? text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
  const old = lines(before), next = lines(after);
  let start = 0, endOld = old.length, endNew = next.length;
  while (start < endOld && start < endNew && old[start] === next[start]) start++;
  while (endOld > start && endNew > start && old[endOld - 1] === next[endNew - 1]) { endOld--; endNew--; }
  const a = old.slice(start, endOld), b = next.slice(start, endNew);
  const exact = (a.length + 1) * (b.length + 1) <= 2_000_000;
  const ops: Array<{ kind: string; text: string }> = [];
  if (exact) {
    const width = b.length + 1, table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] = a[i] === b[j] ? 1 + table[(i + 1) * width + j + 1] : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ kind: " ", text: a[i++] }); j++; }
      else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) ops.push({ kind: "-", text: a[i++] });
      else ops.push({ kind: "+", text: b[j++] });
    }
  } else {
    for (const text of a) ops.push({ kind: "-", text });
    for (const text of b) ops.push({ kind: "+", text });
  }
  const stats = { additions: ops.filter(op => op.kind === "+").length, deletions: ops.filter(op => op.kind === "-").length, exact };
  // Review includes all lines and full line lengths. No display clipping is
  // allowed here; upstream snapshot size/security limits still apply.
  const fullDiff = stats.additions || stats.deletions ? [
    `@@ -${old.length ? 1 : 0},${old.length} +${next.length ? 1 : 0},${next.length} @@`,
    ...old.slice(0, start).map(text => ` ${text}`),
    ...ops.map(op => `${op.kind}${op.text}`),
    ...old.slice(endOld).map(text => ` ${text}`),
  ].join("\n") : undefined;
  const output: string[] = [];
  let oldLine = start + 1, newLine = start + 1, bytes = 0, cursor = 0, truncated = false;
  const append = (line: string) => { const size = Buffer.byteLength(line + "\n"); if (bytes + size > 16 * 1024 - 32) { truncated = true; return false; } bytes += size; output.push(line); return true; };
  while (cursor < ops.length && !truncated) {
    if (ops[cursor].kind === " ") { oldLine++; newLine++; cursor++; continue; }
    const removed: string[] = [], added: string[] = [];
    while (cursor < ops.length && ops[cursor].kind !== " ") { const op = ops[cursor++]; (op.kind === "-" ? removed : added).push(op.text); }
    // Small paired hunks keep both sides visible even for large replacements.
    for (let offset = 0; offset < Math.max(removed.length, added.length) && !truncated; offset += 8) {
      const r = removed.slice(offset, offset + 8), n = added.slice(offset, offset + 8);
      if (!append(`@@ -${r.length ? oldLine : oldLine - 1},${r.length} +${n.length ? newLine : newLine - 1},${n.length} @@ (preview)`)) break;
      for (const [kind, group] of [["-", r], ["+", n]] as const) for (const line of group) {
        if (!append(`${kind} ${line.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").slice(0, 180)}`)) break;
      }
      oldLine += r.length; newLine += n.length;
    }
  }
  if (truncated) output.push("... (preview truncated)");
  return { stats, fullDiff, preview: output.length ? output.join("\n") : undefined };
}
