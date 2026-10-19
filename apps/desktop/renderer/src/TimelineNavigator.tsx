import { useEffect, useRef, useState, type RefObject } from "react";

type Marker = { id: string; label: string; top: number; documentTop: number; target: HTMLElement };

/** A small map of the visible conversation. Positions follow rendered cards, including history. */
export function TimelineNavigator({ scrollRef, contextKey, onJump }: { scrollRef: RefObject<HTMLDivElement | null>; contextKey?: string; onJump: () => void }) {
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [active, setActive] = useState<string>();
  const current = useRef<Marker[]>([]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const content = scroll?.querySelector<HTMLElement>(".task-scroll-content");
    if (!scroll || !content) return;
    let frame = 0;
    const updateActive = () => {
      const point = scroll.scrollTop + scroll.clientHeight * .35;
      const visible = current.current.filter(marker => marker.documentTop <= point).at(-1) ?? current.current[0];
      setActive(visible?.id);
    };
    const measure = () => {
      if (scroll.scrollHeight - scroll.clientHeight < 32 || scroll.clientHeight < 130) {
        current.current = []; setMarkers([]); setActive(undefined); return;
      }
      const origin = scroll.getBoundingClientRect().top;
      const track = Math.max(1, scroll.clientHeight - 28);
      const next = [...content.querySelectorAll<HTMLElement>("[data-timeline-jump]")].filter(target => target.getClientRects().length > 0).map((target, index) => {
        const documentTop = target.getBoundingClientRect().top - origin + scroll.scrollTop;
        return {
          id: target.dataset.timelineJump ?? String(index),
          label: target.dataset.timelineLabel ?? `第 ${index + 1} 条记录`,
          top: 14 + Math.max(0, Math.min(track, documentTop / scroll.scrollHeight * track)),
          documentTop,
          target,
        };
      });
      current.current = next; setMarkers(next); updateActive();
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const mutation = new MutationObserver(schedule);
    mutation.observe(content, { childList: true, subtree: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(scroll); resize.observe(content);
    scroll.addEventListener("scroll", updateActive, { passive: true });
    schedule();
    return () => { cancelAnimationFrame(frame); mutation.disconnect(); resize.disconnect(); scroll.removeEventListener("scroll", updateActive); };
  }, [scrollRef, contextKey]);

  if (markers.length < 2) return null;
  return <nav className="timeline-jump-rail" aria-label="记录跟踪跳转">
    {markers.map((marker, index) => <button key={`${marker.id}-${index}`} type="button" className={marker.id === active ? "current" : ""} style={{ top: `${marker.top}px` }} title={marker.label} aria-label={`跳转到第 ${index + 1} 条记录：${marker.label}`} onClick={() => {
      const scroll = scrollRef.current;
      if (!scroll || !marker.target.isConnected) return;
      onJump();
      const top = marker.target.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 48;
      scroll.scrollTo({ top: Math.max(0, top), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      setActive(marker.id);
    }}><span /></button>)}
  </nav>;
}
