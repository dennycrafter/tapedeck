"use client";

/**
 * Small shared pieces (SPEC 10): class strings for the three button
 * weights, a modal that closes on Escape and outside click, a confirm
 * dialog, and an anchored popover menu with full keyboard support.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";

export const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-silver";
/** Main action, accent (one per screen). */
export const BTN_PRIMARY = `inline-flex items-center justify-center gap-1.5 rounded-btn bg-accent px-4 py-2 text-sm font-semibold text-bg hover:bg-accent-ink disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`;
/** Secondary: plain outline. */
export const BTN_SECONDARY = `inline-flex items-center justify-center gap-1.5 rounded-btn border border-line px-3 py-2 text-sm font-medium text-silver hover:border-muted hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS}`;
/** Tertiary: quiet text button. */
export const BTN_QUIET = `inline-flex items-center gap-1.5 rounded-btn px-2 py-1.5 text-sm text-muted hover:text-fg disabled:opacity-60 ${FOCUS}`;
export const ICON_BTN = `inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-btn text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40 ${FOCUS}`;
export const INPUT = `w-full rounded-btn border border-line bg-bg px-3 py-2 text-sm placeholder:text-muted focus:outline-2 focus:outline-offset-2 focus:outline-silver`;
export const POPUP = "rounded-box border border-line bg-surface-2 shadow-[0_6px_16px_rgba(0,0,0,0.3)]";

/** Escape closes (SPEC 10: Escape closes every modal). */
export function useEscape(onEscape: () => void, active = true): void {
  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onEscape();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape, active]);
}

interface ModalProps {
  title: string;
  onClose(): void;
  children: ReactNode;
  testId?: string;
  /** Hide the visible title (still labels the dialog). */
  hideTitle?: boolean;
  widthClass?: string;
}

export function Modal({ title, onClose, children, testId, hideTitle, widthClass = "max-w-md" }: ModalProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  useEscape(onClose);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>(
      "input, textarea, select, button:not([data-modal-close]), [href]",
    );
    (first ?? panel.current)?.focus();
    return () => previous?.focus?.();
  }, []);
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:items-center sm:pb-0"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        className={`w-full ${widthClass} p-4 ${POPUP} outline-none`}
      >
        <div className={`flex items-center justify-between gap-3 ${hideTitle ? "sr-only" : ""}`}>
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" data-modal-close className={ICON_BTN}>
            <CloseIcon />
          </button>
        </div>
        <div className={hideTitle ? "" : "mt-3"}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmProps {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm(): Promise<void> | void;
  onClose(): void;
}

/** Confirm before deleting (SPEC 8.6). Stays open with the error if it fails. */
export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onClose }: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose} testId="confirm-dialog">
      <p className="text-sm text-muted">{body}</p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-bad">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={BTN_SECONDARY} data-testid="confirm-cancel">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          data-testid="confirm-ok"
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setBusy(false);
            }
          }}
          className={`inline-flex items-center rounded-btn border border-bad/50 px-3 py-2 text-sm font-semibold text-bad hover:bg-bad/10 disabled:opacity-60 ${FOCUS}`}
        >
          {busy ? "Working..." : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export interface MenuItem {
  label: string;
  onSelect(): void;
  testId?: string;
  danger?: boolean;
  disabled?: boolean;
}

interface MenuProps {
  anchor: RefObject<HTMLElement | null>;
  items: (MenuItem | "divider")[];
  onClose(): void;
  label: string;
  testId?: string;
}

/**
 * Popover menu anchored to a button. Arrow keys, Home/End and first letter
 * move; Enter selects; Escape, Tab and an outside click close. Rendered in a
 * portal so it is never clipped by a scrolling list.
 */
export function Menu({ anchor, items, onClose, label, testId = "song-menu" }: MenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEscape(onClose);

  useLayoutEffect(() => {
    const button = anchor.current;
    const menu = panel.current;
    if (!button || !menu) return;
    const rect = button.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const gap = 6;
    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - gap - height);
    let left = rect.right - width;
    left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
    setPos({ top, left });
  }, [anchor]);

  const buttons = useCallback(
    () => Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button[role=menuitem]:not(:disabled)") ?? []),
    [],
  );

  useEffect(() => {
    if (pos) buttons()[0]?.focus();
  }, [pos, buttons]);

  useEffect(() => {
    function onDown(event: MouseEvent | TouchEvent) {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [anchor, onClose]);

  function onKeyDown(event: React.KeyboardEvent) {
    const list = buttons();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (event.key === "ArrowDown") focus(index + 1);
    else if (event.key === "ArrowUp") focus(index - 1);
    else if (event.key === "Home") focus(0);
    else if (event.key === "End") focus(list.length - 1);
    else if (event.key === "Tab") onClose();
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      const letter = event.key.toLowerCase();
      const start = index + 1;
      for (let step = 0; step < list.length; step++) {
        const candidate = list[(start + step) % list.length];
        if (candidate?.textContent?.trim().toLowerCase().startsWith(letter)) {
          candidate.focus();
          break;
        }
      }
    } else return;
    event.preventDefault();
  }

  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label={label}
      data-testid={testId}
      onKeyDown={onKeyDown}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className={`fixed z-[60] min-w-52 py-1 ${POPUP}`}
    >
      {items.map((item, i) =>
        item === "divider" ? (
          <div key={`d${i}`} className="my-1 h-px bg-line" role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            data-testid={item.testId}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={`block w-full px-3 py-2 text-left text-sm hover:bg-line focus:bg-line focus:outline-none disabled:opacity-50 ${
              item.danger ? "text-bad" : "text-fg"
            }`}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Section heading with an optional "Show all" link on the right. */
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="text-lg font-bold">{title}</h2>
      {action}
    </div>
  );
}
