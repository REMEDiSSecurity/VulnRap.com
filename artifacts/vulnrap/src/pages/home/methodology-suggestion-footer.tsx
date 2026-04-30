import { Mail } from "lucide-react";

export function MethodologySuggestionFooter({ topic }: { topic: string }) {
  const subject = encodeURIComponent(`Methodology Suggestion: ${topic}`);
  return (
    <div className="border-t border-border/30 pt-3 flex items-center justify-between gap-3">
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Have a better idea for how we handle <span className="text-foreground">{topic}</span>? We're always looking to improve our methodology.
      </p>
      <a
        href={`mailto:remedisllc@gmail.com?subject=${subject}`}
        className="flex-shrink-0 inline-flex items-center gap-1.5 text-[10px] text-primary/70 hover:text-primary transition-colors border border-primary/20 hover:border-primary/40 rounded-md px-2.5 py-1"
      >
        <Mail className="w-2.5 h-2.5" />
        Suggest a change
      </a>
    </div>
  );
}
