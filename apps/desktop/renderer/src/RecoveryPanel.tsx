import { useEffect, useRef } from "react";
import type { DesktopProviderRecoverySnapshot } from "../../shared/provider-recovery.js";

const stateLabels: Record<string, string> = { missing: "尚无配置", current: "当前格式", "upgrade-required": "需要升级", unsupported: "不支持的格式", invalid: "配置损坏", blocked: "存储或写锁阻止读取" };

export function RecoveryPanel({ snapshot, busy, error, onRefresh, onPreview, onRecover, onCancel, onClose }: {
  snapshot?: DesktopProviderRecoverySnapshot; busy: boolean; error?: string;
  onRefresh: () => void; onPreview: (backupId: string) => void; onRecover: () => void; onCancel: () => void; onClose: () => void;
}) {
  const diagnostics = snapshot?.diagnostics;
  const preview = snapshot?.preview;
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus(); }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close);
  }, [busy, onClose]);
  return <div className="dialog-backdrop"><section className="mcp-panel" role="dialog" aria-modal="true" aria-label="Provider 配置恢复">
    <header><h2>Provider 配置恢复</h2><button ref={closeButton} disabled={busy} aria-label="关闭配置恢复" onClick={onClose}>×</button></header>
    <p>这里只显示配置版本与备份元数据，不显示渠道、密钥或本机路径。恢复前请关闭其他 Xiu CLI 和桌面客户端。</p>
    <p>CLI 与桌面需要使用匹配的升级版本。恢复成功后必须重启；不会自动恢复，也不会恢复系统凭据。</p>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {snapshot?.restartRequired ? <p role="status" className="provider-warning">{snapshot.completedAction === "keep-current" ? "中断写锁已清理，当前配置保持不变。" : "备份恢复已完成。"}请退出并重新打开 Xiu；重启前不能继续任务或更改配置。</p> : <>
      <button disabled={busy} onClick={onRefresh}>刷新只读诊断</button>
      {!diagnostics && <p className="muted">正在读取配置诊断…</p>}
      {diagnostics && <>
        <p>状态：{stateLabels[diagnostics.state] ?? diagnostics.state} · 当前格式：{diagnostics.sourceVersion ?? "未知"} · 支持格式：{diagnostics.supportedVersion}</p>
        {diagnostics.issues.length > 0 && <ul>{diagnostics.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
        {diagnostics.issues.includes("interrupted-write-can-keep-current") && <article><h3>保留当前配置</h3><p>仅清理已确认退出进程的中断写锁，不恢复备份、不复制配置。</p><button disabled={busy} onClick={() => onPreview("current")}>预览清理写锁</button></article>}
        <h3>可验证的受保护备份</h3>
        {!diagnostics.backups.length && <p>没有可用备份。当前配置不会被重置或覆盖。</p>}
        {diagnostics.backups.map((backup) => <article key={backup.id}><strong>{backup.createdAt}</strong><p>版本 {backup.sourceVersion ?? "未知"} · {backup.reason === "upgrade" ? "升级前备份" : "恢复前备份"}</p><p>{backup.id}</p><button disabled={busy || diagnostics.state === "unsupported"} onClick={() => onPreview(backup.id)}>预览此备份</button></article>)}
      </>}
      {preview && <article aria-label="配置恢复预览"><h3>{preview.action === "keep-current" ? "保留配置并清理写锁" : "恢复备份预览"}</h3>
        <p>{preview.action === "keep-current" ? `当前格式 ${preview.currentVersion ?? "尚无配置"}，保持不变` : `当前格式 ${preview.currentVersion ?? "未知"} → ${preview.sourceVersion}`} · 有效至 {preview.expiresAt}</p>
        <ul>{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        <p>点击继续后，还需要在系统确认窗口中明确确认。</p>
        <button disabled={busy} onClick={onCancel}>取消预览</button><button disabled={busy} onClick={onRecover}>继续并确认</button>
      </article>}
    </>}
  </section></div>;
}
