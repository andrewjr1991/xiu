import type { RuntimeSubagentCard } from "../../../../src/runtime/protocol.js";

export function AgentAvatar({ agent }: { agent: RuntimeSubagentCard }) {
  const roles: Record<string, [string, string]> = { explorer: ["调", "调查员"], reviewer: ["审", "审查员"], implementer: ["工", "实现员"], tester: ["验", "测试员"] };
  const [glyph, title] = roles[agent.role] ?? ["助", "智能体"];
  let hash = 0;
  for (const char of agent.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return <span className={`agent-avatar avatar-${hash % 6}`} role="img" aria-label={`${title}头像`} title={title}><span>{glyph}</span><i className={`agent-status ${agent.status}`} aria-hidden="true" /></span>;
}
