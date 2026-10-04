import { useEffect, useRef, useState, type RefObject } from "react";

/** Layout changes are not user scroll intent. Never animate a moving target. */
export function useOutputFollow(ref: RefObject<HTMLDivElement | null>, context: unknown, enabled = true) {
  const following = useRef(true);
  const [paused, setPaused] = useState(false);
  const resume = () => {
    following.current = enabled;
    setPaused(!enabled);
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  };
  useEffect(() => {
    following.current = enabled;
    setPaused(!enabled);
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    let touchY: number | undefined;
    let manualScroll = false;
    const pause = () => { manualScroll = true; following.current = false; setPaused(true); };
    const pin = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (following.current) element.scrollTop = element.scrollHeight;
      });
    };
    const scroll = () => {
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 32) {
        manualScroll = false; following.current = enabled; setPaused(!enabled);
      } else if (!manualScroll) pin();
    };
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0) pause(); };
    const pointer = (event: PointerEvent) => {
      // Dragging the native scrollbar, not clicking an expandable card.
      if (event.clientX >= element.getBoundingClientRect().right - 18) pause();
    };
    const key = (event: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)
        && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) pause();
    };
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
    const touchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY;
      if (next !== undefined && touchY !== undefined && next > touchY) pause();
      touchY = next;
    };
    const observer = new ResizeObserver(pin);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener("scroll", scroll);
    element.addEventListener("wheel", wheel, { passive: true });
    element.addEventListener("pointerdown", pointer);
    element.addEventListener("keydown", key);
    element.addEventListener("touchstart", touchStart, { passive: true });
    element.addEventListener("touchmove", touchMove, { passive: true });
    pin();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      element.removeEventListener("scroll", scroll);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("pointerdown", pointer);
      element.removeEventListener("keydown", key);
      element.removeEventListener("touchstart", touchStart);
      element.removeEventListener("touchmove", touchMove);
    };
  }, [ref, context, enabled]);
  useEffect(() => {
    if (following.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });
  return { paused, resume };
}
