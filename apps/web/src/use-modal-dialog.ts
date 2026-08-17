import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let lastFocusedOutsideDialog: HTMLElement | null = null;

if (typeof document !== "undefined") {
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('[aria-modal="true"]') === null) {
      lastFocusedOutsideDialog = target;
    }
  });
}

export function useModalDialog<T extends HTMLElement>(onClose: (() => void) | null, active = true) {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return;
    const currentDialog = dialogRef.current;
    if (currentDialog === null) return;
    const dialog: T = currentDialog;

    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousFocus = dialog.contains(activeElement) ? lastFocusedOutsideDialog : activeElement;
    const focusable = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.getAttribute("aria-hidden") !== "true",
      );

    dialog.tabIndex = -1;
    if (!dialog.contains(document.activeElement)) {
      (focusable()[0] ?? dialog).focus({ preventScroll: true });
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && closeRef.current !== null) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];
      if (first === undefined || last === undefined) return;
      const activeControl =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (activeControl === null || !controls.includes(activeControl)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      } else if (event.shiftKey && activeControl === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && activeControl === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected === true) previousFocus.focus({ preventScroll: true });
    };
  }, [active]);

  return dialogRef;
}
