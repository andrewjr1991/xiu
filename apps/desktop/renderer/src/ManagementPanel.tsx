import { useEffect, useRef, useState } from "react";
import { Select } from "./Select.js";
import type { WorkspaceManagementSnapshot, WorkspaceManagementRequest } from "../../../../src/runtime/workspace-management.js";
import type { DesktopRuntimeConnection } from "../../shared/protocol.js";

export function ManagementPanel({ disabled, onClose, onConnection }: { disabled: boolean; onClose(): void; onConnection(value: DesktopRuntimeConnection): void }) {
  const [data, setData] = useState<WorkspaceManagementSnapshot>();
  const [tab, setTab] = useState("web");
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  const [report, setReport] = useState<{ report: string; diagnostics: string }>();
  const [provider, setProvider] = useState("searxng");
  const [endpoint, setEndpoint] = useState("");
  const [keyEnv, setKeyEnv] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [primary, setPrimary] = useState("");
  const [chain, setChain] = useState<string[]>([]);
  const [fallback, setFallback] = useState("");
  const [skillPreview, setSkillPreview] = useState<Awaited<ReturnType<typeof window.xiuDesktop.prepareSkillInstallation>>>();
  const refresh = async () => {
    const next = await window.xiuDesktop.managementSnapshot(); setData(next);
    setEndpoint(next.web.endpoint ?? ""); setProvider(next.web.provider ?? "searxng"); setEnabled(next.web.enabled);
    setKeyEnv(next.web.apiKeyEnv ?? "");
  };
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await action(); } catch { setError("操作失败或配置已变化。请刷新后重试，配置修改要求任务和终端空闲。"); }
    finally { setBusy(false); }
  };
  useEffect(() => { void perform(refresh); }, []);
  useEffect(() => () => { void window.xiuDesktop.cancelSkillInstallation().catch(() => undefined); }, []);
  useEffect(() => { if (!busy) closeRef.current?.focus(); }, [busy]);
  const save = (request: WorkspaceManagementRequest) => void perform(async () => { onConnection(await window.xiuDesktop.changeManagement(request)); await refresh(); });
  const unavailable = disabled || busy || !data;
  return <div className="dialog-backdrop"><section className="mcp-panel management-panel" role="dialog" aria-modal="true" aria-label="工具与运行设置" onKeyDown={(event) => {
    if (event.key === "Escape" && !busy && !document.querySelector('.xiu-select-menu')) { event.preventDefault(); onClose(); }
    if (event.key === "Tab") {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter((item) => item.getClientRects().length);
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header><div><h2>工具与运行设置</h2><p>修改后撤销临时完全访问权限，保留 Plan 模式。</p></div><button ref={closeRef} aria-label="关闭管理面板" disabled={busy} onClick={onClose}>×</button></header>
    <nav aria-label="管理分类">{[["web", "联网检索"], ["routing", "模型路由"], ["skills", "Skills"], ["report", "报告与诊断"]].map(([id, label]) => <button key={id} aria-pressed={tab === id} disabled={busy} onClick={() => { setTab(id!); if (id === "report") void perform(async () => setReport(await window.xiuDesktop.taskDiagnostics())); }}>{label}</button>)}<button disabled={busy} onClick={() => void perform(refresh)}>刷新</button></nav>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {tab === "web" && <><p>Agent 使用只读检索和来源证据门禁；网页标签仍与任务隔离。托管设备认证不会自动注册。</p>
      {data?.web.managed && <p className="provider-warning">当前托管配置在桌面尚未启用。保存会切换为下方公开服务。</p>}
      <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用只读联网工具</label>
      <label>服务<Select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="searxng">SearXNG</option><option value="brave">Brave</option><option value="tavily">Tavily</option></Select></label>
      <label>HTTPS 服务地址<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>
      <label>密钥环境变量名（不要填写密钥）<input value={keyEnv} onChange={(event) => setKeyEnv(event.target.value)} /></label>
      <p>保留已有域名限制、超时和代理；不会自动发送测试请求。</p>
      <button disabled={unavailable} onClick={() => save({ action: "web", revision: data!.revision, enabled, provider: provider as "searxng" | "brave" | "tavily", endpoint, ...(keyEnv ? { apiKeyEnv: keyEnv } : {}) })}>保存检索配置</button></>}
    {tab === "routing" && data && <><p>故障转移不重放工具或未知副作用。</p><label><input type="checkbox" disabled={unavailable} checked={data.routing.enabled} onChange={(event) => save({ action: "routing", revision: data.revision, enabled: event.target.checked })} />启用分阶段路由</label>
      {([["planning", "分析与规划"], ["implementation", "实现"], ["verification", "验证"]] as const).map(([phase, label]) => <label key={phase}>{label}<Select disabled={unavailable} value={data.routing.phases[phase] ?? ""} onChange={(event) => save({ action: "stage", revision: data.revision, phase, providerId: event.target.value || undefined })}><option value="">任务默认渠道</option>{data.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>)}
      <h3>备用渠道顺序</h3><Select aria-label="主渠道" value={primary} onChange={(event) => { setPrimary(event.target.value); setChain(data.providers.find((item) => item.id === event.target.value)?.fallback ?? []); }}><option value="">选择主渠道</option>{data.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>
      <ol>{chain.map((id) => <li key={id}>{data.providers.find((item) => item.id === id)?.name ?? id}<button onClick={() => setChain(chain.filter((value) => value !== id))}>移除</button></li>)}</ol>
      <Select aria-label="备用渠道" value={fallback} onChange={(event) => setFallback(event.target.value)}><option value="">选择备用渠道</option>{data.providers.filter((item) => item.id !== primary && !chain.includes(item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><button disabled={!fallback || chain.length >= 8} onClick={() => { setChain([...chain, fallback]); setFallback(""); }}>添加到末尾</button><button disabled={unavailable || !primary} onClick={() => save({ action: "fallback", revision: data.revision, providerId: primary, chain })}>保存顺序</button></>}
    {tab === "skills" && <><p>Skills 是外部指令，不代替任务审批。安装只复制本地技能包，不执行包内脚本。</p><button disabled={unavailable} onClick={() => void perform(async () => setSkillPreview(await window.xiuDesktop.prepareSkillInstallation()))}>选择本地技能包并预览</button>
      {skillPreview && <article aria-label="技能安装预览"><h3>确认安装</h3><p>将添加以下全局 Skills；不会覆盖已有技能。声明权限不替代任务审批，Plan 仍只读。</p><ul>{skillPreview.skills.map((skill) => <li key={skill.name}>{skill.name}：{skill.permissions.join("、")}</li>)}</ul><p>包摘要：{skillPreview.digest}</p><p>预览有效期：{skillPreview.expiresAt}</p><button disabled={busy} onClick={() => void perform(async () => { await window.xiuDesktop.cancelSkillInstallation(); setSkillPreview(undefined); })}>取消预览</button><button disabled={unavailable} onClick={() => void perform(async () => { const preview = skillPreview; setSkillPreview(undefined); onConnection(await window.xiuDesktop.changeManagement({ action: "skill-install", token: preview.token, revision: preview.revision, confirmed: true })); await refresh(); })}>确认安装并接受所列声明权限</button></article>}
      {!data?.skills.length && <p>没有已发现的 Skills。</p>}{data?.skills.map((item) => <details key={item.name}><summary>{item.name} · {item.scope}</summary><p>{item.description}</p><p>声明权限：{item.permissions.join("、")}</p>{item.warnings.map((warning) => <p key={warning}>{warning}</p>)}</details>)}<p>远程 Git、替换及卸载继续使用 CLI；桌面不提供隐式覆盖。</p></>}
    {tab === "report" && (report ? <><h3>执行报告</h3><pre>{report.report}</pre><h3>运行诊断</h3><pre>{report.diagnostics}</pre><p>本机有界摘要，不上传、不包含源码 Diff。</p></> : <p>尚无报告。</p>)}
  </section></div>;
}
