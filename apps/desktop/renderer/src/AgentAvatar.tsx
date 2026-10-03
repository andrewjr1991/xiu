import type { RuntimeSubagentCard } from "../../../../src/runtime/protocol.js";

export function AgentAvatar({ agent }: { agent: RuntimeSubagentCard }) {
  const roles: Record<string, string> = { explorer: "调查员", reviewer: "审查员", implementer: "实现员", tester: "测试员" };
  const title = roles[agent.role] ?? "智能体";
  let hash = 0;
  for (const char of agent.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const patterns = [
    <><circle cx="10" cy="10" r="5" /><path d="m14 14 5 5M8 10h4M10 8v4" /></>,
    <><path d="m12 3 8 4v5c0 5-8 9-8 9S4 17 4 12V7z" /><path d="m8 12 3 3 5-6" /></>,
    <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" /></>,
    <><path d="M9 3h6m-5 0v7l-6 9a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-9V3M7 16h10" /><circle cx="12" cy="13" r="1" /></>,
    <><path d="m12 3 2.5 5 5.5 1-4 4 1 6-5-3-5 3 1-6-4-4 5.5-1z" /></>,
    <><circle cx="12" cy="12" r="8" /><path d="m15 8-2 6-5 2 2-6z" /></>,
    <><path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10" /></>,
    <><rect x="4" y="6" width="16" height="14" rx="4" /><path d="M12 2v4M8 11v2m8-2v2m-7 4h6M1 11h3m16 0h3" /></>,
  ];
  // Stable identity across transcript, overview and inspector; same-role agents
  // still have different silhouettes rather than identical role initials.
  return <span className={`agent-avatar avatar-${hash % 6}`} role="img" aria-label={`${title}头像`} title={`${title} · ${agent.title}`}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{patterns[hash % patterns.length]}</svg><i className={`agent-status ${agent.status}`} aria-hidden="true" /></span>;
}
