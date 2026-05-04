import { useState } from "react";
import { Play, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function VideoSection() {
  const [open, setOpen] = useState(false);

  return (
    <div className="max-w-2xl mx-auto w-full">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl glass-card hover:bg-primary/5 transition-colors group"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground group-hover:text-primary transition-colors">
          <Play className="w-4 h-4" />
          Watch the rap sheet
          <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded bg-primary/20 text-primary border border-primary/30 animate-pulse">
            New
          </span>
        </span>
        <ChevronDown
          className={cn(
            "w-4 h-4 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="rounded-xl glass-card-accent overflow-hidden">
            <video
              className="w-full"
              controls
              playsInline
              autoPlay
              muted
              preload="metadata"
            >
              <source
                src={`${import.meta.env.BASE_URL}vulnrap-rap-sheet.mov`}
                type="video/quicktime"
              />
              <source
                src={`${import.meta.env.BASE_URL}vulnrap-rap-sheet.mov`}
                type="video/mp4"
              />
              <track
                kind="captions"
                srcLang="en"
                src={`${import.meta.env.BASE_URL}vulnrap-rap-sheet.vtt`}
                default
              />
              Your browser does not support video playback.
            </video>
          </div>
          <p className="text-center text-[10px] text-muted-foreground/50">
            Looking for our{" "}
            <a
              href={`${import.meta.env.BASE_URL}vulnrap-intro.mp4`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary/60 hover:text-primary hover:underline transition-colors"
            >
              previous rap video
            </a>
            ?
          </p>
        </div>
      )}
    </div>
  );
}
