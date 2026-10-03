import { Children, isValidElement, useEffect, useId, useRef, useState, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";

/** Shared keyboard-accessible select. The popup uses the app's typography, not OS chrome. */
export function Select({ children, value, onChange, disabled, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const options = Children.toArray(children).filter(isValidElement).map((child) => {
    const option = child.props as { value?: string; children: React.ReactNode; disabled?: boolean };
    return { value: String(option.value ?? option.children), label: option.children, disabled: option.disabled };
  });
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [bounds, setBounds] = useState({ left: 0, top: 0, width: 0, maxHeight: 280 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = options.find((option) => option.value === String(value));
  const close = () => { setOpen(false); button.current?.focus(); };
  const choose = (next: number) => {
    if (!options[next] || options[next].disabled) return;
    onChange?.({ target: { value: options[next].value }, currentTarget: { value: options[next].value } } as React.ChangeEvent<HTMLSelectElement>);
    close();
  };
  const show = () => {
    const rect = button.current!.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const height = Math.min(280, options.length * 38 + 12);
    const width = Math.min(window.innerWidth - 16, Math.max(rect.width, 320));
    setBounds({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: below >= Math.min(height, 160) ? rect.bottom + 6 : Math.max(8, rect.top - height - 6), width, maxHeight: Math.max(100, Math.min(height, below >= 160 ? below : rect.top - 14)) });
    setIndex(Math.max(0, options.findIndex((option) => option.value === String(value))));
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    menu.current?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false); };
    const hide = (event: Event) => { if (event.type === "resize" || !menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", hide); window.removeEventListener("scroll", hide, true); };
  }, [open]);
  useEffect(() => { menu.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" }); }, [index]);
  return <><button ref={button} id={props.id} type="button" className={`xiu-select ${props.className ?? ""}`} aria-label={props["aria-label"]} role="combobox" aria-expanded={open} aria-controls={id} aria-haspopup="listbox" disabled={disabled} onClick={() => open ? close() : show()} onKeyDown={(event) => { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); show(); } }}>{selected?.label ?? "请选择"}<span aria-hidden="true">⌄</span></button>{open && createPortal(<div ref={menu} id={id} role="listbox" tabIndex={-1} aria-label={props["aria-label"] ?? "选择选项"} aria-activedescendant={`${id}-${index}`} className="xiu-select-menu" style={bounds} onKeyDown={(event) => {
    if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); close(); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(index); }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); let next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1);
      while (next >= 0 && next < options.length && options[next].disabled) next += event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
      if (next >= 0 && next < options.length) setIndex(next);
    }
  }}>{options.map((option, i) => <div id={`${id}-${i}`} key={option.value} role="option" aria-selected={option.value === String(value)} aria-disabled={option.disabled} data-index={i} className={index === i ? "highlighted" : ""} onPointerMove={() => setIndex(i)} onClick={() => choose(i)}><span>{option.label}</span>{option.value === String(value) && <span>✓</span>}</div>)}</div>, document.body)}</>;
}
