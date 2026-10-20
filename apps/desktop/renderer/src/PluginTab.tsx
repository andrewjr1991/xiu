import { useState } from "react";
import type { WorkspacePluginRequest, WorkspacePluginSnapshot, WorkspacePluginSummary } from "../../../../src/runtime/plugin-service.js";

const stateLabels: Record<WorkspacePluginSummary["state"], string> = { ready: "就绪", disabled: "已禁用", incompatible: "版本不兼容", invalid: "清单无效" };
const signatureLabels: Record<WorkspacePluginSummary["signature"], string> = { unsigned: "未签名", "valid-untrusted": "签名有效，发布者未信任", trusted: "签名有效，发布者已信任", invalid: "签名无效" };
const integrityLabels: Record<WorkspacePluginSummary["integrity"], string> = { unmanaged: "手动放置，无安装记录", legacy: "旧版安装记录，无包摘要", verified: "包摘要已验证", mismatch: "包摘要不一致，已失效" };
const policyLabels: Record<WorkspacePluginSummary["policy"], string> = { "not-evaluated": "未评估", allowed: "允许", blocked: "被团队策略阻止" };
const policyStateLabels: Record<WorkspacePluginSnapshot["policy"]["state"], string> = { "not-configured": "未配置", active: "已生效", invalid: "无效（插件激活失败关闭）", "not-loaded": "未加载" };
const kindLabels: Record<string, string> = { providers: "渠道", tools: "MCP 工具", skills: "Skills", workflows: "工作流" };

/**
 * Plugin inventory and lifecycle for the management panel. Approval and revocation are
 * two-step: the first click opens a confirmation that repeats the manifest the user is
 * about to authorize, the second sends `confirmed: true` with the fingerprint of exactly
 * that manifest. The main process rejects anything else.
 */
export function PluginTab({ data, unavailable, onChange }: { data?: WorkspacePluginSnapshot; unavailable: boolean; onChange(request: WorkspacePluginRequest): void }) {
  const [confirming, setConfirming] = useState<{ id: string; action: "approve" | "revoke"; fingerprint: string }>();
  const describe = (plugin: WorkspacePluginSummary) => plugin.contributions.map((item) => `${kindLabels[item.kind] ?? item.kind} ${item.count}`).join("、") || "无";
  const submit = (request: WorkspacePluginRequest) => { setConfirming(undefined); onChange(request); };
  return <>
    <p>插件只加载已授权的声明式贡献（渠道、MCP 工具、Skills、工作流），不执行插件代码。授权与 CLI 的 <code>/plugin approve</code> 写入同一份记录，绑定当前清单指纹；插件内容变化后自动失效。</p>
    {data && <p className="provider-notice">团队策略：{policyStateLabels[data.policy.state]}{data.policy.fingerprint ? ` · sha256:${data.policy.fingerprint.slice(0, 16)}…` : ""}{data.policy.problem ? ` · ${data.policy.problem}` : ""}{data.shadowed ? ` · 另有 ${data.shadowed} 个同 ID 声明被项目插件遮蔽` : ""}</p>}
    {data?.loadErrors.map((message) => <p key={message} className="provider-warning">贡献加载失败：{message}</p>)}
    {data && !data.plugins.length && <p>没有发现插件。可放置于 项目/.xiu/plugins/&lt;插件&gt;/xiu.plugin.json 或 ~/.xiu/plugins/&lt;插件&gt;/xiu.plugin.json，安装与更新仍使用 CLI 的 <code>/plugin install</code>、<code>/plugin update</code>。</p>}
    {data?.plugins.map((plugin) => {
      const approvable = !plugin.active && plugin.state === "ready" && plugin.policy !== "blocked";
      const pending = confirming?.id === plugin.id ? confirming : undefined;
      return <details key={plugin.id} className="plugin-entry" open={Boolean(pending)}>
        <summary>{plugin.name} · {plugin.version} · {plugin.scope === "project" ? "项目" : "用户"} · {stateLabels[plugin.state]} · {plugin.active ? "已授权" : "未授权"}</summary>
        <p>ID：{plugin.id}</p>
        <p>声明权限：{plugin.permissions.join("、") || "无"}</p>
        <p>声明式贡献：{describe(plugin)}</p>
        <p>签名：{signatureLabels[plugin.signature]}{plugin.publisherFingerprint ? ` · ${plugin.publisherName ?? "未命名发布者"} · sha256:${plugin.publisherFingerprint.slice(0, 16)}…` : ""}</p>
        <p>完整性：{integrityLabels[plugin.integrity]} · 团队策略：{policyLabels[plugin.policy]}</p>
        {plugin.problems.map((problem) => <p key={problem} className="provider-warning">{problem}</p>)}
        {plugin.policyProblems.map((problem) => <p key={problem} className="provider-warning">{problem}</p>)}
        <code className="mcp-fingerprint">清单指纹 sha256:{plugin.fingerprint}</code>
        <div>
          {approvable && <button disabled={unavailable} onClick={() => setConfirming({ id: plugin.id, action: "approve", fingerprint: plugin.fingerprint })}>核对并授权</button>}
          {plugin.active && <button disabled={unavailable} onClick={() => setConfirming({ id: plugin.id, action: "revoke", fingerprint: plugin.fingerprint })}>撤销授权</button>}
          {plugin.state === "disabled"
            ? <button disabled={unavailable || plugin.policy === "blocked"} onClick={() => submit({ action: "enable", id: plugin.id })}>启用</button>
            : <button disabled={unavailable} onClick={() => submit({ action: "disable", id: plugin.id })}>禁用</button>}
        </div>
        {pending?.action === "approve" && <article aria-label="插件授权确认">
          <h3>确认授权 {plugin.name}</h3>
          <p>签名：{signatureLabels[plugin.signature]}{plugin.publisherFingerprint ? ` · ${plugin.publisherName ?? "未命名发布者"} · sha256:${plugin.publisherFingerprint}` : ""}</p>
          <p>权限：{plugin.permissions.join("、") || "无"}</p>
          <p>声明式贡献：{describe(plugin)}。Xiu 不会执行插件 JavaScript；插件带来的 MCP 服务仍需在“扩展”里单独确认权限清单，工具风险审批与 Plan 只读照常执行。</p>
          <p>授权绑定清单指纹 sha256:{pending.fingerprint.slice(0, 16)}…；指纹已变化时主进程会拒绝，请刷新后重新核对。</p>
          <button disabled={unavailable} onClick={() => submit({ action: "approve", id: plugin.id, fingerprint: pending.fingerprint, confirmed: true })}>确认授权当前清单</button>{" "}
          <button disabled={unavailable} onClick={() => setConfirming(undefined)}>取消</button>
        </article>}
        {pending?.action === "revoke" && <article aria-label="插件撤销确认">
          <h3>撤销 {plugin.name} 的授权</h3>
          <p>其渠道、MCP 工具和 Skills 贡献会立即停止加载；插件文件和用户数据保留，之后可重新核对并授权。</p>
          <button disabled={unavailable} onClick={() => submit({ action: "revoke", id: plugin.id, confirmed: true })}>确认撤销授权</button>{" "}
          <button disabled={unavailable} onClick={() => setConfirming(undefined)}>取消</button>
        </article>}
      </details>;
    })}
    <p>安装、更新、卸载与恢复继续使用 CLI；禁用只写本地标记，启用不会扩大权限。</p>
  </>;
}
