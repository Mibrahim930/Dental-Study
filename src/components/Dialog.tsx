"use client";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FOCUSABLE, isTopDialog, lockScroll, nextFocus, pushDialog, removeDialog } from "./dialogStack";

/** The three looks. The backdrop and the panel's place and style come with each. */
const LOOK = {
  // Bottom sheet on a phone, a card at the bottom right on wider screens (the quiz panel).
  sheet: {
    backdrop: "fixed inset-0 z-40 bg-black/30 sm:bg-black/10",
    panel:
      "fixed inset-x-0 bottom-0 z-50 flex max-h-[88vh] flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-contain rounded-t-[28px] bg-card p-5 pb-[calc(20px+env(safe-area-inset-bottom))] shadow-[0_-12px_36px_rgba(22,22,22,.18)] sm:inset-x-auto sm:right-6 sm:bottom-6 sm:max-h-[calc(100vh-48px)] sm:w-[440px] sm:rounded-[24px] sm:pb-5 sm:shadow-[0_16px_48px_rgba(22,22,22,.22)]",
  },
  // A small box in the middle of the screen ("Are you sure?"), above anything else open.
  center: {
    backdrop: "fixed inset-0 z-[60] bg-black/40",
    panel:
      "fixed inset-x-4 top-1/2 z-[70] mx-auto flex max-w-[420px] -translate-y-1/2 flex-col gap-3 rounded-[24px] bg-card p-5 text-foreground shadow-[0_16px_48px_rgba(22,22,22,.28)]",
  },
  // The whole screen, dark (a slide at full size). The content closes it on a tap beside what it shows.
  fullscreen: {
    backdrop: "fixed inset-0 z-50 bg-black/90",
    panel: "fixed inset-0 z-50",
  },
} as const;

export type DialogVariant = keyof typeof LOOK;

/**
 * One modal overlay, used for every dialog on the study pages: drawn in a portal over a backdrop, and while it's open
 * the page behind doesn't scroll, Tab stays inside it, and Escape closes it (only the top one when two are open, e.g.
 * Report over the quiz panel). Focus goes into it when it opens (to `initialFocus`, or the dialog itself) and back to
 * whatever had it before when it closes. A tap on the backdrop closes it too, unless `dismissable` is false (then
 * neither the backdrop nor Escape closes it: e.g. while a request it started is running).
 *
 * `className`, when given, replaces the variant's panel classes (place and look); the backdrop stays the variant's.
 * `data-*` attributes go on the element that holds both the backdrop and the panel.
 */
export function Dialog({
  open,
  onClose,
  label,
  variant = "center",
  role = "dialog",
  initialFocus,
  className,
  dismissable = true,
  children,
  "aria-describedby": describedBy,
  ...data
}: {
  open: boolean;
  onClose: () => void;
  /** What a screen reader announces for it. */
  label: string;
  variant?: DialogVariant;
  role?: "dialog" | "alertdialog";
  /** Where focus goes when it opens (default: the dialog itself). */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  dismissable?: boolean;
  children: ReactNode;
  "aria-describedby"?: string;
  [data: `data-${string}`]: string | boolean | undefined;
}) {
  if (!open || typeof document === "undefined") return null;
  return (
    <OpenDialog
      onClose={onClose}
      label={label}
      variant={variant}
      role={role}
      initialFocus={initialFocus}
      className={className}
      dismissable={dismissable}
      describedBy={describedBy}
      data={data}
    >
      {children}
    </OpenDialog>
  );
}

/** The dialog while it's open: mounting it is opening it, unmounting it is closing it. */
function OpenDialog({
  onClose,
  label,
  variant,
  role,
  initialFocus,
  className,
  dismissable,
  describedBy,
  data,
  children,
}: {
  onClose: () => void;
  label: string;
  variant: DialogVariant;
  role: "dialog" | "alertdialog";
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  dismissable: boolean;
  describedBy?: string;
  data: Record<string, string | boolean | undefined>;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const live = useRef({ onClose, dismissable });
  useEffect(() => {
    live.current = { onClose, dismissable };
  });

  // Opening: on top of the stack, page locked, focus in. Closing: off the stack, page unlocked (once no other dialog is
  // open), focus back where it was. Runs once per opening; `initialFocus` is read only at that moment.
  useEffect(() => {
    const id = Symbol(reactId);
    const back = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    pushDialog(id);
    const unlock = lockScroll();
    (initialFocus?.current ?? panel.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (!isTopDialog(id)) return;
      if (e.key === "Escape") {
        // Handled here, so nothing under this dialog (another dialog, a page shortcut) also acts on it.
        e.preventDefault();
        e.stopPropagation();
        if (live.current.dismissable) live.current.onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
      const current = document.activeElement instanceof HTMLElement && panel.current.contains(document.activeElement) ? document.activeElement : null;
      if (items.length === 0) {
        e.preventDefault();
        panel.current.focus();
        return;
      }
      const to = nextFocus(items, current, e.shiftKey);
      if (to) {
        e.preventDefault();
        to.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      removeDialog(id);
      unlock();
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
    // Once per opening, on purpose: a new `initialFocus` while open must not steal focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const look = LOOK[variant];
  return createPortal(
    <div {...data}>
      <div className={look.backdrop} onClick={() => live.current.dismissable && live.current.onClose()} aria-hidden />
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-label={label}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={`outline-none ${className ?? look.panel}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
