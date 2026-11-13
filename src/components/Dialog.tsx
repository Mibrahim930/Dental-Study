"use client";
import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FOCUSABLE, NARROW_SCREEN, focusAfterClose, isTopDialog, lockScroll, nextFocus, pushDialog, removeDialog, shouldLockScroll, topDialogPanel } from "./dialogStack";

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
 * whatever had it before when it closes. If that element has left the page by then, focus goes to `returnFocus`, or the
 * dialog still open underneath, or the page's <main> (see `focusAfterClose`). A tap on the backdrop closes it too,
 * unless `dismissable` is false (then neither the backdrop nor Escape closes it: e.g. while a request it started is
 * running). `lockScroll: "narrow"` holds the page still only on a phone-sized screen (the quiz panel: on a laptop she
 * scrolls the lesson beside the corner card).
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
  returnFocus,
  lockScroll: lock = true,
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
  /** Where focus goes when it closes if the element that opened it has left the page by then. */
  returnFocus?: RefObject<HTMLElement | null>;
  /** Hold the page behind still while open: always (default), never, or only below the `sm` width ("narrow"). */
  lockScroll?: boolean | "narrow";
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
      returnFocus={returnFocus}
      lock={lock}
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
  returnFocus,
  lock,
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
  returnFocus?: RefObject<HTMLElement | null>;
  lock: boolean | "narrow";
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
  // open), focus back where it was. Runs once per opening; `initialFocus` and `lock` are read only at that moment.
  useEffect(() => {
    const id = Symbol(reactId);
    const back = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const box = panel.current;
    pushDialog(id, box);
    // "narrow" follows the screen: turning a tablet or widening the window locks or frees the page as it crosses `sm`.
    let unlock: (() => void) | null = null;
    const narrow = lock === "narrow" ? window.matchMedia(NARROW_SCREEN) : null;
    const applyLock = () => {
      const want = shouldLockScroll(lock, narrow?.matches ?? false);
      if (want && !unlock) unlock = lockScroll();
      else if (!want && unlock) {
        unlock();
        unlock = null;
      }
    };
    applyLock();
    narrow?.addEventListener("change", applyLock);
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
      narrow?.removeEventListener("change", applyLock);
      removeDialog(id);
      unlock?.();
      const now = document.activeElement;
      const lost = !now || now === document.body || !now.isConnected || !!box?.contains(now);
      const main = document.querySelector("main");
      // `returnFocus` is read now, on purpose: it names what is on the page after the close (e.g. a notice that replaced the opener).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const fallback = returnFocus?.current ?? null;
      const target = focusAfterClose({ opener: back, fallback, under: topDialogPanel(), main, lost });
      if (!target) return;
      // <main> can't take focus on its own: tabindex -1 just until focus moves on, so Tab never stops on it.
      if (target.temporary && !target.to.hasAttribute("tabindex")) {
        const el = target.to;
        el.setAttribute("tabindex", "-1");
        el.addEventListener("blur", () => el.removeAttribute("tabindex"), { once: true });
      }
      target.to.focus({ preventScroll: true });
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
