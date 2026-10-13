import { useEffect, useState } from "react";
import type { ComputerInput, ComputerUseRequest, ComputerUseState, ComputerWindow } from "../../shared/computer-use.js";

export function ComputerUsePanel({ onStart, onEnable, automatic = false, disabled = false }: { onStart?: (goal: string) => void; onEnable?: () => void; automatic?: boolean; disabled?: boolean }) {
  const [goal, setGoal] = useState("");
  const [state, setState] = useState<ComputerUseState>({ state: "idle" });
  const [windows, setWindows] = useState<ComputerWindow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [text, setText] = useState("");
  const act = async (request: ComputerUseRequest) => {
    if (request.action !== "stop") setBusy(true);
    setError(undefined);
    try { const next = await window.xiuDesktop.computerUse(request); setState(next); if (next.windows) setWindows(next.windows); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    void act({action:"state"});
    const timer = setInterval(() => { void window.xiuDesktop.computerUse({action:"state"}).then(setState).catch(() => undefined); }, 2000);
    return () => { clearInterval(timer); }; // Tabs do not silently revoke the target during an Agent task.
  }, []);
  const input = (operation: Omit<ComputerInput,"frameId">) => state.frameId && act({action:"input",input:{...operation,frameId:state.frameId}});
  return <section className="review-pane computer-use-panel">
    <header><div><small>WINDOWS · 受控操作</small><h3>电脑操作</h3></div><button className="computer-stop" onClick={() => void act({action:"stop"})}>停止并撤销</button></header>
    <p>描述目标，Xiu 查找窗口并请求范围授权，然后自行观察、操作和验证。不需要手动截图或填写坐标。每次操作后默认重新观察；页面加载时可短暂等待，再检查结果。</p>
    <label className="computer-goal">操作目标<textarea value={goal} maxLength={2000} disabled={disabled} onChange={event => setGoal(event.target.value)} placeholder="例如：检查已打开游戏的开始、暂停和重新开始，记录实际结果" /></label>
    <div className="computer-use-actions">{!automatic && <button disabled={disabled} onClick={onEnable}>启用自动操作（完全访问）</button>}<button disabled={disabled || !automatic || !goal.trim() || !onStart} onClick={() => onStart?.(goal.trim())}>开始电脑任务</button></div>
    <p className="muted">完全访问确认已包含当前视觉渠道的电脑操作授权，普通任务不再重复弹窗；旧授权或渠道变化仍需确认。操作会占用前台鼠标键盘，悬浮条可暂停或停止。密码、支付、删除、发布等高风险界面不支持。</p>
    <p role="status" className="computer-target">{state.target ? `${state.target.app} · ${state.phase ?? "等待观察"} · ${state.mode === "automatic" ? "自动" : "单步"} · ${state.steps ?? 0} 步` : "等待任务查找目标窗口"}</p>
    {state.provider && <p className="muted">视觉渠道：{state.provider}</p>}
    {state.screenshot && <img className="computer-observation" src={state.screenshot} alt="最近观察的已授权窗口" />}
    {state.activity?.length ? <ol className="computer-activity">{state.activity.slice(-8).map((entry, index) => <li key={`${entry.at}:${index}`}>{entry.action} · {entry.status === "completed" ? "已执行" : "失败"}</li>)}</ol> : null}
    <details className="computer-debug"><summary>手动操作与调试</summary>
    <div className="computer-use-actions"><button disabled={busy} onClick={() => void act({action:"windows"})}>刷新可用窗口</button><button disabled={busy || state.state !== "observing"} onClick={() => void act({action:"capture"})}>刷新截图</button></div>
    {!state.target && <div className="computer-window-list">{windows.length ? windows.map(target => <button disabled={busy} key={`${target.handle}:${target.started}`} onClick={() => void act({action:"select",handle:target.handle})}><strong>{target.title}</strong><small>{target.app} · {target.width} × {target.height}</small><span>选择并授权 →</span></button>) : <p className="muted">先打开要检查的应用，再刷新窗口列表。终端、系统设置、密码和支付窗口不支持。</p>}</div>}
    <p role="status" className="computer-target">{state.target ? `${state.target.app} · ${state.target.title}` : "尚未授权目标窗口"}</p>
    {error && <p role="alert">{error}</p>}
    {state.screenshot && <><button className="computer-screen" disabled={busy || !state.frameId} title="点击截图中的位置，确认后发送一次左键单击" onClick={event => { const r=event.currentTarget.getBoundingClientRect(); void input({kind:"click",x:Math.floor((event.clientX-r.left)/r.width*state.width!),y:Math.floor((event.clientY-r.top)/r.height*state.height!)}); }}><img src={state.screenshot} alt="已授权目标窗口截图，点击定位" /></button><small>仅目标窗口 · {state.width} × {state.height} · 点击截图可定位操作</small></>}
    {state.target && <div className="computer-manual"><label>输入普通文本<input value={text} maxLength={500} onChange={event=>setText(event.target.value)} placeholder="不输入密码、密钥或付款信息" /></label><button disabled={busy || !state.frameId || !text} onClick={()=>void input({kind:"type",text})}>确认输入</button><div className="computer-use-actions">{["ArrowLeft","ArrowUp","ArrowDown","ArrowRight","Space","Enter","Escape","Tab"].map(key=><button key={key} disabled={busy || !state.frameId} onClick={()=>void input({kind:"key",key})}>{({ArrowLeft:"←",ArrowUp:"↑",ArrowDown:"↓",ArrowRight:"→",Space:"空格"} as Record<string,string>)[key]??key}</button>)}<button disabled={busy || !state.frameId} onClick={()=>void input({kind:"scroll",x:Math.floor(state.width!/2),y:Math.floor(state.height!/2),delta:-360})}>向下滚动</button></div></div>}
    </details>
    <p className="muted">Ctrl + Alt + Backspace 可停止（系统未占用时）。自动授权最多 20 分钟 / 100 次输入，单步授权 10 分钟 / 30 次；任务结束自动撤销。</p>
  </section>;
}
