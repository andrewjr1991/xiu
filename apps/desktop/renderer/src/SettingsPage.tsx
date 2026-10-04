import { useEffect, useRef, useState, type ReactNode } from "react";
import { defaultPreferences, type DesktopPreferences } from "../../shared/preferences.js";
import { Select } from "./Select.js";
const sections = ["外观", "对话与运行", "通知", "模型与渠道", "关于"] as const;
export function SettingsPage({ value, onSave, onClose, onModels, modelDisabled }: {
  value: DesktopPreferences; onSave: (next: DesktopPreferences) => Promise<void>; onClose: () => void; onModels: () => void; modelDisabled: boolean;
}) {
  const [section, setSection] = useState<typeof sections[number]>("外观");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [about, setAbout] = useState<{ version: string; packaged: boolean; notificationsSupported: boolean }>();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    void window.xiuDesktop.desktopAbout?.().then(setAbout).catch(() => setNotice("版本信息读取失败。"));
    return () => previous?.focus();
  }, []);
  const save = async (next: DesktopPreferences) => {
    setSaving(true); setNotice("");
    try { await onSave(next); setNotice("已保存"); } catch { setNotice("保存失败，设置未生效。请检查本地数据目录。 "); }
    finally { setSaving(false); }
  };
  const change = <K extends keyof DesktopPreferences>(key: K, next: DesktopPreferences[K]) => void save({ ...value, [key]: next });
  const row = (title: string, description: string, control: ReactNode) => <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div>{control}</div>;
  const toggle = (key: keyof DesktopPreferences, title: string, description: string) => row(title, description,
    <button role="switch" aria-label={title} aria-checked={value[key] === true} className="setting-switch" disabled={saving} onClick={() => change(key, !value[key])}><i /></button>);
  const resetKeys: Array<keyof DesktopPreferences> = section === "外观" ? ["theme", "fontSize", "codeSize", "density", "reducedMotion"]
    : section === "对话与运行" ? ["autoFollow", "processExpanded", "alertsExpanded", "sendKey"]
    : section === "通知" ? ["notifyComplete", "notifyFailure", "notifyApproval", "sound"] : [];
  return <section className="settings-page" role="dialog" aria-modal="true" aria-labelledby="settings-heading" onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); if (!(event.target as HTMLElement).closest('[role="listbox"]')) onClose(); }
    if (event.key === "Tab") {
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]')];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <aside className="settings-nav"><h1 id="settings-heading">设置</h1><nav aria-label="设置分类">{sections.map((name) => <button key={name} aria-current={section === name ? "page" : undefined} onClick={() => setSection(name)}>{name}</button>)}</nav><small>偏好保存在本机<br />不包含任务授权或凭证</small></aside>
    <div className="settings-main"><header><span>偏好设置</span><button ref={close} aria-label="关闭设置" onClick={onClose}>×</button></header><div className="settings-body"><h2>{section}</h2>
      {section === "外观" && <>
        <p className="settings-lead">选择适合你的亮度与阅读节奏。外观立即生效，无需重新打开工作区。</p>
        <div className="theme-options">{(["system", "light", "dark"] as const).map((theme, index) => <button key={theme} disabled={saving} aria-pressed={value.theme === theme} onClick={() => change("theme", theme)}><span className={`theme-preview theme-${theme}`}><i /><b /><em /></span>{["跟随系统", "浅色", "深色"][index]}</button>)}</div>
        <div className="settings-group">
          {row("界面字号", "调整文字大小，保留清晰的层级。", <Select aria-label="界面字号" value={value.fontSize} disabled={saving} onChange={(e) => change("fontSize", Number(e.target.value))}>{[12,14,16,18].map((n) => <option key={n} value={n}>{n} px</option>)}</Select>)}
          {row("代码字号", "用于代码、Diff 与命令输出。", <Select aria-label="代码字号" value={value.codeSize} disabled={saving} onChange={(e) => change("codeSize", Number(e.target.value))}>{[11,12,14,16].map((n) => <option key={n} value={n}>{n} px</option>)}</Select>)}
          {row("布局密度", "舒适布局保留更多留白。", <Select aria-label="布局密度" value={value.density} disabled={saving} onChange={(e) => change("density", e.target.value as DesktopPreferences["density"])}><option value="comfortable">舒适</option><option value="compact">紧凑</option></Select>)}
          {toggle("reducedMotion", "减少动画", "关闭状态闪烁与界面过渡；系统的减少动画偏好也会生效。")}
        </div>
      </>}
      {section === "对话与运行" && <><div className="settings-group">
        {toggle("autoFollow", "自动跟随最新进展", "手动上翻暂停跟随；点击回到最新进展可恢复。")}
        {toggle("processExpanded", "运行时展开过程", "只改变默认展示，随时可以手动展开或收起。")}
        {toggle("alertsExpanded", "默认展开运行提醒", "关闭时提醒折叠成一行，历史错误不会被删除。")}
        {row("发送快捷键", "输入法候选确认不会提交；Shift+Enter 始终换行。", <Select aria-label="发送快捷键" value={value.sendKey} disabled={saving} onChange={(e) => change("sendKey", e.target.value as DesktopPreferences["sendKey"])}><option value="enter">Enter 发送</option><option value="ctrl-enter">Ctrl / ⌘ + Enter 发送</option></Select>)}
      </div><details className="settings-advanced"><summary>高级：模型等待时间</summary><p>当前默认：首次正文 600 秒、流式正文停顿 180 秒、完整响应 900 秒。不是整个任务的总时限。延长等待不保证渠道正常，残缺工具不会执行，也不会自动重试。</p><p>本批暂保留启动环境变量入口：XIU_MODEL_FIRST_RESPONSE_SECONDS、XIU_MODEL_STREAM_IDLE_SECONDS、XIU_MODEL_COMPLETE_SECONDS。设置数字后重启生效。</p></details></>}
      {section === "通知" && <><p className="settings-lead">仅在 Xiu 不在前台时发送。通知不包含需求、路径、代码或模型回复，系统通知权限仍由操作系统控制。</p><div className="settings-group">
        {toggle("notifyComplete", "任务完成", "任务完成后提醒。")}{toggle("notifyFailure", "任务失败", "失败或未通过验证时提醒。")}{toggle("notifyApproval", "需要批准", "需要你返回软件作出决定时提醒。")}{toggle("sound", "通知提示音", "随系统通知播放，不独立播放音频。")}
      </div>{about && !about.notificationsSupported && <p>当前系统不支持桌面通知。</p>}</>}
      {section === "模型与渠道" && <><p className="settings-lead">沿用已有渠道、凭证与能力模型管理。设置外观不会切换模型或重置授权。</p><button className="settings-action" disabled={modelDisabled} onClick={onModels}>管理模型与渠道 →</button>{modelDisabled && <p>请先打开可信工作区，并结束正在运行的任务或配置操作。</p>}<p>完全访问仍只在本次工作区打开期间有效，不作为永久设置保存。</p></>}
      {section === "关于" && <><div className="settings-group">{row("Xiu", "本地优先的编码工作台", <span>{about?.version ?? "正在读取…"}</span>)}{row("构建类型", "Windows 本地安装器目前未签名。", <span>{about ? about.packaged ? "打包版本" : "开发版本" : "—"}</span>)}</div><p>发布说明：github.com/andrewjr1991/xiu/releases</p><p>本批尚未接入桌面自动更新检查，不会后台下载或安装。</p></>}
      {resetKeys.length > 0 && <button className="settings-reset" disabled={saving} onClick={() => { const next = { ...value }; for (const key of resetKeys) Object.assign(next, { [key]: defaultPreferences[key] }); void save(next); }}>恢复本页默认设置</button>}
      <p role="status" className="settings-save-status">{saving ? "正在保存…" : notice}</p>
    </div></div>
  </section>;
}
