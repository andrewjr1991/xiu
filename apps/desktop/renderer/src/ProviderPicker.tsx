import { useEffect, useState } from "react";
import type { DesktopProviderCapability, DesktopProviderKind, DesktopProviderProfile, DesktopProviderSnapshot, DesktopProviderUpsertRequest } from "../../shared/protocol.js";
import { Select } from "./Select.js";

export function ProviderPicker({ settings, selectedProviderId, busy, disabled, management, credentialEditing, apiKey, notice, onChooseProvider, onDiscover, onSelect, onEditCredential, onApiKey, onSaveCredential, onCancelCredential, onTest, onUpsert, onDelete, onClose }: {
  settings?: DesktopProviderSnapshot;
  selectedProviderId?: string;
  busy: boolean;
  disabled: boolean;
  management: boolean;
  credentialEditing?: string;
  apiKey: string;
  notice?: string;
  onChooseProvider: (id: string) => void;
  onDiscover: (id: string) => void;
  onSelect: (providerId: string, model: string, capability?: DesktopProviderCapability) => void;
  onEditCredential: (id: string) => void;
  onApiKey: (value: string) => void;
  onSaveCredential: () => void;
  onCancelCredential: () => void;
  onTest: (providerId: string, model: string) => void;
  onUpsert: (request: DesktopProviderUpsertRequest) => Promise<void>;
  onDelete: (profile: DesktopProviderProfile) => Promise<void>;
  onClose: () => void;
}) {
  const blankProvider = (): DesktopProviderUpsertRequest => ({ id: "", name: "", kind: "openai-compatible", model: "", baseURL: "https://", apiKeyEnv: "", apiKey: "", contextWindow: 128000, capabilityModels: {}, features: { tools: true, vision: false, image: false, video: false, audio: false } });
  const [editing, setEditing] = useState<DesktopProviderUpsertRequest>();
  const [deleting, setDeleting] = useState<DesktopProviderProfile>();
  const [visionTesting, setVisionTesting] = useState(false);
  const [visionNotice, setVisionNotice] = useState<string>();
  const [visionProgress, setVisionProgress] = useState<Awaited<ReturnType<typeof window.xiuDesktop.visionProbeProgress>>>({ total: 0, results: [] });
  busy = busy || visionTesting;
  const testVision = async (providerId: string, model: string, allCandidates = false) => {
    setVisionTesting(true); setVisionNotice(undefined); setVisionProgress({ total: 0, results: [] });
    try {
      const result = await window.xiuDesktop.testVisionProvider({ providerId, model, allCandidates });
      setVisionNotice(result.message);
      if (result.results) setVisionProgress({ total: result.results.length, results: result.results });
    }
    catch { setVisionNotice("视觉测试无法完成，请检查工作区状态、Plan 模式或渠道配置。"); }
    finally { setVisionTesting(false); }
  };
  useEffect(() => { setVisionNotice(undefined); setVisionProgress({ total: 0, results: [] }); }, [settings]);
  useEffect(() => {
    if (!visionTesting) return;
    let live = true;
    const timer = setInterval(() => { void window.xiuDesktop.visionProbeProgress().then(progress => { if (live) setVisionProgress(progress); }).catch(() => {}); }, 500);
    return () => { live = false; clearInterval(timer); };
  }, [visionTesting]);
  useEffect(() => () => { void window.xiuDesktop.cancelVisionProbe(); }, []);
  const selected = settings?.profiles.find((profile) => profile.id === selectedProviderId) ?? settings?.profiles.find((profile) => profile.id === settings.activeProviderId);
  const credentialLabel = (profile: DesktopProviderProfile) => profile.credential.source === "system" ? "系统凭据" : profile.credential.source === "environment" ? "环境变量" : profile.credential.source === "legacy-file" ? "兼容凭据" : profile.credential.source === "not-required" ? "无需 Key" : "未配置";
  const editProfile = (profile: DesktopProviderProfile) => setEditing({ existingId: profile.id, id: profile.id, name: profile.name, kind: profile.kind as DesktopProviderKind, model: profile.selectedModel, baseURL: profile.baseURL ?? "", apiKeyEnv: profile.apiKeyEnv ?? "", apiKey: "", contextWindow: profile.contextWindow, capabilityModels: { ...profile.capabilityModels }, features: { ...profile.features } });
  const updateEditing = <K extends keyof DesktopProviderUpsertRequest>(key: K, value: DesktopProviderUpsertRequest[K]) => setEditing((current) => current ? { ...current, [key]: value } : current);
  const chooseKind = (kind: DesktopProviderKind) => setEditing((current) => {
    if (!current) return current;
    if (current.existingId) return { ...current, kind };
    const template = settings?.templates?.find((item) => item.kind === kind);
    return { ...blankProvider(), ...template, kind, apiKey: current.apiKey, apiKeyEnv: current.apiKeyEnv,
      id: current.id && !settings?.templates?.some((item) => item.id === current.id) ? current.id : template?.id ?? "",
      name: current.name && !settings?.templates?.some((item) => item.name === current.name) ? current.name : template?.name ?? "" };
  });
  const updateCapabilityModel = (capability: "vision" | "image" | "video" | "audio", value: string) => setEditing((current) => current ? { ...current, capabilityModels: { ...current.capabilityModels, [capability]: value } } : current);
  return <div className={`provider-popover${management ? " provider-manager" : " provider-selection"}`} role={management ? "region" : "dialog"} aria-label={management ? "管理模型与渠道" : "选择 Provider 和模型"}>
    <header><div><strong>{management ? "渠道配置" : "选择模型"}</strong><small>{management ? "管理渠道、凭据与模型能力" : "仅切换模型；配置请前往设置 → 模型与渠道"}</small></div><div className="provider-header-actions">{management && <button className="provider-add" disabled={busy || disabled} onClick={() => { setDeleting(undefined); setEditing(blankProvider()); }}>＋ 新增渠道</button>}{!management && <button onClick={onClose} aria-label="关闭">×</button>}</div></header>
    {!settings && <p className="muted">正在读取 Provider 配置…</p>}
    {settings?.profiles.length === 0 && !editing && <p className="provider-notice">{management ? "尚未添加渠道。点击“新增渠道”，选择 Agnes、OpenAI、本地模型或兼容服务。模板不会自动添加渠道，环境变量不是必需项。" : "尚未添加渠道，请前往设置 → 模型与渠道添加。"}</p>}
    {settings && <div className="provider-grid">
      <nav>{settings.profiles.map((profile) => <div className="provider-nav-row" key={profile.id}><button className={selected?.id === profile.id ? "selected" : ""} onClick={() => { setEditing(undefined); setDeleting(undefined); onChooseProvider(profile.id); }}><span>{profile.name}</span><small>{credentialLabel(profile)}</small></button>{management && !profile.builtin && <span><button title="编辑渠道" disabled={busy || disabled} onClick={() => editProfile(profile)}>✎</button><button title="删除渠道" disabled={busy || disabled} onClick={() => { setEditing(undefined); setDeleting(profile); }}>×</button></span>}</div>)}</nav>
      {management && editing ? <section className="provider-editor"><header><div><strong>{editing.existingId ? "编辑渠道" : "新增渠道"}</strong><small>凭据只保存在系统凭据库，不写入项目文件</small></div><button onClick={() => setEditing(undefined)}>取消</button></header><div className="provider-form">
        <label>名称<input value={editing.name} onChange={(event) => updateEditing("name", event.target.value)} placeholder="例如：公司网关" /></label>
        <label>{editing.existingId ? "标识（创建后不可修改）" : "标识"}<input value={editing.id} disabled={Boolean(editing.existingId)} title={editing.existingId ? "标识用于关联凭据，创建后不可修改" : undefined} onChange={(event) => updateEditing("id", event.target.value)} placeholder="company-gateway" /></label>
        <label>类型<Select value={editing.kind} onChange={(event) => chooseKind(event.target.value as DesktopProviderKind)}>{(["openai-compatible", "openai", "anthropic", "agnes", "ollama", "lmstudio", "vllm"] as DesktopProviderKind[]).map((kind) => <option key={kind}>{kind}</option>)}</Select></label>
        <label>默认模型<input value={editing.model} onChange={(event) => updateEditing("model", event.target.value)} placeholder="model-id" /></label>
        <label className="wide">Base URL<input value={editing.baseURL ?? ""} onChange={(event) => updateEditing("baseURL", event.target.value)} placeholder="https://api.example.com/v1" /></label>
        <label>Key 环境变量<input value={editing.apiKeyEnv ?? ""} onChange={(event) => updateEditing("apiKeyEnv", event.target.value)} placeholder="OPTIONAL_API_KEY" /></label>
        <label>上下文窗口<input type="number" min="1024" value={editing.contextWindow ?? ""} onChange={(event) => updateEditing("contextWindow", event.target.value ? Number(event.target.value) : undefined)} /></label>
        <label className="wide">API Key（可选）<input type="password" autoComplete="off" value={editing.apiKey ?? ""} onChange={(event) => updateEditing("apiKey", event.target.value)} placeholder={editing.existingId ? "留空表示不更改现有凭据" : "保存到系统凭据库"} /></label>
        <fieldset className="wide"><legend>能力</legend>{(["tools", "vision", "image", "video", "audio"] as const).map((feature) => <label key={feature}><input type="checkbox" checked={editing.features[feature]} onChange={(event) => updateEditing("features", { ...editing.features, [feature]: event.target.checked })} />{feature}</label>)}</fieldset>
        {editing.existingId && <div className="vision-model-editor wide"><button disabled={busy || disabled || !(settings.capabilityModelsByProvider[editing.existingId]?.vision.length)} onClick={() => void testVision(editing.existingId!, editing.capabilityModels?.vision ?? editing.model, true)}>测试全部视觉候选（{settings.capabilityModelsByProvider[editing.existingId]?.vision.length ?? 0} 个，可能计费）</button><small>仅测试当前已保存渠道的全部视觉候选，含能力未知的对话模型；不跨渠道。请先刷新列表。</small></div>}
        {(["vision", "image", "video", "audio"] as const).filter((capability) => editing.features[capability]).map((capability) => {
          const options = settings?.capabilityModelsByProvider?.[editing.existingId ?? editing.id]?.[capability] ?? [];
          const labels = { vision: "视觉模型", image: "生图模型", video: "视频模型", audio: "音频模型" };
          const listId = `provider-${capability}-models`;
          if (capability === "vision") {
            const value = editing.capabilityModels?.vision ?? editing.model;
            const evidenceLabel = (evidence?: string) => evidence === "declared" ? "接口声明支持视觉" : evidence === "inferred" ? "名称推测，未验证" : "能力未知，未验证";
            return <div key={capability} className="vision-model-editor wide"><span>视觉模型</span><Select aria-label="视觉模型候选列表" value={options.some((model) => model.id === value) ? value : ""} disabled={busy || disabled || visionTesting} onChange={(event) => updateCapabilityModel("vision", event.target.value)}><option value="" disabled>浏览全部视觉候选（{options.length} 个）</option>{options.map((model) => <option key={model.id} value={model.id}>{model.id} · {evidenceLabel(model.capabilityEvidence)}</option>)}</Select><input aria-label="视觉模型 ID" value={value} disabled={busy || disabled || visionTesting} onChange={(event) => updateCapabilityModel("vision", event.target.value)} placeholder="也可手动填写模型 ID" /><small>包含能力未知的对话模型；接口声明和名称推测不等于实测通过。手动填写不受列表限制，实际看图仍由渠道决定。</small>{editing.existingId ? <><button type="button" disabled={busy || disabled || visionTesting} onClick={() => onDiscover(editing.existingId!)}>刷新已保存渠道的模型</button><button type="button" disabled={busy || disabled || visionTesting || !value.trim()} onClick={() => void testVision(editing.existingId!, value)}>测试视觉能力（可能计费）</button><small>测试此模型 ID，但使用已保存渠道的地址和凭据；修改地址或 Key 后请先保存。</small></> : <small>新渠道保存后可刷新模型列表并测试视觉能力。</small>}</div>;
          }
          return <label key={capability} className="wide">{labels[capability]}<input list={listId} value={editing.capabilityModels?.[capability] ?? ""} onChange={(event) => updateCapabilityModel(capability, event.target.value)} placeholder="输入或选择模型 ID" /><datalist id={listId}>{options.map((model) => <option key={model.id} value={model.id}>{model.name ?? model.id}</option>)}</datalist></label>;
        })}
      </div><footer><button onClick={() => setEditing(undefined)}>取消</button><button className="primary-button compact" disabled={busy || disabled || !editing.id.trim() || !editing.name.trim() || !editing.model.trim()} onClick={() => void onUpsert(editing).then(() => setEditing(undefined))}>{busy ? "保存中…" : "保存渠道"}</button></footer></section>
      : management && deleting ? <section className="provider-editor provider-delete-confirm"><span className="confirmation-icon danger">⌫</span><h3>删除“{deleting.name}”？</h3><p>将删除此渠道配置和模型缓存。已保存的系统凭据不会在此操作中导出或显示。</p><div><button onClick={() => setDeleting(undefined)}>取消</button><button className="danger-button" disabled={busy || disabled} onClick={() => void onDelete(deleting).then(() => setDeleting(undefined))}>删除渠道</button></div></section>
      : selected && <section className="model-panel">
        <div className="provider-summary"><div><strong>{selected.name}</strong><small>{selected.id} · {selected.kind}</small></div><span className={selected.credential.configured ? "configured" : "missing"}>{credentialLabel(selected)}</span></div>
        {management && <><div className="provider-actions"><button disabled={busy || disabled} onClick={() => onDiscover(selected.id)}>刷新模型</button><button disabled={busy || disabled} onClick={() => onTest(selected.id, selected.selectedModel)}>测试连接</button>{selected.credential.editable && <button disabled={busy || disabled} onClick={() => onEditCredential(selected.id)}>配置 Key</button>}{!selected.builtin && <button disabled={busy || disabled} onClick={() => editProfile(selected)}>编辑渠道</button>}</div>
        <div className="provider-actions"><button disabled={busy || disabled || visionTesting} onClick={() => void testVision(selected.id, selected.capabilityModels?.vision ?? selected.selectedModel)}>测试视觉能力（可能计费）</button></div>
        <div className="provider-actions"><button disabled={busy || disabled || !settings.capabilityModelsByProvider[selected.id]?.vision.length} onClick={() => void testVision(selected.id, selected.capabilityModels?.vision ?? selected.selectedModel, true)}>测试全部视觉候选（{settings.capabilityModelsByProvider[selected.id]?.vision.length ?? 0} 个，可能计费）</button></div></>}
        {settings.discoveryError && settings.modelProviderId === selected.id && <p className="provider-warning">在线发现失败：{settings.discoveryError}</p>}
        {management && credentialEditing === selected.id && <div className="credential-form"><label htmlFor="provider-api-key">API Key</label><input id="provider-api-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => onApiKey(event.target.value)} placeholder="仅发送到主进程并保存至系统凭据库" /><div><button onClick={onCancelCredential}>取消</button><button className="primary-button compact" disabled={busy || !apiKey} onClick={onSaveCredential}>保存</button></div></div>}
        <div className="model-groups">
          <section className="model-group"><h4>对话模型</h4><div className="model-list">{(settings.modelsByProvider[selected.id] ?? []).map((model) => <button key={model.id} disabled={busy || disabled} className={settings.activeProviderId === selected.id && settings.activeModel === model.id ? "selected" : ""} onClick={() => onSelect(selected.id, model.id)}><span><strong>{model.name ?? model.id}</strong>{model.name && model.name !== model.id && <small>{model.id}</small>}</span><span>{model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K` : model.source === "api" ? "在线" : model.source === "current" ? "当前" : "内置"}</span></button>)}</div></section>
          {(["vision", "image", "video", "audio"] as const).filter((capability) => selected.features[capability]).map((capability) => {
            const labels: Record<DesktopProviderCapability, string> = { vision: "视觉模型", image: "生图模型", video: "视频模型", audio: "音频模型" };
            const models = settings.capabilityModelsByProvider[selected.id]?.[capability] ?? [];
            const activeModel = selected.capabilityModels?.[capability];
            return <section className="model-group capability-model-group" key={capability}><h4>{labels[capability]}<span>{models.length} 个</span></h4>{capability === "vision" && <p className="empty-note">包含能力未知的对话模型；候选不代表视觉实测通过。</p>}{models.length ? <div className="model-list">{models.map((model) => <button key={model.id} disabled={busy || disabled} className={activeModel === model.id ? "selected" : ""} onClick={() => onSelect(selected.id, model.id, capability)}><span><strong>{model.name ?? model.id}</strong>{model.name && model.name !== model.id && <small>{model.id}</small>}{capability === "vision" && <small>{model.capabilityEvidence === "declared" ? "接口声明支持视觉" : model.capabilityEvidence === "inferred" ? "名称推测，未验证" : "能力未知，未验证"}</small>}</span><span>{activeModel === model.id ? "当前" : model.source === "api" ? "在线" : "内置"}</span></button>)}</div> : <p className="empty-note">刷新模型后选择，或在自定义渠道中手动填写模型 ID。</p>}</section>;
          })}
        </div>
      </section>}
    </div>}
    {notice && <p className="provider-notice">{notice}</p>}
    {visionTesting && <p className="provider-notice" role="status">正在测试视觉能力… {visionProgress.total > 0 && <span>完成 {visionProgress.results.length}/{visionProgress.total} · {visionProgress.current ?? "等待确认"}</span>} <button onClick={() => void window.xiuDesktop.cancelVisionProbe()}>取消测试</button></p>}
    {visionProgress.results.length > 0 && <div className="vision-probe-results" aria-label="批量视觉测试结果">{visionProgress.results.map(result => <div key={result.model}><strong>{result.model}</strong><span>{({ passed: "通过", failed: "未通过", unknown: "无法确认", cancelled: "已取消" })[result.status]}</span><small>{result.message}</small></div>)}</div>}
    {visionNotice && <p className="provider-notice" role="status">{visionNotice}<small>仅本次测试结果，不保存为永久能力标记。</small></p>}
    {disabled && <p className="provider-warning">任务运行或其他 Xiu 进程占用工作区时不能修改 Provider 配置。</p>}
  </div>;
}
