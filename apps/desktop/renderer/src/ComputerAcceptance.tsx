import { useEffect, useState } from "react";
import type { DesktopComputerAcceptanceState } from "../../shared/protocol.js";

export function ComputerAcceptance({ taskId, programState, disabled, onChange }: { taskId: string; programState: string; disabled: boolean; onChange?: () => void }) {
  const [value, setValue] = useState<DesktopComputerAcceptanceState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { let current = true; setValue(undefined); void window.xiuDesktop.computerAcceptance({ taskId }).then(state => { if (current) setValue(state); }).catch(() => { if (current) setError("暂时无法读取人工验收记录，请重新打开此轮。"); }); return () => { current = false; }; }, [taskId]);
  const decide = async (decision: "passed" | "rejected") => {
    setBusy(true); setError("");
    try { setValue(await window.xiuDesktop.computerAcceptance({ taskId, decision })); onChange?.(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <section className={`computer-acceptance ${value?.decision ?? "pending"}`} aria-label="电脑操作人工验收">
    <strong>{value?.decision === "passed" ? "人工验收通过" : value?.decision === "rejected" ? "人工验收未通过" : "电脑操作结果 · 待人工验收"}</strong>
    <p>{programState === "unverified" ? "程序未获得确定性验证证据，这不等于操作失败。" : programState === "failed" ? "程序报告失败；人工判断只针对最终电脑操作结果，不覆盖失败校验。" : "程序任务已结束，模型的画面判断不等于确定性验证。"} 请检查目标应用的最终结果。</p>
    {value?.at && <small>本轮电脑操作结果 · {new Date(value.at).toLocaleString()} · 不代表程序验证通过</small>}
    {value?.eligible && <div><button disabled={disabled || busy} onClick={() => void decide("passed")}>我确认结果通过</button><button disabled={disabled || busy} onClick={() => void decide("rejected")}>结果未通过</button></div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
