import { useId, useMemo, useState, useEffect } from "react";

interface RadarDataPoint {
  label: string;
  value: number;
  max: number;
}

interface RadarChartProps {
  data: RadarDataPoint[];
  size?: number;
  /** Visual variant. `polished` uses the branded glass + gradient styling
   *  shared with the landing-page Validity Scoring diagram. */
  variant?: "polished" | "flat";
  /** Override gradient stops for the polygon fill/stroke. Defaults to the
   *  amber → cyan → violet engine palette. */
  gradientStops?: string[];
  /** Accessible label for the chart. Defaults to a generic description. */
  ariaLabel?: string;
  /** Optional overlay polygon (e.g. cohort median) drawn underneath the
   *  primary polygon as a dashed muted ring. Must have the same number of
   *  axes (in the same order) as `data`. */
  overlayData?: RadarDataPoint[] | null;
  /** Accessible label for the overlay polygon. */
  overlayLabel?: string;
}

const DEFAULT_STOPS = ["#fbbf24", "#22d3ee", "#a78bfa"];

export function RadarChart({
  data,
  size = 220,
  variant = "polished",
  gradientStops = DEFAULT_STOPS,
  ariaLabel,
  overlayData = null,
  overlayLabel,
}: RadarChartProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const center = size / 2;
  const radius = size * 0.34;
  const levels = 4;
  const n = data.length;

  const [progress, setProgress] = useState(0);

  useEffect(() => {
    setProgress(0);
    let frame: number;
    let start: number | null = null;
    const duration = 850;
    const animate = (ts: number) => {
      if (!start) start = ts;
      const elapsed = ts - start;
      const t = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setProgress(eased);
      if (t < 1) frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [data]);

  const points = useMemo(() => {
    return data.map((d, i) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      const r = (d.value / d.max) * radius;
      return {
        x: center + r * Math.cos(angle),
        y: center + r * Math.sin(angle),
        labelX: center + (radius + 26) * Math.cos(angle),
        labelY: center + (radius + 26) * Math.sin(angle),
        angle,
        ...d,
      };
    });
  }, [data, n, center, radius]);

  const animatedPoints = useMemo(() => {
    return points.map((p) => {
      const r = ((p.value / p.max) * radius) * progress;
      return {
        ...p,
        ax: center + r * Math.cos(p.angle),
        ay: center + r * Math.sin(p.angle),
      };
    });
  }, [points, progress, center, radius]);

  const gridPolygons = useMemo(() => {
    return Array.from({ length: levels }, (_, lvl) => {
      const r = (radius * (lvl + 1)) / levels;
      const pts = Array.from({ length: n }, (_, i) => {
        const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
        return `${center + r * Math.cos(angle)},${center + r * Math.sin(angle)}`;
      });
      return pts.join(" ");
    });
  }, [n, center, radius, levels]);

  const dataPolygon = animatedPoints.map((p) => `${p.ax},${p.ay}`).join(" ");

  const overlayPoints = useMemo(() => {
    if (!overlayData || overlayData.length !== n) return null;
    return overlayData.map((d, i) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      const r = (d.value / d.max) * radius * progress;
      return { x: center + r * Math.cos(angle), y: center + r * Math.sin(angle), ...d };
    });
  }, [overlayData, n, center, radius, progress]);
  const overlayPolygon = overlayPoints ? overlayPoints.map((p) => `${p.x},${p.y}`).join(" ") : null;

  const valueColor = (val: number, max: number) => {
    const pct = val / max;
    if (pct >= 0.5) return "rgba(239, 68, 68, 1)";
    if (pct >= 0.25) return "rgba(234, 179, 8, 1)";
    return "rgba(34, 197, 94, 1)";
  };

  const polished = variant === "polished";
  const gridColor = polished ? "rgba(148, 163, 184, 0.12)" : "rgba(255, 255, 255, 0.08)";
  const axisColor = polished ? "rgba(148, 163, 184, 0.18)" : "rgba(255, 255, 255, 0.08)";
  const labelColor = polished ? "rgba(226, 232, 240, 0.75)" : "rgba(255, 255, 255, 0.55)";

  const polyGradId = `radarPoly-${uid}`;
  const strokeGradId = `radarStroke-${uid}`;
  const bgGlowId = `radarBgGlow-${uid}`;
  const softGlowId = `radarSoftGlow-${uid}`;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className="mx-auto"
      role="img"
      aria-label={ariaLabel ?? `Radar chart showing ${n} sub-scores: ${data.map((d) => `${d.label} ${Math.round(d.value)} of ${d.max}`).join(", ")}.`}
    >
      <title>{ariaLabel ?? `Radar chart of ${n} sub-scores`}</title>
      <defs>
        <linearGradient id={polyGradId} x1="0" y1="0" x2="1" y2="1">
          {gradientStops.map((stop, i) => (
            <stop
              key={i}
              offset={`${(i / Math.max(1, gradientStops.length - 1)) * 100}%`}
              stopColor={stop}
              stopOpacity={polished ? 0.28 : 0.18}
            />
          ))}
        </linearGradient>
        <linearGradient id={strokeGradId} x1="0" y1="0" x2="1" y2="1">
          {gradientStops.map((stop, i) => (
            <stop
              key={i}
              offset={`${(i / Math.max(1, gradientStops.length - 1)) * 100}%`}
              stopColor={stop}
              stopOpacity={0.95}
            />
          ))}
        </linearGradient>
        <radialGradient id={bgGlowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(34, 211, 238, 0.18)" />
          <stop offset="60%" stopColor="rgba(34, 211, 238, 0.05)" />
          <stop offset="100%" stopColor="rgba(34, 211, 238, 0)" />
        </radialGradient>
        <filter id={softGlowId} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {polished && (
        <circle
          cx={center}
          cy={center}
          r={radius * 1.35}
          fill={`url(#${bgGlowId})`}
          style={{ opacity: progress }}
        />
      )}

      {gridPolygons.map((pts, i) => (
        <polygon
          key={i}
          points={pts}
          fill="none"
          stroke={gridColor}
          strokeWidth={i === gridPolygons.length - 1 ? 1 : 0.75}
          style={{ opacity: Math.min(1, progress * 2) }}
        />
      ))}

      {points.map((p, i) => (
        <line
          key={`axis-${i}`}
          x1={center}
          y1={center}
          x2={center + radius * Math.cos(p.angle)}
          y2={center + radius * Math.sin(p.angle)}
          stroke={axisColor}
          strokeWidth={0.6}
          style={{ opacity: Math.min(1, progress * 2) }}
        />
      ))}

      {overlayPolygon && (
        <polygon
          points={overlayPolygon}
          fill="rgba(148, 163, 184, 0.08)"
          stroke="rgba(148, 163, 184, 0.55)"
          strokeWidth={1.25}
          strokeDasharray="4 3"
          strokeLinejoin="round"
          style={{ opacity: progress }}
        >
          <title>{overlayLabel ?? "Overlay"}</title>
        </polygon>
      )}

      <polygon
        points={dataPolygon}
        fill={polished ? `url(#${polyGradId})` : "rgba(6, 182, 212, 0.12)"}
        stroke={polished ? `url(#${strokeGradId})` : "rgba(6, 182, 212, 0.7)"}
        strokeWidth={1.75}
        strokeLinejoin="round"
        style={{ opacity: progress, filter: polished ? `url(#${softGlowId})` : undefined }}
      />

      {animatedPoints.map((p, i) => {
        const c = valueColor(p.value, p.max);
        return (
          <g key={`dot-${i}`} style={{ opacity: progress }}>
            {polished && (
              <circle
                cx={p.ax}
                cy={p.ay}
                r={6 * progress}
                fill={c}
                opacity={0.25}
                style={{ filter: `url(#${softGlowId})` }}
              />
            )}
            <circle
              cx={p.ax}
              cy={p.ay}
              r={3 * progress}
              fill={c}
              stroke="rgba(15,23,42,0.85)"
              strokeWidth={0.75}
            />
          </g>
        );
      })}

      {points.map((p, i) => {
        const anchor = Math.abs(p.angle + Math.PI / 2) < 0.1 || Math.abs(p.angle - Math.PI / 2) < 0.1
          ? "middle"
          : p.angle > -Math.PI / 2 && p.angle < Math.PI / 2
            ? "start"
            : "end";
        const dy = p.angle > 0 && p.angle < Math.PI ? 12 : p.angle < 0 && p.angle > -Math.PI ? -4 : 4;
        const valC = valueColor(p.value, p.max);
        return (
          <g key={`label-${i}`} style={{ opacity: progress }}>
            <text
              x={p.labelX}
              y={p.labelY + dy}
              textAnchor={anchor}
              fill={labelColor}
              fontSize={9}
              fontWeight={600}
              fontFamily="ui-sans-serif, system-ui"
              letterSpacing="0.3"
            >
              {p.label}
            </text>
            <text
              x={p.labelX}
              y={p.labelY + dy + 12}
              textAnchor={anchor}
              fill={valC}
              fontSize={10}
              fontWeight={700}
              fontFamily="ui-monospace, SFMono-Regular, monospace"
              style={polished ? { filter: `drop-shadow(0 0 4px ${valC})` } : undefined}
            >
              {Math.round(p.value * progress)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
