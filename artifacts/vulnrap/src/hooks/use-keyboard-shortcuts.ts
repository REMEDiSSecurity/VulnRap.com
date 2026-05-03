import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";

export const SUBMIT_CHECK_EVENT = "vulnrap:submit-check";
export const TOGGLE_REDACTION_EVENT = "vulnrap:toggle-redaction";
export const FOCUS_TEXTAREA_EVENT = "vulnrap:focus-textarea";

export type ShortcutEntry = {
  keys: string[];
  description: string;
  /** Separator label between keys; defaults to "then" for sequences. */
  combiner?: string;
};

export type ShortcutGroup = {
  context: string;
  shortcuts: ShortcutEntry[];
};

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(
    navigator.platform || navigator.userAgent || "",
  );
}

export function modKeyLabel(): string {
  return isMac() ? "⌘" : "Ctrl";
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") {
    const type = (el as HTMLInputElement).type.toLowerCase();
    const nonText = [
      "checkbox",
      "radio",
      "button",
      "submit",
      "reset",
      "range",
      "color",
      "file",
    ];
    return !nonText.includes(type);
  }
  return false;
}

function isAnotherModalOpen(): boolean {
  if (typeof document === "undefined") return false;
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
  );
}

export function useKeyboardShortcuts(): {
  helpOpen: boolean;
  setHelpOpen: (v: boolean) => void;
} {
  const [helpOpen, setHelpOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const gPendingRef = useRef<number | null>(null);

  const closeHelp = useCallback(() => setHelpOpen(false), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      // Esc dismisses help modal (other modals/tour handle their own Esc).
      if (e.key === "Escape") {
        if (helpOpen) {
          closeHelp();
          e.preventDefault();
        }
        return;
      }

      const typing = isTypingTarget(e.target);
      const mod = e.metaKey || e.ctrlKey;
      const targetEl = e.target instanceof HTMLElement ? e.target : null;
      const isCheckTextarea =
        targetEl?.tagName.toLowerCase() === "textarea" &&
        targetEl.getAttribute("data-testid") === "input-rawtext";

      // Enter submits when the report textarea on /check is focused.
      // Shift+Enter still inserts a newline.
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !mod &&
        isCheckTextarea &&
        location.pathname.endsWith("/check")
      ) {
        window.dispatchEvent(new CustomEvent(SUBMIT_CHECK_EVENT));
        e.preventDefault();
        return;
      }

      // Cmd/Ctrl+Enter also submits from anywhere on /check (power-user alias).
      if (e.key === "Enter" && mod && location.pathname.endsWith("/check")) {
        window.dispatchEvent(new CustomEvent(SUBMIT_CHECK_EVENT));
        e.preventDefault();
        return;
      }

      // From here down, only act on bare keys without modifiers and not while typing.
      if (mod || e.altKey) return;
      if (typing) return;
      if (isAnotherModalOpen() && !helpOpen) return;

      // "?" opens reference modal (Shift+/ on most layouts).
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        setHelpOpen((v) => !v);
        e.preventDefault();
        return;
      }

      // "g" leader for navigation.
      if (e.key === "g") {
        if (gPendingRef.current) window.clearTimeout(gPendingRef.current);
        gPendingRef.current = window.setTimeout(() => {
          gPendingRef.current = null;
        }, 1200);
        e.preventDefault();
        return;
      }

      if (gPendingRef.current) {
        if (e.key === "h") {
          window.clearTimeout(gPendingRef.current);
          gPendingRef.current = null;
          navigate("/");
          e.preventDefault();
          return;
        }
        if (e.key === "c") {
          window.clearTimeout(gPendingRef.current);
          gPendingRef.current = null;
          navigate("/check");
          e.preventDefault();
          return;
        }
        // Any other key cancels the leader.
        window.clearTimeout(gPendingRef.current);
        gPendingRef.current = null;
      }

      // "r" toggles redaction on /check.
      if (e.key === "r" && location.pathname.endsWith("/check")) {
        window.dispatchEvent(new CustomEvent(TOGGLE_REDACTION_EVENT));
        e.preventDefault();
        return;
      }

      // "/" focuses the textarea on /check (without shift).
      if (e.key === "/" && location.pathname.endsWith("/check")) {
        window.dispatchEvent(new CustomEvent(FOCUS_TEXTAREA_EVENT));
        e.preventDefault();
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (gPendingRef.current) window.clearTimeout(gPendingRef.current);
    };
  }, [helpOpen, closeHelp, navigate, location.pathname]);

  return { helpOpen, setHelpOpen };
}

export function getShortcutGroups(): ShortcutGroup[] {
  const mod = modKeyLabel();
  return [
    {
      context: "Global",
      shortcuts: [
        { keys: ["?"], description: "Open this shortcuts reference" },
        { keys: ["Esc"], description: "Dismiss the open modal or tour" },
        { keys: ["g", "h"], description: "Go to home" },
        { keys: ["g", "c"], description: "Go to check report" },
      ],
    },
    {
      context: "Check page",
      shortcuts: [
        { keys: ["/"], description: "Focus the report text area" },
        {
          keys: ["Enter"],
          description:
            "Submit the report (in textarea, Shift+Enter for newline)",
        },
        {
          keys: [mod, "Enter"],
          description: "Submit the report from anywhere on /check",
          combiner: "+",
        },
        { keys: ["r"], description: "Toggle PII redaction on/off" },
      ],
    },
  ];
}
