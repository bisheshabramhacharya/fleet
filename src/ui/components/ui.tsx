/**
 * Small controls styled after T3 Code's ui kit (MIT, T3 Tools Inc.): segmented toggles,
 * ghost/outline buttons, menus, dialogs.
 */
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/tools.ts";

type ButtonVariant = "default" | "ghost" | "outline" | "destructive";
type ButtonSize = "default" | "sm" | "xs" | "icon-sm";

export function Button({
  variant = "default",
  size = "default",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 [&_svg]:shrink-0",
        size === "default" && "h-8 px-3 text-sm [&_svg]:size-4",
        size === "sm" && "h-7 px-2.5 text-sm [&_svg]:size-3.5",
        size === "xs" && "h-6 rounded-md px-2 text-xs [&_svg]:size-3.5",
        size === "icon-sm" && "size-7 [&_svg]:size-4",
        variant === "default" && "border-transparent bg-primary text-primary-foreground hover:bg-primary/90",
        variant === "ghost" && "border-transparent text-foreground hover:bg-accent",
        variant === "outline" && "border-input bg-background text-foreground shadow-xs/5 hover:bg-accent dark:bg-input/30 dark:hover:bg-input/60",
        variant === "destructive" && "border-transparent bg-destructive text-white hover:bg-destructive/90",
        className,
      )}
      {...props}
    />
  );
}

export function InlineButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn("inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring", className)}
      {...props}
    />
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex w-fit gap-0.5 rounded-lg bg-input/40 p-0.5", className)}>
      {options.map((option) => {
        const pressed = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={pressed}
            title={option.title ?? option.label}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-6 cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              pressed
                ? "bg-background text-foreground shadow-xs/10 dark:bg-input/72"
                : "text-muted-foreground hover:bg-background/55 hover:text-foreground dark:hover:bg-input/32",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close, ref]);
}

/** A dropdown anchored under its trigger. */
export function Menu({
  trigger,
  children,
  align = "start",
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const close = () => setOpen(false);
  useDismiss(open, close, ref);
  return (
    <div ref={ref} className="relative min-w-0">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open ? (
        <div
          role="menu"
          className={cn(
            "surface-glass absolute top-full z-40 mt-1 max-h-[70vh] min-w-52 overflow-y-auto rounded-xl border border-border/60 p-1 text-sm shadow-lg",
            align === "end" ? "right-0" : "left-0",
            className,
          )}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({ children, onClick, disabled, className }: { children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn("flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent", className)}
    >
      {children}
    </button>
  );
}

export function MenuCheckbox({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onChange}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground outline-none hover:bg-accent focus-visible:bg-accent"
    >
      <span className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border", checked ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
        {checked ? (
          <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden>
            <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}

export function Dialog({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh] backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal className={cn("w-full rounded-2xl border border-border bg-popover shadow-2xl", wide ? "max-w-3xl" : "max-w-lg")}>
        <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
          <h2 className="min-w-0 truncate text-sm font-medium text-foreground">{title}</h2>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </Button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/20",
        className,
      )}
      {...props}
    />
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn("relative inline-flex h-5 w-8 shrink-0 cursor-pointer items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring", checked ? "bg-primary" : "bg-input")}
    >
      <span className={cn("block size-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-3.5" : "translate-x-0.5")} />
    </button>
  );
}

export function Meter({ percent, color, className }: { percent: number; color?: string; className?: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const tone = color ?? (clamped >= 90 ? "var(--destructive)" : clamped >= 75 ? "var(--warning)" : "var(--foreground)");
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-input/50", className)}>
      <div className="h-full rounded-full transition-[width]" style={{ width: `${clamped}%`, background: tone }} />
    </div>
  );
}

export function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-4", spinning && "animate-spin")}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Chevron() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0 text-muted-foreground">
      <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Info({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <svg viewBox="0 0 16 16" aria-label="More info" className="size-3 text-muted-foreground">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 7.2v3.6M8 5.2v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {open ? (
        <span className="surface-glass absolute bottom-full left-1/2 z-50 mb-1.5 w-64 -translate-x-1/2 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs text-foreground shadow-lg">
          {children}
        </span>
      ) : null}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

export function Section({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Notice({ tone = "muted", children }: { tone?: "muted" | "warning" | "error"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-xs",
        tone === "muted" && "border-border text-muted-foreground",
        tone === "warning" && "border-warning/30 bg-warning/8 text-warning-foreground",
        tone === "error" && "border-destructive/30 bg-destructive/8 text-destructive",
      )}
    >
      {children}
    </div>
  );
}
