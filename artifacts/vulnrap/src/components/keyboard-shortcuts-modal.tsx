import { Keyboard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getShortcutGroups } from "@/hooks/use-keyboard-shortcuts";

interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.75rem] h-7 px-2 rounded-md border border-border/70 bg-muted/60 font-mono text-xs text-foreground shadow-sm">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsModal({
  open,
  onClose,
}: KeyboardShortcutsModalProps) {
  const groups = getShortcutGroups();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-w-2xl"
        data-testid="keyboard-shortcuts-modal"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="w-5 h-5 text-primary" />
            Keyboard shortcuts
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {groups.map((group) => (
            <section
              key={group.context}
              aria-labelledby={`group-${group.context}`}
            >
              <h3
                id={`group-${group.context}`}
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2"
              >
                {group.context}
              </h3>
              <ul className="divide-y divide-border/40 rounded-lg border border-border/50 overflow-hidden">
                {group.shortcuts.map((s, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-4 px-4 py-2.5"
                  >
                    <span className="text-sm text-foreground">
                      {s.description}
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      {s.keys.map((k, ki) => (
                        <span key={ki} className="flex items-center gap-1">
                          {ki > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {s.combiner ?? "then"}
                            </span>
                          )}
                          <Kbd>{k}</Kbd>
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <p className="text-xs text-muted-foreground pt-2">
            Press <Kbd>?</Kbd> anytime to open this reference. Shortcuts are
            disabled while typing in text fields.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
