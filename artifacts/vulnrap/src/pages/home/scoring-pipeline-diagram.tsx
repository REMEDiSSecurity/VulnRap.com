type ExampleEngineRow = {
  key: "e1" | "e2" | "e3";
  title: string;
  weight: number;
  rawScore: number;
  effectiveScore?: number;
  gateNote?: string;
  inverted?: boolean;
};

type WorkedExample = {
  variant: "slop" | "genuine";
  caseHeadline: string;
  caseSubhead: string;
  whatsThereLines: string[];
  rows: ExampleEngineRow[];
  composite: number;
  triageLabel: string;
  triageSummary: string;
};

const ENGINE_HEX: Record<
  "e1" | "e2" | "e3",
  { fill: string; faded: string; track: string; ring: string }
> = {
  e1: {
    fill: "#fbbf24",
    faded: "rgba(251,191,36,0.35)",
    track: "rgba(251,191,36,0.10)",
    ring: "rgba(251,191,36,0.40)",
  },
  e2: {
    fill: "#22d3ee",
    faded: "rgba(34,211,238,0.35)",
    track: "rgba(34,211,238,0.10)",
    ring: "rgba(34,211,238,0.40)",
  },
  e3: {
    fill: "#a78bfa",
    faded: "rgba(167,139,250,0.35)",
    track: "rgba(167,139,250,0.10)",
    ring: "rgba(167,139,250,0.40)",
  },
};

const WORKED_EXAMPLES: WorkedExample[] = [
  {
    variant: "slop",
    caseHeadline: "SLOP ATTEMPT",
    caseSubhead: "CWE-89 cited · no PoC, no payload, no endpoint",
    whatsThereLines: [
      "Right CWE number. Generic prose (\u201CIt is important to note that",
      "SQL injection vulnerabilities\u2026\u201D). Zero code blocks. Zero file paths.",
    ],
    rows: [
      {
        key: "e1",
        title: "AI Authorship",
        weight: 5,
        rawScore: 78,
        inverted: true,
      },
      { key: "e2", title: "Technical Substance", weight: 60, rawScore: 17 },
      {
        key: "e3",
        title: "CWE Coherence",
        weight: 35,
        rawScore: 78,
        effectiveScore: 42,
        gateNote: "E2 < 30 \u2192 cap E3 at 42",
      },
    ],
    composite: 26,
    triageLabel: "CHALLENGE_REPORTER",
    triageSummary: "Auto-generates challenge questions for the reporter.",
  },
  {
    variant: "genuine",
    caseHeadline: "GENUINE REPORT",
    caseSubhead: "CWE-89 cited · full PoC, exact payload, real endpoint",
    whatsThereLines: [
      "Right CWE. Sober technical voice. curl PoC with payload",
      "\u201C' OR 1=1 --\u201D. Exact file path + line number. Real DB error.",
    ],
    rows: [
      {
        key: "e1",
        title: "AI Authorship",
        weight: 5,
        rawScore: 18,
        inverted: true,
      },
      { key: "e2", title: "Technical Substance", weight: 60, rawScore: 76 },
      { key: "e3", title: "CWE Coherence", weight: 35, rawScore: 82 },
    ],
    composite: 78,
    triageLabel: "PRIORITIZE",
    triageSummary: "Routes straight to a senior reviewer.",
  },
];

function rowContribution(row: ExampleEngineRow): number {
  const base = row.inverted
    ? 100 - row.rawScore
    : (row.effectiveScore ?? row.rawScore);
  return Math.round(base * (row.weight / 100) * 10) / 10;
}

function EngineRowSvg({
  row,
  x,
  y,
  width,
}: {
  row: ExampleEngineRow;
  x: number;
  y: number;
  width: number;
}) {
  const palette = ENGINE_HEX[row.key];
  const gated = typeof row.effectiveScore === "number";
  const barX = x;
  const barY = y + 28;
  const barW = width;
  const barH = 9;
  const rawW = (row.rawScore / 100) * barW;
  const effW = gated ? (row.effectiveScore! / 100) * barW : rawW;
  const contrib = rowContribution(row);
  const contribText = row.inverted
    ? `0.05 \u00D7 (100 \u2212 ${row.rawScore}) = ${contrib.toFixed(1)}`
    : `0.${row.weight.toString().padStart(2, "0")} \u00D7 ${gated ? row.effectiveScore : row.rawScore} = ${contrib.toFixed(1)}`;

  return (
    <g>
      {/* Title row: swatch + name + score (weight is in the legend, not repeated here) */}
      <circle cx={x + 4} cy={y + 8} r={3.5} fill={palette.fill} />
      <text
        x={x + 14}
        y={y + 12}
        fontSize={12.5}
        fontWeight={600}
        fill="#e2e8f0"
        fontFamily="ui-sans-serif, system-ui"
      >
        {row.title}
      </text>

      {/* Score (right-aligned). For gated rows: strike-through raw, then effective. */}
      {gated ? (
        <>
          <text
            x={x + width - 32}
            y={y + 12}
            textAnchor="end"
            fontSize={11}
            fill={palette.faded}
            fontFamily="ui-monospace, SFMono-Regular"
            fontWeight={600}
            textDecoration="line-through"
            opacity={0.7}
          >
            {row.rawScore}
          </text>
          <text
            x={x + width - 26}
            y={y + 12}
            fontSize={12}
            fontWeight={700}
            fill={palette.fill}
            fontFamily="ui-monospace, SFMono-Regular"
          >
            {row.effectiveScore}
          </text>
          <text
            x={x + width}
            y={y + 12}
            textAnchor="end"
            fontSize={9.5}
            fill="#64748b"
            fontFamily="ui-monospace, SFMono-Regular"
          >
            /100
          </text>
        </>
      ) : (
        <>
          <text
            x={x + width - 22}
            y={y + 12}
            textAnchor="end"
            fontSize={12}
            fontWeight={700}
            fill={palette.fill}
            fontFamily="ui-monospace, SFMono-Regular"
          >
            {row.rawScore}
          </text>
          <text
            x={x + width}
            y={y + 12}
            textAnchor="end"
            fontSize={9.5}
            fill="#64748b"
            fontFamily="ui-monospace, SFMono-Regular"
          >
            /100
          </text>
        </>
      )}

      {/* Bar — track + raw fill (faded if gated) + effective fill on top */}
      <rect
        x={barX}
        y={barY}
        width={barW}
        height={barH}
        rx={4.5}
        fill={palette.track}
      />
      <rect
        x={barX}
        y={barY}
        width={rawW}
        height={barH}
        rx={4.5}
        fill={palette.fill}
        opacity={gated ? 0.32 : 1}
      />
      {gated && (
        <rect
          x={barX}
          y={barY}
          width={effW}
          height={barH}
          rx={4.5}
          fill={palette.fill}
        />
      )}
      {/* Clamp marker — vertical amber line at the cap position */}
      {gated && (
        <>
          <line
            x1={barX + effW}
            y1={barY - 3}
            x2={barX + effW}
            y2={barY + barH + 3}
            stroke="#fbbf24"
            strokeWidth={2}
          />
          <polygon
            points={`${barX + effW - 3.5},${barY - 5} ${barX + effW + 3.5},${barY - 5} ${barX + effW},${barY - 1.5}`}
            fill="#fbbf24"
          />
        </>
      )}

      {/* Contribution math */}
      <text
        x={x + 14}
        y={barY + barH + 14}
        fontSize={10}
        fill="#64748b"
        fontFamily="ui-monospace, SFMono-Regular"
      >
        {contribText}
      </text>

      {/* Gate annotation (only for clamped E3 row) */}
      {gated && row.gateNote && (
        <g>
          <rect
            x={x + width - 200}
            y={barY + barH + 22}
            width={200}
            height={18}
            rx={4}
            fill="rgba(251,191,36,0.10)"
            stroke="rgba(251,191,36,0.45)"
          />
          <text
            x={x + width - 192}
            y={barY + barH + 35}
            fontSize={10}
            fontWeight={600}
            fill="#fbbf24"
            fontFamily="ui-monospace, SFMono-Regular"
          >
            {`\u{1F512} substance gate \u00B7 ${row.gateNote}`}
          </text>
        </g>
      )}
    </g>
  );
}

function WorkedExampleSvg({
  ex,
  x,
  y,
  width,
  height,
}: {
  ex: WorkedExample;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const isSlop = ex.variant === "slop";
  const accent = isSlop ? "#f43f5e" : "#10b981";
  const accentSoft = isSlop ? "rgba(244,63,94,0.35)" : "rgba(16,185,129,0.35)";
  const accentBg = isSlop ? "rgba(244,63,94,0.06)" : "rgba(16,185,129,0.06)";
  const compositeColor = isSlop ? "#fb7185" : "#34d399";
  const triageColor = isSlop ? "#fbbf24" : "#34d399";
  const triageSoft = isSlop ? "rgba(251,191,36,0.45)" : "rgba(16,185,129,0.45)";
  const triageFill = isSlop ? "rgba(251,191,36,0.12)" : "rgba(16,185,129,0.12)";

  const padX = 18;
  const innerX = x + padX;
  const innerW = width - padX * 2;

  // Vertical layout
  const headerY = y + 28;
  const subheadY = y + 56;
  const whatY = y + 76;
  const dividerY1 = y + 116;
  // Engine row positions
  const rowGap = 60;
  const rowsStartY = y + 138;
  const rowYs = ex.rows.map((_, i) => rowsStartY + i * rowGap);
  // Slop card's E3 has the gate annotation, which adds ~20px below the contribution math.
  // We pad subsequent layout sections accordingly.
  const lastRowExtra = ex.rows.some((r) => typeof r.effectiveScore === "number")
    ? 22
    : 0;
  const dividerY2 = rowsStartY + ex.rows.length * rowGap - 20 + lastRowExtra;
  const sumY = dividerY2 + 18;
  const compY = dividerY2 + 50;

  // Sum string
  const sumPieces = ex.rows.map((r) => rowContribution(r).toFixed(1));
  const sumText = `${sumPieces.join(" + ")} \u2248 ${ex.composite}`;

  // Triage badge sizing
  const triageW = ex.triageLabel.length * 7 + 18;

  return (
    <g>
      {/* Card background + border */}
      <rect x={x} y={y} width={width} height={height} rx={12} fill={accentBg} />
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={12}
        fill="none"
        stroke={accentSoft}
        strokeWidth={1.25}
      />

      {/* Case headline badge */}
      <rect
        x={innerX}
        y={headerY - 14}
        width={ex.caseHeadline.length * 7.5 + 14}
        height={20}
        rx={4}
        fill={`${accent}26`}
        stroke={accentSoft}
      />
      <text
        x={innerX + 8}
        y={headerY}
        fontSize={11}
        fontWeight={800}
        fill={accent}
        fontFamily="ui-monospace, SFMono-Regular"
        letterSpacing={0.8}
      >
        {isSlop ? "\u26A0  " : "\u2713  "}
        {ex.caseHeadline}
      </text>

      {/* Subhead */}
      <text
        x={innerX}
        y={subheadY}
        fontSize={11.5}
        fill="#94a3b8"
        fontFamily="ui-sans-serif, system-ui"
      >
        {ex.caseSubhead}
      </text>

      {/* What's there (multi-line italic) */}
      {ex.whatsThereLines.map((line, i) => (
        <text
          key={i}
          x={innerX}
          y={whatY + i * 14}
          fontSize={10.5}
          fill="#64748b"
          fontStyle="italic"
          fontFamily="ui-sans-serif, system-ui"
        >
          {line}
        </text>
      ))}

      {/* Divider */}
      <line
        x1={innerX}
        y1={dividerY1}
        x2={innerX + innerW}
        y2={dividerY1}
        stroke="rgba(148,163,184,0.18)"
      />

      {/* Engine rows */}
      {ex.rows.map((row, i) => (
        <EngineRowSvg
          key={row.key}
          row={row}
          x={innerX}
          y={rowYs[i]}
          width={innerW}
        />
      ))}

      {/* Divider */}
      <line
        x1={innerX}
        y1={dividerY2}
        x2={innerX + innerW}
        y2={dividerY2}
        stroke="rgba(148,163,184,0.18)"
      />

      {/* Sum line */}
      <text
        x={innerX}
        y={sumY}
        fontSize={10.5}
        fill="#94a3b8"
        fontFamily="ui-monospace, SFMono-Regular"
      >
        {sumText}
      </text>

      {/* Composite label */}
      <text
        x={innerX}
        y={compY - 12}
        fontSize={9}
        fontWeight={700}
        fill="#64748b"
        fontFamily="ui-sans-serif, system-ui"
        letterSpacing={1.5}
      >
        COMPOSITE
      </text>
      {/* Big composite number */}
      <text
        x={innerX}
        y={compY + 28}
        fontSize={42}
        fontWeight={800}
        fill={compositeColor}
        fontFamily="ui-monospace, SFMono-Regular"
      >
        {ex.composite}
      </text>

      {/* Triage badge (right side) */}
      <rect
        x={innerX + innerW - triageW}
        y={compY - 8}
        width={triageW}
        height={22}
        rx={4}
        fill={triageFill}
        stroke={triageSoft}
      />
      <text
        x={innerX + innerW - triageW / 2}
        y={compY + 7}
        textAnchor="middle"
        fontSize={11}
        fontWeight={800}
        fill={triageColor}
        fontFamily="ui-monospace, SFMono-Regular"
        letterSpacing={0.5}
      >
        {ex.triageLabel}
      </text>
      {/* Triage summary (right side, wraps to two lines if needed; we keep it short) */}
      <text
        x={innerX + innerW}
        y={compY + 28}
        textAnchor="end"
        fontSize={10}
        fill="#64748b"
        fontFamily="ui-sans-serif, system-ui"
      >
        {ex.triageSummary}
      </text>
    </g>
  );
}

const DIAGRAM_ENGINES = [
  { key: "e1" as const, title: "AI Authorship", weight: 5 },
  { key: "e2" as const, title: "Technical Substance", weight: 60 },
  { key: "e3" as const, title: "CWE Coherence", weight: 35 },
];

function LegendChips({
  x,
  y,
  layout,
}: {
  x: number;
  y: number;
  layout: "inline" | "stacked";
}) {
  // inline: label and chips on the same row (wide layout)
  // stacked: label on its own row above the chips (narrow layout)
  if (layout === "inline") {
    let chipX = x + 230;
    return (
      <g>
        <text
          x={x}
          y={y + 14}
          fontSize={11}
          fontWeight={700}
          fill="#94a3b8"
          fontFamily="ui-sans-serif, system-ui"
          letterSpacing={1.2}
        >
          {"3 ENGINES VOTE \u00B7 WEIGHTS SUM TO 100%"}
        </text>
        {DIAGRAM_ENGINES.map((e) => {
          const palette = ENGINE_HEX[e.key];
          const w = e.title.length * 6.6 + 60;
          const cx = chipX;
          chipX += w + 8;
          return (
            <g key={e.key}>
              <rect
                x={cx}
                y={y}
                width={w}
                height={20}
                rx={4}
                fill={palette.track}
                stroke={palette.ring}
              />
              <circle cx={cx + 9} cy={y + 10} r={3} fill={palette.fill} />
              <text
                x={cx + 17}
                y={y + 14}
                fontSize={10.5}
                fontWeight={700}
                fill={palette.fill}
                fontFamily="ui-sans-serif, system-ui"
              >
                {e.title}
              </text>
              <text
                x={cx + w - 8}
                y={y + 14}
                textAnchor="end"
                fontSize={10}
                fill="#94a3b8"
                fontFamily="ui-monospace, SFMono-Regular"
              >
                {e.weight}%
              </text>
            </g>
          );
        })}
      </g>
    );
  }
  // Stacked layout: label on row 1, chips on row 2
  let chipX = x;
  return (
    <g>
      <text
        x={x}
        y={y + 12}
        fontSize={10.5}
        fontWeight={700}
        fill="#94a3b8"
        fontFamily="ui-sans-serif, system-ui"
        letterSpacing={1.2}
      >
        {"3 ENGINES VOTE \u00B7 WEIGHTS SUM TO 100%"}
      </text>
      {DIAGRAM_ENGINES.map((e) => {
        const palette = ENGINE_HEX[e.key];
        const w = e.title.length * 6.6 + 60;
        const cx = chipX;
        chipX += w + 8;
        return (
          <g key={e.key}>
            <rect
              x={cx}
              y={y + 22}
              width={w}
              height={20}
              rx={4}
              fill={palette.track}
              stroke={palette.ring}
            />
            <circle cx={cx + 9} cy={y + 32} r={3} fill={palette.fill} />
            <text
              x={cx + 17}
              y={y + 36}
              fontSize={10.5}
              fontWeight={700}
              fill={palette.fill}
              fontFamily="ui-sans-serif, system-ui"
            >
              {e.title}
            </text>
            <text
              x={cx + w - 8}
              y={y + 36}
              textAnchor="end"
              fontSize={10}
              fill="#94a3b8"
              fontFamily="ui-monospace, SFMono-Regular"
            >
              {e.weight}%
            </text>
          </g>
        );
      })}
    </g>
  );
}

const DIAGRAM_ARIA_LABEL =
  "Three-engine composite scoring with two worked examples. Slop attempt: AI Authorship 78, Substance 17, CWE Coherence raw 78 capped at 42 by the substance gate, composite 26, triage CHALLENGE_REPORTER. Genuine report: AI Authorship 18, Substance 76, CWE Coherence 82, composite 78, triage PRIORITIZE.";

export function ScoringPipelineDiagram() {
  // ---- Wide (sm and up) layout: cards side-by-side ----
  const wideVBW = 1000;
  const wideVBH = 600;
  const widePadX = 24;
  const wideInnerW = wideVBW - widePadX * 2;
  const wideCardGap = 24;
  const wideCardW = (wideInnerW - wideCardGap) / 2;
  const wideCardY = 56;
  const wideCardH = 488;

  // ---- Narrow (below sm) layout: cards stacked vertically ----
  const narrowVBW = 600;
  const narrowPadX = 20;
  const narrowInnerW = narrowVBW - narrowPadX * 2;
  const narrowLegendH = 60;
  const narrowCardGap = 20;
  const narrowCardH = 488;
  const narrowCard1Y = narrowLegendH + 8;
  const narrowCard2Y = narrowCard1Y + narrowCardH + narrowCardGap;
  const narrowFooterY = narrowCard2Y + narrowCardH + 12;
  const narrowVBH = narrowFooterY + 28;

  return (
    <div
      className="relative rounded-xl border border-cyan-500/15 p-3 sm:p-5 overflow-hidden"
      style={{
        background:
          "linear-gradient(135deg, rgba(15,23,42,0.65) 0%, rgba(15,23,42,0.35) 100%)",
        boxShadow:
          "0 0 0 1px rgba(0,255,255,0.04) inset, 0 8px 32px rgba(0,0,0,0.35)",
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.18]"
        style={{
          background:
            "radial-gradient(ellipse 60% 40% at 18% 100%, rgba(244,63,94,0.22), transparent 70%), radial-gradient(ellipse 60% 40% at 82% 100%, rgba(52,211,153,0.22), transparent 70%)",
        }}
      />

      {/* Screen reader prose walkthrough — read once regardless of which SVG renders. */}
      <p className="sr-only">
        Worked-example diagram comparing two reports that both cite CWE-89. The
        slop attempt has no proof of concept, no payload, and no endpoint; its
        engine scores are AI Authorship 78, Technical Substance 17, raw CWE
        Coherence 78. Because Substance is below 30, the substance gate caps
        Engine 3 at 42, so the weighted composite lands at 26 and triage routes
        to CHALLENGE_REPORTER. The genuine report has the same CWE number but
        with a curl proof of concept, the exact payload, an endpoint, a file
        path with line number, and a real database error; its engine scores are
        AI Authorship 18, Technical Substance 76, CWE Coherence 82. The
        substance gate does not fire, so the composite lands at 78 and triage
        routes to PRIORITIZE.
      </p>

      {/* Wide layout: cards side-by-side, shown at sm and up */}
      <svg
        viewBox={`0 0 ${wideVBW} ${wideVBH}`}
        className="hidden sm:block relative w-full h-auto"
        role="img"
        aria-label={DIAGRAM_ARIA_LABEL}
        preserveAspectRatio="xMidYMid meet"
      >
        <LegendChips x={widePadX} y={14} layout="inline" />
        <WorkedExampleSvg
          ex={WORKED_EXAMPLES[0]}
          x={widePadX}
          y={wideCardY}
          width={wideCardW}
          height={wideCardH}
        />
        <WorkedExampleSvg
          ex={WORKED_EXAMPLES[1]}
          x={widePadX + wideCardW + wideCardGap}
          y={wideCardY}
          width={wideCardW}
          height={wideCardH}
        />
        <text
          x={wideVBW / 2}
          y={wideCardY + wideCardH + 30}
          textAnchor="middle"
          fontSize={11.5}
          fill="#94a3b8"
          fontFamily="ui-sans-serif, system-ui"
        >
          <tspan fontWeight={700} fill="#e2e8f0">
            Same CWE-89 cited.
          </tspan>
          {"  "}What separates these reports is{" "}
          <tspan fill="#22d3ee" fontFamily="ui-monospace, SFMono-Regular">
            substance
          </tspan>
          . When Engine 2 sees no evidence, the substance gate caps Engine 3.
        </text>
      </svg>

      {/* Narrow layout: cards stacked vertically, shown below sm */}
      <svg
        viewBox={`0 0 ${narrowVBW} ${narrowVBH}`}
        className="block sm:hidden relative w-full h-auto"
        role="img"
        aria-label={DIAGRAM_ARIA_LABEL}
        preserveAspectRatio="xMidYMid meet"
      >
        <LegendChips x={narrowPadX} y={4} layout="stacked" />
        <WorkedExampleSvg
          ex={WORKED_EXAMPLES[0]}
          x={narrowPadX}
          y={narrowCard1Y}
          width={narrowInnerW}
          height={narrowCardH}
        />
        <WorkedExampleSvg
          ex={WORKED_EXAMPLES[1]}
          x={narrowPadX}
          y={narrowCard2Y}
          width={narrowInnerW}
          height={narrowCardH}
        />
        <text
          x={narrowVBW / 2}
          y={narrowFooterY + 14}
          textAnchor="middle"
          fontSize={11}
          fill="#94a3b8"
          fontFamily="ui-sans-serif, system-ui"
        >
          <tspan fontWeight={700} fill="#e2e8f0">
            Same CWE-89 cited.
          </tspan>
          {"  "}What separates them is{" "}
          <tspan fill="#22d3ee" fontFamily="ui-monospace, SFMono-Regular">
            substance
          </tspan>
          .
        </text>
      </svg>
    </div>
  );
}

export default ScoringPipelineDiagram;
