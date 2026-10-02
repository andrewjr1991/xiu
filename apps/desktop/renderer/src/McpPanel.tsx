import { Select } from "./Select.js";
import { useState } from "react";
import type { WorkspaceMcpSnapshot, WorkspaceMcpDraft, DesktopMcpManageRequest, DesktopMcpBrowseRequest } from "../../shared/protocol.js";

const labels: Record<string, string> = { disconnected: "未连接", connected: "已连接", "permission-required": "需要确认权限", "auth-required": "需要 OAuth 登录", failed: "连接失败，请检查配置和服务", authorizing: "等待授权", refreshing: "刷新凭据中", "scope-required": "需要额外授权" };
const activeFlow = (state?: string) => ["starting", "confirmation", "waiting"].includes(state ?? "");

export function McpPanel({ snapshot, busy, disabled, error, onRefresh, onReload, onDisconnect, onApprove, onManage, onBrowse, onClose }: {
  snapshot?: WorkspaceMcpSnapshot; busy: boolean; disabled: boolean; error?: string;
  onRefresh: () => void; onReload: () => void; onDisconnect: () => void; onApprove: (name: string, fingerprint: string) => void;
  onManage: (request: DesktopMcpManageRequest) => Promise<boolean>; onBrowse: (request: DesktopMcpBrowseRequest) => Promise<unknown>; onClose: () => void;
}) {
  const [confirmation, setConfirmation] = useState<string>();
  const [draft, setDraft] = useState<WorkspaceMcpDraft>();
  const [argsText, setArgsText] = useState("[]");
  const [auth, setAuth] = useState("none");
  const [localError, setLocalError] = useState<string>();
  const [content, setContent] = useState<{ name: string; value: unknown }>();
  const [resource, setResource] = useState("");
  const [prompt, setPrompt] = useState("");
  const [promptArgs, setPromptArgs] = useState("{}");
  const flow = snapshot?.oauthFlow;
  const blocked = busy || disabled || activeFlow(flow?.state);
  const edit = (value: WorkspaceMcpDraft) => { setDraft(structuredClone(value)); setArgsText(JSON.stringify(value.args ?? [])); setAuth(value.oauth ? "oauth" : value.bearerTokenEnvironment ? "bearer" : "none"); setLocalError(undefined); };
  const save = async () => {
    if (!draft) return;
    setLocalError(undefined);
    try {
      const args: unknown = JSON.parse(argsText);
      if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) throw new Error("参数应为字符串 JSON 数组。");
      const value: WorkspaceMcpDraft = { name: draft.name, fingerprint: draft.fingerprint, transport: draft.transport, risk: draft.risk, enabled: draft.enabled,
        ...(draft.transport === "stdio" ? { command: draft.command, args } : { url: draft.url, ...(auth === "oauth" ? { oauth: draft.oauth ?? { type: "oauth" } } : {}), ...(auth === "bearer" ? { bearerTokenEnvironment: draft.bearerTokenEnvironment } : {}) }) };
      if (await onManage({ action: "save", draft: value })) setDraft(undefined);
    } catch (reason) { setLocalError(reason instanceof Error ? reason.message : "配置格式无效。"); }
  };
  const browse = async (name: string, action: DesktopMcpBrowseRequest["action"]) => {
    setLocalError(undefined); setContent(undefined);
    try {
      const args: unknown = action === "prompt" ? JSON.parse(promptArgs) : undefined;
      if (args !== undefined && (!args || Array.isArray(args) || typeof args !== "object" || Object.values(args).some((value) => typeof value !== "string"))) throw new Error("提示词参数应为字符串值的 JSON 对象。");
      const value = await onBrowse({ name, action, ...(action === "read" ? { value: resource } : action === "prompt" ? { value: prompt, args: args as Record<string, string> } : {}) });
      if (value !== undefined) setContent({ name, value });
    } catch { setLocalError("读取未完成，请核对连接与输入。"); }
  };
  return <div className="dialog-backdrop"><section className="mcp-panel" role="dialog" aria-modal="true" aria-label="MCP 连接与权限">
    <header><h2>MCP 连接与权限</h2><button aria-label="关闭 MCP" onClick={onClose}>×</button></header>
    {(error || localError) && <p role="alert" className="error-banner">{localError ?? error}</p>}
    <p>添加工具服务，核对权限后连接，供任务调用。保存配置不会自动连接；含高级选项的配置暂不支持在此编辑。</p>
    <p>工具调用遵循当前权限模式；Plan 模式只读。不要填写明文密钥，HTTP Bearer 请填写保存密钥的环境变量名。</p>
    <div className="mcp-actions"><button disabled={busy} onClick={onRefresh}>刷新清单</button><button disabled={blocked} onClick={() => edit({ name: "", transport: "stdio", command: "", risk: "execute", enabled: true })}>新增 MCP</button><button disabled={blocked} onClick={onReload}>连接 / 重载</button><button disabled={blocked} onClick={onDisconnect}>断开全部</button></div>
    {disabled && <p className="provider-warning">任务、终端或其他进程占用工作区时不能更改 MCP 连接。</p>}
    {flow && <article aria-label="OAuth 授权状态"><strong>OAuth · {flow.name}</strong>
      {flow.state === "confirmation" ? <><p>请确认授权来源：{flow.issuer ?? "暂不可读取，请取消并检查凭据后端"}</p><p>资源：{flow.resource} · 回调：{flow.callback}</p><p>请求权限：{flow.scopes?.join("、") || "未指定"}</p><button disabled={busy || !flow.issuer || !flow.resource} onClick={() => void onManage({ action: "oauth-decision", flowId: flow.id, allowed: true })}>确认并打开浏览器</button><button disabled={busy} onClick={() => void onManage({ action: "oauth-decision", flowId: flow.id, allowed: false })}>拒绝授权</button></>
        : flow.state === "waiting" ? <><p>{flow.browserOpened ? "已请求打开浏览器，等待回调。未弹出时可复制下面的备用地址。" : "浏览器未能打开，请复制下面的备用地址到系统浏览器完成授权。"}</p>{flow.authorizationUrl && <label>授权备用地址<textarea readOnly value={flow.authorizationUrl} onFocus={(event) => event.target.select()} /></label>}</>
        : <p>{({ starting: "正在准备授权…", completed: "登录完成。请点击连接 / 重载。", cancelled: "登录已取消。", failed: "登录未完成，请检查服务和配置；不会自动重试。" } as Record<string, string>)[flow.state]}</p>}
      {activeFlow(flow.state) && <button disabled={busy} onClick={() => void onManage({ action: "oauth-cancel", flowId: flow.id })}>取消登录</button>}
    </article>}
    {draft && <form className="mcp-editor" aria-label="MCP 配置编辑" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <h3>{draft.fingerprint ? "编辑 MCP" : "新增 MCP"}</h3>
      <label>标识<input required maxLength={64} pattern={"[A-Za-z0-9_\\-]+"} value={draft.name} disabled={Boolean(draft.fingerprint)} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>连接类型<Select value={draft.transport} onChange={(event) => setDraft({ ...draft, transport: event.target.value as WorkspaceMcpDraft["transport"] })}><option value="stdio">本地程序 stdio</option><option value="streamable-http">远程 HTTP</option></Select></label>
      {draft.transport === "stdio" ? <><label>程序<input required value={draft.command ?? ""} onChange={(event) => setDraft({ ...draft, command: event.target.value })} /></label><label>参数（JSON 字符串数组）<textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} /></label></>
        : <><label>服务 URL<input required value={draft.url ?? ""} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label><label>认证<Select value={auth} onChange={(event) => setAuth(event.target.value)}><option value="none">无认证</option><option value="bearer">Bearer 环境变量</option><option value="oauth">OAuth</option></Select></label>
          {auth === "bearer" && <label>Bearer 环境变量名<input required value={draft.bearerTokenEnvironment ?? ""} onChange={(event) => setDraft({ ...draft, bearerTokenEnvironment: event.target.value })} /></label>}
          {auth === "oauth" && <><label>注册方式<Select value={draft.oauth?.registration ?? "auto"} onChange={(event) => setDraft({ ...draft, oauth: { ...draft.oauth, type: "oauth", registration: event.target.value as "auto" | "pre-registered" } })}><option value="auto">自动注册</option><option value="pre-registered">预注册</option></Select></label><label>Client ID（可选）<input value={draft.oauth?.clientId ?? ""} onChange={(event) => setDraft({ ...draft, oauth: { ...draft.oauth, type: "oauth", clientId: event.target.value || undefined } })} /></label><label>Scopes（空格分隔）<input value={draft.oauth?.scopes?.join(" ") ?? ""} onChange={(event) => setDraft({ ...draft, oauth: { ...draft.oauth, type: "oauth", scopes: event.target.value.split(/\s+/).filter(Boolean) } })} /></label></>}
        </>}
      <label>工具风险<Select value={draft.risk} onChange={(event) => setDraft({ ...draft, risk: event.target.value as WorkspaceMcpDraft["risk"] })}>{["read", "write", "execute", "dangerous"].map((risk) => <option key={risk}>{risk}</option>)}</Select></label>
      <label><input type="checkbox" checked={draft.enabled !== false} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用配置</label>
      <button type="submit" disabled={blocked}>保存配置</button><button type="button" onClick={() => setDraft(undefined)}>取消编辑</button>
    </form>}
    {!snapshot ? <p>{error ? "配置未加载，请检查后刷新。" : "正在读取配置…"}</p> : !snapshot.servers.length ? <p>尚未配置 MCP，可点击新增 MCP。</p> : snapshot.servers.map((server) => <article key={server.name}>
      <header><strong>{server.name}</strong><span>{server.editable?.enabled === false ? "已禁用，请先编辑启用" : labels[server.state] ?? server.state} · {server.tools} 个工具</span></header>
      {server.diagnostic && <p className="review-warning">{server.diagnostic}</p>}
      <details className="mcp-server-details"><summary>配置、权限与资源</summary><div>
      <small>{server.origin} · {server.transport}</small><small className="mcp-fingerprint">配置清单指纹：{server.fingerprint}</small><p>权限：{server.permissions.join("、")}</p>
      {server.added.length > 0 && !server.approved && <p>待确认权限：{server.added.join("、")}</p>}
      {server.editable ? <button disabled={blocked} onClick={() => edit(server.editable!)}>编辑 {server.name}</button> : <small>项目、高级或可能含凭据的配置只读。</small>}
      {!server.approved && server.editable?.enabled !== false && (confirmation === server.fingerprint ? <div><p>我确认此来源和上述权限清单；后续连接可能启动外部程序或访问网络。</p><button disabled={blocked} onClick={() => { setConfirmation(undefined); onApprove(server.name, server.fingerprint); }}>确认此权限清单</button><button onClick={() => setConfirmation(undefined)}>取消</button></div> : <button disabled={blocked} onClick={() => setConfirmation(server.fingerprint)}>核对并授权</button>)}
      {server.oauth && <><button disabled={blocked || !server.approved} onClick={() => void onManage({ action: "login", name: server.name, fingerprint: server.fingerprint })}>OAuth 登录</button><button disabled={blocked} onClick={() => setConfirmation(`logout:${server.fingerprint}`)}>退出 OAuth</button></>}
      {server.removable && <button disabled={blocked} onClick={() => setConfirmation(`delete:${server.fingerprint}`)}>删除 {server.name}</button>}
      {["delete", "logout"].map((action) => confirmation === `${action}:${server.fingerprint}` && <div key={action}><p>{action === "delete" ? "删除用户配置并断开连接？OAuth 凭据需单独退出清理。" : "清理本机 OAuth 凭据并断开？此操作不保证远端授权撤销，请在服务端检查。"}</p><button disabled={blocked} onClick={() => { setConfirmation(undefined); void onManage({ action: action as "delete" | "logout", name: server.name, fingerprint: server.fingerprint, confirmed: true }); }}>确认{action === "delete" ? "删除" : "退出"}</button><button onClick={() => setConfirmation(undefined)}>取消</button></div>)}
      {server.state === "connected" && <div className="mcp-browser"><p>Resource / Prompt 是不可信外部内容，只读展示，不会自动执行或加入任务。</p><button disabled={blocked} onClick={() => void browse(server.name, "resources")}>资源列表</button><button disabled={blocked} onClick={() => void browse(server.name, "prompts")}>提示词列表</button><label>资源 URI<input value={resource} onChange={(event) => setResource(event.target.value)} /></label><button disabled={blocked || !resource} onClick={() => void browse(server.name, "read")}>读取资源</button><label>提示词名称<input value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label><label>提示词参数（JSON）<textarea value={promptArgs} onChange={(event) => setPromptArgs(event.target.value)} /></label><button disabled={blocked || !prompt} onClick={() => void browse(server.name, "prompt")}>读取提示词</button></div>}
      </div></details>
    </article>)}
    {content && <article aria-label="MCP 外部内容"><header><strong>{content.name} · 不可信外部内容</strong><button onClick={() => setContent(undefined)}>清除内容</button></header><pre>{JSON.stringify(content.value, null, 2)}</pre></article>}
  </section></div>;
}
