import { useEffect, useState, useRef } from "react";

function LaserBeams() {
  return (
    <div className="laser-beams-container" aria-hidden="true">
      <div className="laser-beam laser-beam-1" />
      <div className="laser-beam laser-beam-2" />
      <div className="laser-beam laser-beam-3" />
      <div className="laser-beam laser-beam-4" />
    </div>
  );
}

function LaserFlashes() {
  const [flashes, setFlashes] = useState<Array<{ id: number; x: number; y: number; size: number; color: string }>>([]);
  const flashTimeouts = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) return;

    let idCounter = 0;
    const colors = [
      "rgba(0, 255, 255, 0.08)",
      "rgba(138, 43, 226, 0.06)",
      "rgba(0, 255, 255, 0.05)",
      "rgba(200, 50, 255, 0.05)",
    ];

    const spawn = () => {
      const id = idCounter++;
      const flash = {
        id,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: 80 + Math.random() * 200,
        color: colors[Math.floor(Math.random() * colors.length)],
      };
      setFlashes((prev) => [...prev.slice(-4), flash]);
      const t = setTimeout(() => {
        flashTimeouts.current.delete(t);
        setFlashes((prev) => prev.filter((f) => f.id !== id));
      }, 2200);
      flashTimeouts.current.add(t);
    };

    const interval = setInterval(spawn, 4000 + Math.random() * 3000);
    const firstTimeout = setTimeout(spawn, 2000);
    return () => {
      clearInterval(interval);
      clearTimeout(firstTimeout);
      flashTimeouts.current.forEach((t) => clearTimeout(t));
      flashTimeouts.current.clear();
    };
  }, []);

  return (
    <div className="laser-flashes" aria-hidden="true">
      {flashes.map((f) => (
        <div
          key={f.id}
          className="laser-flash"
          style={{
            left: `${f.x}%`,
            top: `${f.y}%`,
            width: f.size,
            height: f.size,
            background: `radial-gradient(circle, ${f.color} 0%, transparent 70%)`,
          }}
        />
      ))}
    </div>
  );
}

function ScanLine() {
  return <div className="scan-line" aria-hidden="true" />;
}

export function LaserEffects() {
  return (
    <>
      <LaserBeams />
      <LaserFlashes />
      <ScanLine />
    </>
  );
}

export function LogoBeams() {
  return (
    <div className="logo-beams" aria-hidden="true">
      <svg
        viewBox="0 0 600 600"
        className="logo-beams-svg"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <linearGradient id="cyan-beam-ul" x1="299" y1="300" x2="73" y2="20" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#00FFFF" stopOpacity="0.7" />
            <stop offset="30%" stopColor="#00FFFF" stopOpacity="0.3" />
            <stop offset="70%" stopColor="#00FFFF" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#00FFFF" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="cyan-beam-lr" x1="299" y1="300" x2="524" y2="580" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#00FFFF" stopOpacity="0.7" />
            <stop offset="30%" stopColor="#00FFFF" stopOpacity="0.3" />
            <stop offset="70%" stopColor="#00FFFF" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#00FFFF" stopOpacity="0" />
          </linearGradient>

          <linearGradient id="mag-beam-ur" x1="299" y1="300" x2="532" y2="20" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#C832FF" stopOpacity="0.65" />
            <stop offset="30%" stopColor="#C832FF" stopOpacity="0.25" />
            <stop offset="70%" stopColor="#C832FF" stopOpacity="0.05" />
            <stop offset="100%" stopColor="#C832FF" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="mag-beam-ll" x1="299" y1="300" x2="64" y2="580" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#C832FF" stopOpacity="0.65" />
            <stop offset="30%" stopColor="#C832FF" stopOpacity="0.25" />
            <stop offset="70%" stopColor="#C832FF" stopOpacity="0.05" />
            <stop offset="100%" stopColor="#C832FF" stopOpacity="0" />
          </linearGradient>

          <filter id="beam-glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="core-glow">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <line x1="299" y1="300" x2="73" y2="20"
          stroke="url(#cyan-beam-ul)" strokeWidth="2" strokeLinecap="round"
          filter="url(#beam-glow)" className="scan-beam scan-beam-cyan-1" />
        <line x1="299" y1="300" x2="524" y2="580"
          stroke="url(#cyan-beam-lr)" strokeWidth="2" strokeLinecap="round"
          filter="url(#beam-glow)" className="scan-beam scan-beam-cyan-2" />

        <line x1="299" y1="300" x2="532" y2="20"
          stroke="url(#mag-beam-ur)" strokeWidth="1.5" strokeLinecap="round"
          filter="url(#beam-glow)" className="scan-beam scan-beam-mag-1" />
        <line x1="299" y1="300" x2="64" y2="580"
          stroke="url(#mag-beam-ll)" strokeWidth="1.5" strokeLinecap="round"
          filter="url(#beam-glow)" className="scan-beam scan-beam-mag-2" />

        <circle cx="300" cy="300" r="8" fill="rgba(255,255,255,0.15)" className="scan-core-ring" filter="url(#core-glow)" />
        <circle cx="300" cy="300" r="3" fill="rgba(0,255,255,0.5)" className="scan-core-dot" />

        <circle cx="300" cy="300" r="20" fill="none" stroke="rgba(0,255,255,0.1)" strokeWidth="0.5" className="scan-ripple scan-ripple-1" />
        <circle cx="300" cy="300" r="20" fill="none" stroke="rgba(200,50,255,0.08)" strokeWidth="0.5" className="scan-ripple scan-ripple-2" />
      </svg>
    </div>
  );
}
