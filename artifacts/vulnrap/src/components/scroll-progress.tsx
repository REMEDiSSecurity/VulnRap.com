import { useEffect, useRef, useState } from "react";

export function ScrollProgress() {
  const [progress, setProgress] = useState(0);
  const pendingRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    const update = () => {
      pendingRef.current = false;
      rafIdRef.current = null;
      const doc = document.documentElement;
      const scrollTop = window.scrollY || doc.scrollTop || 0;
      const scrollHeight = (doc.scrollHeight || 0) - (doc.clientHeight || 0);
      if (scrollHeight <= 0) {
        setProgress(0);
        return;
      }
      const pct = Math.min(100, Math.max(0, (scrollTop / scrollHeight) * 100));
      setProgress(pct);
    };

    const schedule = () => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      rafIdRef.current = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (rafIdRef.current != null) {
        window.cancelAnimationFrame(rafIdRef.current);
      }
      rafIdRef.current = null;
      pendingRef.current = false;
    };
  }, []);

  return (
    <div className="scroll-progress" aria-hidden="true">
      <div
        className="scroll-progress-bar"
        style={{ width: `${progress}%` }}
        data-testid="scroll-progress-bar"
      />
    </div>
  );
}
