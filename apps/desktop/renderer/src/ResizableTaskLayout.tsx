import { useRef, useState, type CSSProperties, type ReactNode } from "react";

export function ResizableTaskLayout({ children }: { children: ReactNode[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(46.5);
  const [dragging, setDragging] = useState(false);
  const update = (clientX: number) => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect) return;
    const minimum = rect.width * .35;
    setSplit(Math.max(minimum, Math.min(rect.width - minimum, clientX - rect.left)) / rect.width * 100);
  };
  return <div ref={host} className={`task-layout resizable-task-layout${dragging ? " resizing" : ""}`}
    style={{ "--task-split": `${split}%` } as CSSProperties}>
    {children[0]}
    <div className="task-splitter" role="separator" aria-label="调整会话与工作台宽度" aria-orientation="vertical"
      aria-valuemin={35} aria-valuemax={65} aria-valuenow={Math.round(split)} tabIndex={0}
      onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event.clientX); }}
      onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); }}
      onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={() => setSplit(46.5)}
      onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setSplit((value) => Math.max(35, Math.min(65, value + (event.key === "ArrowLeft" ? -2 : 2)))); } }} />
    {children[1]}
  </div>;
}
