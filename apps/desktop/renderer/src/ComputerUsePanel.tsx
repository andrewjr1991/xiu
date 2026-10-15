import { useEffect, useState } from "react";
import type { ComputerInput, ComputerUseRequest, ComputerUseState, ComputerWindow } from "../../shared/computer-use.js";

export function ComputerUsePanel({ onStart, onEnable, automatic = false, disabled = false }: { onStart?: (goal: string) => void; onEnable?: () => void; automatic?: boolean; disabled?: boolean }) {
  const [goal, setGoal] = useState("");
  const [state, setState] = useState<ComputerUseState>({ state: "idle" });
  const [windows, setWindows] = useState<ComputerWindow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [text, setText] = useState("");
  const [clickKind, setClickKind] = useState<"click" | "doubleclick" | "rightclick">("click");
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
  const granted = automatic || Boolean(state.automaticGranted);
  return <section className="review-pane computer-use-panel">
    <header><div><small>WINDOWS · 受控操作</small><h3>电脑操作</h3></div><button className="computer-stop" onClick={() => void act({action:"stop"})}>停止并撤销</button></header>
    <p>描述目标，Xiu 查找窗口并请求范围授权，然后自行观察、操作和验证。支持视觉的渠道直接看到截图并定位；不需要手动截图或填写坐标。每次操作后默认重新观察；页面加载时可短暂等待，再检查结果。</p>
    <label className="computer-goal">操作目标<textarea value={goal} maxLength={2000} disabled={disabled} onChange={event => setGoal(event.target.value)} placeholder="例如：检查已打开游戏的开始、暂停和重新开始，记录实际结果" /></label>
    <div className="computer-use-actions">{!granted && <button disabled={disabled || busy} onClick={() => void act({action:"automatic"})}>启用自动电脑操作</button>}{!granted && onEnable && <button className="secondary" disabled={disabled || busy} onClick={onEnable}>或切换完全访问</button>}{granted && !automatic && <button className="secondary" disabled={busy} onClick={() => void act({action:"automatic-revoke"})}>撤销自动授权</button>}<button disabled={disabled || !granted || !goal.trim() || !onStart} onClick={() => onStart?.(goal.trim())}>开始电脑任务</button></div>
    <p className="muted">{granted ? (automatic ? "完全访问已包含本工作区的自动电脑操作授权。" : "本工作区已开启自动电脑操作，只在内存中保留；切换工作区、更换视觉渠道或关闭应用即失效。") : "自动电脑操作是独立授权：弹窗确认一次后，本工作区任务选定目标窗口时不再逐步弹窗，不需要完全访问，也不写入设置。"}点击、双击、右键、普通文本、滚动和方向/回车/Delete 等一级按键自动执行；拖拽、Ctrl+C/V/S 等二级输入和读不到控件的位置每次单独确认；Win、Alt 组合等拒绝发送。密码、支付、删除、发布等高风险界面不支持。</p>
    <p role="status" className="computer-target">{state.target ? `${state.target.app} · ${state.phase ?? "等待观察"} · ${state.mode === "automatic" ? "自动" : "单步"} · ${state.steps ?? 0} 步` : "等待任务查找目标窗口"}</p>
    {state.provider && <p className="muted">视觉渠道：{state.provider}</p>}
    {state.screenshot && <img className="computer-observation" src={state.screenshot} alt="最近观察的已授权窗口" />}
    {state.activity?.length ? <ol className="computer-activity">{state.activity.slice(-8).map((entry, index) => <li key={`${entry.at}:${index}`}>{entry.action} · {entry.status === "completed" ? "已执行" : "失败"}</li>)}</ol> : null}
    <details className="computer-debug"><summary>手动操作与调试</summary>
    <div className="computer-use-actions"><button disabled={busy} onClick={() => void act({action:"windows"})}>刷新可用窗口</button><button disabled={busy || state.state !== "observing"} onClick={() => void act({action:"capture"})}>刷新截图</button></div>
    {!state.target && <div className="computer-window-list">{windows.length ? windows.map(target => <button disabled={busy} key={`${target.handle}:${target.started}`} onClick={() => void act({action:"select",handle:target.handle})}><strong>{target.title}</strong><small>{target.app} · {target.width} × {target.height}</small><span>选择并授权 →</span></button>) : <p className="muted">先打开要检查的应用，再刷新窗口列表。终端、系统设置、密码和支付窗口不支持。</p>}</div>}
    <p role="status" className="computer-target">{state.target ? `${state.target.app} · ${state.target.title}` : "尚未授权目标窗口"}</p>
    {error && <p role="alert">{error}</p>}
    {state.screenshot && <><button className="computer-screen" disabled={busy || !state.frameId} title="点击截图中的位置，确认后按所选方式发送一次点击" onClick={event => { const r=event.currentTarget.getBoundingClientRect(); void input({kind:clickKind,x:Math.floor((event.clientX-r.left)/r.width*state.width!),y:Math.floor((event.clientY-r.top)/r.height*state.height!)}); }}><img src={state.screenshot} alt="已授权目标窗口截图，点击定位" /></button><small>仅目标窗口 · {state.width} × {state.height} · 点击截图可定位操作</small><div className="computer-use-actions computer-click-kind" role="radiogroup" aria-label="点击方式">{(["click","doubleclick","rightclick"] as const).map(kind => <button key={kind} role="radio" aria-checked={clickKind === kind} className={clickKind === kind ? "active" : "secondary"} disabled={busy} onClick={() => setClickKind(kind)}>{({click:"左键单击",doubleclick:"左键双击",rightclick:"右键单击"})[kind]}</button>)}</div></>}
    {state.target && <div className="computer-manual"><label>输入普通文本<input value={text} maxLength={500} onChange={event=>setText(event.target.value)} placeholder="不输入密码、密钥或付款信息" /></label><button disabled={busy || !state.frameId || !text} onClick={()=>void input({kind:"type",text})}>确认输入</button><div className="computer-use-actions">{["ArrowLeft","ArrowUp","ArrowDown","ArrowRight","Space","Enter","Escape","Tab","Backspace","Delete"].map(key=><button key={key} disabled={busy || !state.frameId} onClick={()=>void input({kind:"key",key})}>{({ArrowLeft:"←",ArrowUp:"↑",ArrowDown:"↓",ArrowRight:"→",Space:"空格"} as Record<string,string>)[key]??key}</button>)}<button disabled={busy || !state.frameId} onClick={()=>void input({kind:"scroll",x:Math.floor(state.width!/2),y:Math.floor(state.height!/2),delta:-360})}>向下滚动</button></div></div>}
    </details>
    <p className="muted">Ctrl + Alt + Backspace 可停止（系统未占用时）。自动模式每个任务最多 20 分钟 / 100 次输入，单步授权 10 分钟 / 30 次；任务结束自动撤销目标窗口授权。</p>
  </section>;
}
