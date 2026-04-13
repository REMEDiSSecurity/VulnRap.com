import { useMemo } from "react";

interface RadarDataPoint {
  label: string;
  value: number;
  max: number;
}

interface RadarChartProps {
  data: RadarDataPoint[];
  size?: number;
  color?: string;
  bgColor?: string;
  gridColor?: string;
  labelColor?: string;
}

export function RadarChart({
  data,
  size = 220,
  color = "rgba(6, 182, 212, 0.7)",
  bgColor = "rgba(6, 182, 212, 0.12)",
  gridColor = "rgba(255, 255, 255, 0.08)",
  labelColor = "rgba(255, 255, 255, 0.55)",
}: RadarChartProps) {
  const center = size / 2;
  const radius = size * 0.35;
  const levels = 4;
  const n = data.length;

  const points = useMemo(() => {
    return data.map((d, i) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      const r = (d.value / d.max) * radius;
      return {
        x: center + r * Math.cos(angle),
        y: center + r * Math.sin(angle),
        labelX: center + (radius + 24) * Math.cos(angle),
        labelY: center + (radius + 24) * Math.sin(angle),
        angle,
        ...d,
      };
    });
  }, [data, n, center, radius]);

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

  const dataPolygon = points.map((p) => `${p.x},${p.y}`).join(" ");

  const valueColor = (val: number, max: number) => {
    const pct = val / max;
    if (pct >= 0.5) return "rgba(239, 68, 68, 0.9)";
    if (pct >= 0.25) return "rgba(234, 179, 8, 0.9)";
    return "rgba(34, 197, 94, 0.9)";
  };

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="mx-auto">
      {gridPolygons.map((pts, i) => (
        <polygon
          key={i}
          points={pts}
          fill="none"
          stroke={gridColor}
          strokeWidth={1}
        />
      ))}

      {points.map((p, i) => (
        <line
          key={`axis-${i}`}
          x1={center}
          y1={center}
          x2={center + radius * Math.cos(p.angle)}
          y2={center + radius * Math.sin(p.angle)}
          stroke={gridColor}
          strokeWidth={0.5}
        />
      ))}

      <polygon
        points={dataPolygon}
        fill={bgColor}
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />

      {points.map((p, i) => (
        <circle
          key={`dot-${i}`}
          cx={p.x}
          cy={p.y}
          r={3}
          fill={valueColor(p.value, p.max)}
          stroke="rgba(0,0,0,0.3)"
          strokeWidth={0.5}
        />
      ))}

      {points.map((p, i) => {
        const anchor = Math.abs(p.angle) < 0.1 || Math.abs(p.angle - Math.PI) < 0.1
          ? "middle"
          : p.angle > -Math.PI / 2 && p.angle < Math.PI / 2
            ? "start"
            : "end";
        const dy = p.angle > 0 && p.angle < Math.PI ? 12 : p.angle < 0 ? -4 : 4;
        return (
          <g key={`label-${i}`}>
            <text
              x={p.labelX}
              y={p.labelY + dy}
              textAnchor={anchor}
              fill={labelColor}
              fontSize={9}
              fontWeight={500}
            >
              {p.label}
            </text>
            <text
              x={p.labelX}
              y={p.labelY + dy + 11}
              textAnchor={anchor}
              fill={valueColor(p.value, p.max)}
              fontSize={9}
              fontWeight={700}
              fontFamily="monospace"
            >
              {p.value}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
