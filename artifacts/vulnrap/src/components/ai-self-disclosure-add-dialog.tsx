import { useState, useCallback, useEffect } from "react";
import { customFetch, ApiError } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

export interface AiSelfDisclosureAddDialogProps {
  open: boolean;
  suggestedText: string;
  suggestionId: number | null;
  onSaved: () => void;
  onCancel: () => void;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
}

export default function AiSelfDisclosureAddDialog({
  open,
  suggestedText,
  suggestionId,
  onSaved,
  onCancel,
}: AiSelfDisclosureAddDialogProps) {
  const { toast } = useToast();
  const [id, setId] = useState("");
  const [pattern, setPattern] = useState("");
  const [flags, setFlags] = useState("i");
  const [rationale, setRationale] = useState("");
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPattern(escapeRegex(suggestedText));
      setId(slugify(suggestedText) || "phrase");
      setFlags("i");
      setRationale(
        suggestionId != null
          ? `Approved from user suggestion #${suggestionId}`
          : "",
      );
      setSaving(false);
      setValidationError(null);
    }
  }, [open, suggestedText, suggestionId]);

  const regexValid = useCallback(() => {
    if (!pattern.trim()) return false;
    try {
      new RegExp(pattern, flags || "i");
      return true;
    } catch {
      return false;
    }
  }, [pattern, flags]);

  const idValid = ID_PATTERN.test(id.trim());

  const canSave = idValid && regexValid() && !saving;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setValidationError(null);
    try {
      await customFetch(
        "/api/feedback/calibration/ai-self-disclosure-phrases",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: id.trim(),
            pattern,
            flags: flags || undefined,
            rationale: rationale.trim() || undefined,
          }),
        },
      );
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const body = (err.data ?? {}) as Record<string, unknown>;
        setValidationError(
          typeof body.error === "string" ? body.error : "Validation failed.",
        );
      } else if (err instanceof ApiError && err.status === 401) {
        setValidationError(
          "Reviewer token rejected — see the calibration auth banner.",
        );
      } else {
        toast({
          title: "Failed to save",
          description: "Could not add the AI self-disclosure phrase.",
          variant: "destructive",
        });
      }
    } finally {
      setSaving(false);
    }
  }, [canSave, id, pattern, flags, rationale, onSaved, toast]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent data-testid="ai-self-disclosure-add-dialog">
        <DialogHeader>
          <DialogTitle>Add AI Self-Disclosure Phrase</DialogTitle>
          <DialogDescription>
            Define a regex pattern for the suggested phrase. The pattern will be
            added to the live AI self-disclosure detection list.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              ID
            </Label>
            <input
              data-testid="ai-disclosure-id"
              className={cn(
                "w-full rounded-lg glass-card p-2.5 text-sm bg-transparent border focus:outline-none transition-colors font-mono",
                !idValid && id.trim().length > 0
                  ? "border-red-500/50 focus:border-red-500"
                  : "border-border/50 focus:border-primary/50",
              )}
              placeholder="e.g. chatgpt_wrote_this"
              value={id}
              onChange={(e) => setId(e.target.value)}
              maxLength={64}
            />
            {!idValid && id.trim().length > 0 && (
              <p className="text-xs text-red-400">
                1–64 characters of [A-Za-z0-9_] only.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Pattern (regex)
            </Label>
            <textarea
              data-testid="ai-disclosure-pattern"
              className={cn(
                "w-full min-h-[72px] rounded-lg glass-card p-2.5 text-sm bg-transparent border focus:outline-none resize-none transition-colors font-mono",
                pattern.trim().length > 0 && !regexValid()
                  ? "border-red-500/50 focus:border-red-500"
                  : "border-border/50 focus:border-primary/50",
              )}
              placeholder="e.g. \bgenerated\s+by\s+(?:chat)?gpt\b"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
            />
            {pattern.trim().length > 0 && !regexValid() && (
              <p className="text-xs text-red-400">Invalid regular expression.</p>
            )}
            <p className="text-xs text-muted-foreground/60">
              Pre-filled from the suggested text. Edit to refine the regex
              (e.g. add word boundaries, alternation).
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Flags
            </Label>
            <input
              data-testid="ai-disclosure-flags"
              className="w-full rounded-lg glass-card p-2.5 text-sm bg-transparent border border-border/50 focus:border-primary/50 focus:outline-none transition-colors font-mono"
              placeholder="i"
              value={flags}
              onChange={(e) => setFlags(e.target.value)}
              maxLength={6}
            />
            <p className="text-xs text-muted-foreground/60">
              Regex flags — typically "i" for case-insensitive.
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Rationale{" "}
              <span className="normal-case font-normal">(optional)</span>
            </Label>
            <input
              data-testid="ai-disclosure-rationale"
              className="w-full rounded-lg glass-card p-2.5 text-sm bg-transparent border border-border/50 focus:border-primary/50 focus:outline-none transition-colors"
              placeholder="Why this phrase should be flagged"
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
            />
          </div>

          {validationError && (
            <div
              className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300"
              data-testid="ai-disclosure-validation-error"
            >
              {validationError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={saving}
              data-testid="ai-disclosure-cancel"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!canSave}
              data-testid="ai-disclosure-save"
            >
              {saving ? "Saving…" : "Save & approve"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
