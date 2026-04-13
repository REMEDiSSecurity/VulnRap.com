import { useMemo } from "react";

interface ConfidenceGaugeProps {
  value: number;
  size?: number;
  label?: string;
}

export function ConfidenceGauge({ value, size = 140, label }: ConfidenceGaugeProps) {
  const pct = Math.max(0, Math.min(1, value));
  const strokeWidth = 10;
  const r = (size - strokeWidth) / 2 - 4;
  const center = size / 2;

  const startAngle = Math.PI * 0.8;
  const endAngle = Math.PI * 2.2;
  const totalAngle = endAngle - startAngle;
  const currentAngle = startAngle + totalAngle * pct;

  const arcPath = (angle: number) => {
    const x = center + r * Math.cos(angle);
    const y = center + r * Math.sin(angle);
    return { x, y };
  };

  const start = arcPath(startAngle);
  const end = arcPath(endAngle);
  const current = arcPath(currentAngle);

  const largeArcBg = totalAngle > Math.PI ? 1 : 0;
  const sweepAngle = currentAngle - startAngle;
  const largeArcFg = sweepAngle > Math.PI ? 1 : 0;

  const bgPath = `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcBg} 1 ${end.x} ${end.y}`;
  const fgPath = sweepAngle > 0.01
    ? `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFg} 1 ${current.x} ${current.y}`
    : "";

  const color = useMemo(() => {
    if (pct >= 0.8) return { stroke: "#22c55e", glow: "rgba(34, 197, 94, 0.3)", text: "text-green-400" };
    if (pct >= 0.5) return { stroke: "#eab308", glow: "rgba(234, 179, 8, 0.3)", text: "text-yellow-400" };
    return { stroke: "#f97316", glow: "rgba(249, 115, 22, 0.3)", text: "text-orange-400" };
  }, [pct]);

  const confidenceLabel = pct >= 0.8 ? "High" : pct >= 0.5 ? "Medium" : "Low";

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${size} ${size * 0.75}`} width={size} height={size * 0.75}>
        <defs>
          <filter id="gauge-glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path
          d={bgPath}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {fgPath && (
          <path
            d={fgPath}
            fill="none"
            stroke={color.stroke}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            filter="url(#gauge-glow)"
          />
        )}
        <text
          x={center}
          y={center + 4}
          textAnchor="middle"
          fill="currentColor"
          fontSize={28}
          fontWeight={700}
          fontFamily="monospace"
          className={color.text}
        >
          {Math.round(pct * 100)}%
        </text>
        <text
          x={center}
          y={center + 20}
          textAnchor="middle"
          fill="rgba(255,255,255,0.45)"
          fontSize={9}
          fontWeight={500}
          style={{ textTransform: "uppercase" }}
        >
          {confidenceLabel}
        </text>
      </svg>
      {label && (
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide -mt-1">{label}</span>
      )}
    </div>
  );
}
