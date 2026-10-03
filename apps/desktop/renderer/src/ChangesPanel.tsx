import { Select } from "./Select.js";
import { useEffect, useMemo, useState } from "react";
import type { DesktopChangeRound, DesktopReviewSnapshot } from "../../shared/protocol.js";

type Report = DesktopReviewSnapshot["changes"];
type Entry = Report["changes"][number];
export function diffCounts(entry: Entry) {
  const lines = (entry.preview ?? "").split(/\r?\n/);
  return { added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length, removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length };
}

function DiffLines({ entry }: { entry: Entry }) {
  let oldLine = 0, newLine = 0;
  return <div className="diff-lines">{(entry.preview || entry.limitations.join(" · ") || "该文件没有保存文本 Diff。").split(/\r?\n/).map((line, index) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); }
    const kind = hunk ? "hunk" : line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : "context";
    const numbered = !hunk && (line.startsWith(" ") || kind !== "context");
    const left = numbered && kind !== "added" ? oldLine++ : "";
    const right = numbered && kind !== "removed" ? newLine++ : "";
    return <div className={`diff-line ${kind}`} key={index}><span>{left}</span><span>{right}</span><code>{line || " "}</code></div>;
  })}</div>;
}

interface Tree { name: string; path: string; children: Map<string, Tree>; entry?: Entry }
function TreeNodes({ node, selected, onSelect }: { node: Tree; selected?: string; onSelect: (entry: Entry) => void }) {
  return <>{[...node.children.values()].sort((a, b) => Number(Boolean(a.entry)) - Number(Boolean(b.entry)) || a.name.localeCompare(b.name)).map((child) => child.entry ? <button key={child.path} className={selected === child.path ? "selected" : ""} onClick={() => onSelect(child.entry!)} title={child.path}><span>{child.name}</span><small className="added">+{diffCounts(child.entry).added}</small><small className="removed">-{diffCounts(child.entry).removed}</small></button> : <details open key={child.path}><summary>{child.name}</summary><TreeNodes node={child} selected={selected} onSelect={onSelect} /></details>)}</>;
}

export function ChangesPanel({ report, rounds = [], selectedPath, onSelect, warningLabel = (value: string) => value }: { report?: Report; rounds?: DesktopChangeRound[]; selectedPath?: string; onSelect: (entry: Entry) => void; warningLabel?: (value: string) => string }) {
  const [round, setRound] = useState("");
  const [search, setSearch] = useState("");
  const [path, setPath] = useState(selectedPath);
  useEffect(() => { setPath(selectedPath); }, [selectedPath]);
  useEffect(() => { setRound(""); setSearch(""); }, [rounds.at(-1)?.id]);
  const displayed = round ? rounds.find((item) => item.id === round)?.report : report;
  const entries = (displayed?.changes ?? []).filter((entry) => entry.path.toLowerCase().includes(search.toLowerCase()));
  const selected = entries.find((entry) => entry.path === path) ?? entries[0];
  const tree = useMemo(() => {
    const root: Tree = { name: "", path: "", children: new Map() };
    for (const entry of entries) {
      let node = root;
      for (const segment of entry.path.replace(/\\/g, "/").split("/")) {
        const childPath = node.path ? `${node.path}/${segment}` : segment;
        if (!node.children.has(segment)) node.children.set(segment, { name: segment, path: childPath, children: new Map() });
        node = node.children.get(segment)!;
      }
      node.entry = entry;
    }
    return root;
  }, [displayed, search]);
  const counts = (displayed?.changes ?? []).reduce((sum, entry) => { const next = diffCounts(entry); return { added: sum.added + next.added, removed: sum.removed + next.removed }; }, { added: 0, removed: 0 });
  return <section className="changes-panel" aria-label="独立 Diff 面板">
    <header><Select aria-label="执行轮次" value={round} onChange={(event) => { setRound(event.target.value); setPath(undefined); }}><option value="">当前视图</option>{rounds.map((item, index) => <option key={item.id} value={item.id}>执行轮次 {index + 1} · {new Date(item.startedAt).toLocaleString()}{!item.report ? " · 无快照" : ""}</option>)}</Select><span>{displayed?.changes.length ?? 0} 个文件</span><b className="added">+{counts.added}</b><b className="removed">-{counts.removed}</b></header>
    <small className="diff-bounded-note">增删行数来自已保存的有界预览，不代表被省略部分。</small>
    {!displayed ? <p className="empty-note">该轮没有保存变更快照，不会以当前文件替代历史 Diff。</p> : <div className="changes-layout"><nav className="changes-tree" aria-label="变更文件树"><input aria-label="搜索变更文件" placeholder="搜索文件…" value={search} onChange={(event) => setSearch(event.target.value)} /><TreeNodes node={tree} selected={selected?.path} onSelect={(entry) => { setPath(entry.path); onSelect(entry); }} />{!entries.length && <p className="empty-note tree-empty">没有匹配的文件</p>}</nav><article className="changes-diff">{selected ? <><header><strong>{selected.path}</strong><small>{selected.kind}</small></header><DiffLines entry={selected} />{selected.limitations.map((message) => <p className="review-warning" key={message}>{message}</p>)}</> : <p className="empty-note">没有可展示的文件变更。</p>}</article></div>}
    {displayed?.warnings.map((warning) => <p className="review-warning" key={warning}>{warningLabel(warning)}</p>)}
  </section>;
}
