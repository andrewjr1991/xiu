function Icon({ kind }: { kind: "settings" | "overview" | "terminal" | "sidebar" }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === "settings" ? <><path d="M13 2 4 14h7l-1 8 10-13h-7l0-7Z" /></> : kind === "overview" ? <><path d="m3 5 1 1 2-2M10 5h11M3 12l1 1 2-2M10 12h11M3 19l1 1 2-2M10 19h11" /></> : kind === "terminal" ? <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></> : <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>}</svg>;
}
export function WorkspaceToolbar({ overviewVisible, collapsed, terminalVisible, disabled, onSettings, onOverview, onTerminal, onSidebar }: {
  overviewVisible: boolean; collapsed: boolean; terminalVisible: boolean; disabled: boolean;
  onSettings: () => void; onOverview: () => void; onTerminal: () => void; onSidebar: () => void;
}) {
  return <div className="workspace-toolbar" role="group" aria-label="工作区工具栏">
    <button aria-label="工具与运行设置" title="工具与运行设置" disabled={disabled} onClick={onSettings}><Icon kind="settings" /></button>
    <button aria-label={overviewVisible ? "隐藏任务概览" : "显示任务概览"} title={overviewVisible ? "隐藏任务概览" : "显示任务概览"} aria-pressed={overviewVisible} onClick={onOverview}><Icon kind="overview" /></button>
    <button aria-label="打开终端" title="打开终端面板" aria-pressed={terminalVisible} onClick={onTerminal}><Icon kind="terminal" /></button>
    <button className={collapsed ? "workbench-reopen" : "workbench-collapse"} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} title={collapsed ? "展开侧栏详情" : "收起侧栏详情"} aria-expanded={!collapsed} onClick={onSidebar}><Icon kind="sidebar" /></button>
  </div>;
}
