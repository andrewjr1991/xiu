import { useState } from "react";
import type { WorkspaceMcpSnapshot } from "../../shared/protocol.js";

const labels: Record<string, string> = {
  disconnected: "未连接", connected: "已连接", "permission-required": "需要确认权限",
  "auth-required": "需要 OAuth 登录（使用 CLI）", failed: "连接失败，请检查配置和服务",
  authorizing: "等待授权", refreshing: "刷新凭据中", "scope-required": "需要额外授权",
};

export function McpPanel({ snapshot, busy, disabled, error, onRefresh, onReload, onDisconnect, onApprove, onClose }: {
  snapshot?: WorkspaceMcpSnapshot; busy: boolean; disabled: boolean;
  error?: string;
  onRefresh: () => void; onReload: () => void; onDisconnect: () => void;
  onApprove: (name: string, fingerprint: string) => void; onClose: () => void;
}) {
  const [confirmation, setConfirmation] = useState<string>();
  return <div className="dialog-backdrop"><section className="mcp-panel" role="dialog" aria-modal="true" aria-label="MCP 连接与权限">
    <header><h2>MCP 连接与权限</h2><button aria-label="关闭 MCP" onClick={onClose}>×</button></header>
    {error && <p role="alert" className="error-banner">{error}</p>}
    <p>与 CLI 共用用户和项目 .xiu/mcp.json。新增、编辑和 OAuth 登录暂用 CLI；已配置的 stdio / HTTP 工具可在这里接入任务。</p>
    <p>确认清单不等于允许工具执行。调用仍受风险审批约束；打开面板不会自动启动程序。切换工作区或退出将关闭连接。</p>
    <p>授权前请核对配置文件的来源、程序及服务地址。本面板不显示可能包含凭据的参数；配置指纹绑定此次确认。</p>
    <div className="mcp-actions"><button disabled={busy} onClick={onRefresh}>刷新清单</button><button disabled={busy || disabled} onClick={onReload}>连接 / 重载</button><button disabled={busy || disabled} onClick={onDisconnect}>断开全部</button></div>
    {disabled && <p className="provider-warning">任务、终端或其他进程占用工作区时不能更改 MCP 连接。</p>}
    {!snapshot ? <p>{error ? "配置未加载，请检查后刷新。" : "正在读取配置…"}</p> : !snapshot.servers.length ? <p>尚未配置 MCP。可使用 CLI 的 /mcp add，或编辑用户 / 项目 .xiu/mcp.json。</p> : snapshot.servers.map((server) => <article key={server.name}>
      <header><strong>{server.name}</strong><span>{labels[server.state] ?? server.state} · {server.tools} 个工具</span></header>
      <small>{server.origin} · {server.transport}</small>
      <small className="mcp-fingerprint">配置清单指纹：{server.fingerprint}</small>
      <p>权限：{server.permissions.join("、")}</p>
      {server.added.length > 0 && !server.approved && <p>待确认权限：{server.added.join("、")}</p>}
      {!server.approved && (confirmation === server.fingerprint ? <div><p>我确认此来源和上述权限清单；后续连接可能启动外部程序或访问网络。</p><button disabled={busy || disabled} onClick={() => { setConfirmation(undefined); onApprove(server.name, server.fingerprint); }}>确认此权限清单</button><button onClick={() => setConfirmation(undefined)}>取消</button></div> : <button disabled={busy || disabled} onClick={() => setConfirmation(server.fingerprint)}>核对并授权</button>)}
    </article>)}
  </section></div>;
}
