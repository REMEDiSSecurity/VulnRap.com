import { Network, ArrowRight } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

interface PipelineNode {
  id: string;
  label: string;
  sub: string;
  to: string;
  linkLabel: string;
  fill: string;
  stroke: string;
  text: string;
}

const NODES: PipelineNode[] = [
  {
    id: "intake",
    label: "Intake",
    sub: "POST /api/reports",
    to: "/developers",
    linkLabel: "API reference",
    fill: "rgba(34,211,238,0.10)",
    stroke: "rgba(34,211,238,0.55)",
    text: "#22d3ee",
  },
  {
    id: "redact",
    label: "Redact",
    sub: "PII / secret strip",
    to: "/privacy",
    linkLabel: "Privacy & redaction",
    fill: "rgba(167,139,250,0.10)",
    stroke: "rgba(167,139,250,0.55)",
    text: "#a78bfa",
  },
  {
    id: "fuse",
    label: "Score Fusion",
    sub: "3 engines · weighted",
    to: "/transparency",
    linkLabel: "Engine transparency",
    fill: "rgba(251,191,36,0.10)",
    stroke: "rgba(251,191,36,0.55)",
    text: "#fbbf24",
  },
  {
    id: "triage",
    label: "Triage",
    sub: "label · gate · route",
    to: "/use-cases",
    linkLabel: "Triage use cases",
    fill: "rgba(244,114,182,0.10)",
    stroke: "rgba(244,114,182,0.55)",
    text: "#f472b6",
  },
  {
    id: "store",
    label: "Store",
    sub: "hash · index · search",
    to: "/reports",
    linkLabel: "Reports gallery",
    fill: "rgba(52,211,153,0.10)",
    stroke: "rgba(52,211,153,0.55)",
    text: "#34d399",
  },
  {
    id: "feedback",
    label: "Feedback Loop",
    sub: "votes · drift · re-tune",
    to: "/feedback-analytics",
    linkLabel: "Feedback analytics",
    fill: "rgba(96,165,250,0.10)",
    stroke: "rgba(96,165,250,0.55)",
    text: "#60a5fa",
  },
];

const VBW = 1100;
const VBH = 320;
const NODE_W = 150;
const NODE_H = 84;
const ROW_Y = 110;
const GAP = (VBW - 2 * 32 - NODES.length * NODE_W) / (NODES.length - 1);
const FIRST_X = 32;

function nodeX(idx: number): number {
  return FIRST_X + idx * (NODE_W + GAP);
}

function PipelineSvg() {
  const navigate = useNavigate();
  return (
    <svg
      viewBox={`0 0 ${VBW} ${VBH}`}
      className="w-full h-auto"
      role="img"
      aria-label="VulnRap pipeline: intake, redact, score fusion, triage, store, and feedback loop. Each node links to its deep-dive documentation."
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <marker id="arrow-fwd" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#64748b" />
        </marker>
        <marker id="arrow-loop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#60a5fa" />
        </marker>
      </defs>

      <text x={VBW / 2} y={28} textAnchor="middle" fontSize={11} fontWeight={700} fill="#94a3b8" letterSpacing={2} fontFamily="ui-sans-serif, system-ui">
        DATA FLOW · LEFT TO RIGHT
      </text>

      {/* Forward connectors between adjacent nodes */}
      {NODES.slice(0, -1).map((_, i) => {
        const x1 = nodeX(i) + NODE_W;
        const x2 = nodeX(i + 1);
        const y = ROW_Y + NODE_H / 2;
        return (
          <line
            key={`edge-${i}`}
            x1={x1 + 2}
            y1={y}
            x2={x2 - 4}
            y2={y}
            stroke="#64748b"
            strokeWidth={1.5}
            markerEnd="url(#arrow-fwd)"
          />
        );
      })}

      {/* Feedback loop: from store/feedback back into score fusion */}
      {(() => {
        const startX = nodeX(5) + NODE_W / 2;
        const startY = ROW_Y + NODE_H;
        const endX = nodeX(2) + NODE_W / 2;
        const endY = ROW_Y + NODE_H;
        const dipY = startY + 90;
        return (
          <g>
            <path
              d={`M ${startX} ${startY} L ${startX} ${dipY} L ${endX} ${dipY} L ${endX} ${endY + 4}`}
              fill="none"
              stroke="#60a5fa"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              markerEnd="url(#arrow-loop)"
            />
            <rect x={(startX + endX) / 2 - 78} y={dipY - 11} width={156} height={22} rx={4} fill="rgba(96,165,250,0.10)" stroke="rgba(96,165,250,0.45)" />
            <text x={(startX + endX) / 2} y={dipY + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#60a5fa" fontFamily="ui-monospace, SFMono-Regular">
              feedback re-tunes weights
            </text>
          </g>
        );
      })()}

      {/* Nodes — clickable */}
      {NODES.map((n, i) => {
        const x = nodeX(i);
        return (
          <g
            key={n.id}
            role="link"
            aria-label={`${n.label}: ${n.linkLabel}`}
            tabIndex={0}
            style={{ cursor: "pointer" }}
            onClick={() => navigate(n.to)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                navigate(n.to);
              }
            }}
          >
            <rect x={x} y={ROW_Y} width={NODE_W} height={NODE_H} rx={10} fill={n.fill} stroke={n.stroke} strokeWidth={1.5} />
            <text x={x + NODE_W / 2} y={ROW_Y + 32} textAnchor="middle" fontSize={14} fontWeight={800} fill={n.text} fontFamily="ui-sans-serif, system-ui" letterSpacing={0.5}>
              {n.label.toUpperCase()}
            </text>
            <text x={x + NODE_W / 2} y={ROW_Y + 52} textAnchor="middle" fontSize={11} fill="#cbd5e1" fontFamily="ui-monospace, SFMono-Regular">
              {n.sub}
            </text>
            <text x={x + NODE_W / 2} y={ROW_Y + 70} textAnchor="middle" fontSize={9.5} fill="#94a3b8" fontFamily="ui-sans-serif, system-ui">
              click to explore →
            </text>
          </g>
        );
      })}

      {/* Stage numbers under each node */}
      {NODES.map((_, i) => (
        <text
          key={`num-${i}`}
          x={nodeX(i) + NODE_W / 2}
          y={ROW_Y - 8}
          textAnchor="middle"
          fontSize={10}
          fontWeight={700}
          fill="#475569"
          fontFamily="ui-monospace, SFMono-Regular"
          letterSpacing={1.2}
        >
          {`STAGE ${i + 1}`}
        </text>
      ))}
    </svg>
  );
}

const SEQ_VBW = 720;
const SEQ_VBH = 360;
const SEQ_LANES = ["Client", "API", "Redactor", "Engines", "Store"];
const SEQ_LANE_X = SEQ_LANES.map((_, i) => 70 + i * ((SEQ_VBW - 140) / (SEQ_LANES.length - 1)));

interface SeqMessage {
  from: number;
  to: number;
  y: number;
  label: string;
  reply?: boolean;
}

const SEQ_MESSAGES: SeqMessage[] = [
  { from: 0, to: 1, y: 90, label: "POST /api/reports/check { text }" },
  { from: 1, to: 2, y: 120, label: "redact(text)" },
  { from: 2, to: 1, y: 150, label: "{ redacted, findings }", reply: true },
  { from: 1, to: 3, y: 180, label: "score(redacted)" },
  { from: 3, to: 1, y: 220, label: "{ engines[], composite }", reply: true },
  { from: 1, to: 4, y: 250, label: "upsert(hash, score)" },
  { from: 4, to: 1, y: 280, label: "{ id, dupes[] }", reply: true },
  { from: 1, to: 0, y: 310, label: "{ id, score, triage, dupes }", reply: true },
];

function SequenceSvg() {
  return (
    <svg
      viewBox={`0 0 ${SEQ_VBW} ${SEQ_VBH}`}
      className="w-full h-auto"
      role="img"
      aria-label="Request sequence diagram: client posts a report, the API redacts it, scores it across engines, stores the hash, and returns the composite score with duplicates."
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <marker id="seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" />
        </marker>
        <marker id="seq-arrow-reply" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#34d399" />
        </marker>
      </defs>

      {/* Lane headers */}
      {SEQ_LANES.map((name, i) => (
        <g key={name}>
          <rect x={SEQ_LANE_X[i] - 50} y={26} width={100} height={28} rx={6} fill="rgba(15,23,42,0.65)" stroke="rgba(148,163,184,0.35)" />
          <text x={SEQ_LANE_X[i]} y={45} textAnchor="middle" fontSize={12} fontWeight={700} fill="#e2e8f0" fontFamily="ui-sans-serif, system-ui">
            {name}
          </text>
          {/* Lifeline */}
          <line x1={SEQ_LANE_X[i]} y1={56} x2={SEQ_LANE_X[i]} y2={SEQ_VBH - 20} stroke="rgba(148,163,184,0.25)" strokeDasharray="3 4" />
        </g>
      ))}

      {/* Messages */}
      {SEQ_MESSAGES.map((m, i) => {
        const x1 = SEQ_LANE_X[m.from];
        const x2 = SEQ_LANE_X[m.to];
        const stroke = m.reply ? "#34d399" : "#94a3b8";
        const marker = m.reply ? "url(#seq-arrow-reply)" : "url(#seq-arrow)";
        const labelX = (x1 + x2) / 2;
        return (
          <g key={i}>
            <line
              x1={x1}
              y1={m.y}
              x2={x2}
              y2={m.y}
              stroke={stroke}
              strokeWidth={1.5}
              strokeDasharray={m.reply ? "5 3" : undefined}
              markerEnd={marker}
            />
            <text
              x={labelX}
              y={m.y - 5}
              textAnchor="middle"
              fontSize={10.5}
              fill={m.reply ? "#34d399" : "#cbd5e1"}
              fontFamily="ui-monospace, SFMono-Regular"
            >
              {m.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function Architecture() {
  return (
    <div className="max-w-5xl mx-auto space-y-10">
      <div className="border-b border-border pb-6">
        <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
          <Network className="w-8 h-8 text-primary" />
          Architecture
        </h1>
        <p className="text-muted-foreground mt-2 max-w-3xl leading-relaxed">
          One picture of the whole pipeline so integrators know exactly where they hook in. Click any node in the
          diagram to jump to the deep dive for that stage.
        </p>
      </div>

      <section className="space-y-4">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Pipeline overview</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Intake → Redact → Score fusion → Triage → Store → Feedback loop.
            </p>
          </div>
          <p className="text-[11px] font-mono text-muted-foreground/70 uppercase tracking-widest">
            Click a node ↓
          </p>
        </div>

        <div
          className="relative rounded-xl border border-cyan-500/15 p-3 sm:p-5 overflow-hidden"
          style={{
            background: "linear-gradient(135deg, rgba(15,23,42,0.65) 0%, rgba(15,23,42,0.35) 100%)",
            boxShadow: "0 0 0 1px rgba(0,255,255,0.04) inset, 0 8px 32px rgba(0,0,0,0.35)",
          }}
        >
          <div className="overflow-x-auto">
            <div className="min-w-[720px]">
              <PipelineSvg />
            </div>
          </div>
        </div>

        {/* Plain-text fallback / quick-link grid for keyboard users and tiny screens */}
        <ul className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          {NODES.map((n) => (
            <li key={n.id}>
              <Link
                to={n.to}
                className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-border/60 bg-card/40 hover:border-primary/40 hover:text-primary transition-colors"
                style={{ borderLeftColor: n.text, borderLeftWidth: 3 }}
              >
                <span className="flex flex-col">
                  <span className="font-semibold text-foreground">{n.label}</span>
                  <span className="text-muted-foreground">{n.linkLabel}</span>
                </span>
                <ArrowRight className="w-3.5 h-3.5 shrink-0 opacity-60" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Request flow</h2>
          <p className="text-sm text-muted-foreground mt-1">
            What happens between a single <code className="font-mono text-xs text-primary">POST /api/reports/check</code> and the
            response your integration receives.
          </p>
        </div>

        <div
          className="relative rounded-xl border border-emerald-500/15 p-3 sm:p-5 overflow-hidden"
          style={{
            background: "linear-gradient(135deg, rgba(15,23,42,0.65) 0%, rgba(15,23,42,0.35) 100%)",
            boxShadow: "0 0 0 1px rgba(16,185,129,0.04) inset, 0 8px 32px rgba(0,0,0,0.35)",
          }}
        >
          <div className="overflow-x-auto">
            <div className="min-w-[640px]">
              <SequenceSvg />
            </div>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Reply arrows are dashed and green. Nothing is persisted until the store step — the redactor and engines
          operate on in-memory text, and the original payload is discarded after the response is built.
        </p>
      </section>

      <section className="text-xs text-muted-foreground/70 pb-4">
        See also:{" "}
        <Link to="/developers" className="text-primary/80 hover:text-primary">API reference</Link>
        {" · "}
        <Link to="/transparency" className="text-primary/80 hover:text-primary">Engine transparency</Link>
        {" · "}
        <Link to="/privacy" className="text-primary/80 hover:text-primary">Privacy &amp; redaction</Link>
        {" · "}
        <Link to="/feedback-analytics" className="text-primary/80 hover:text-primary">Feedback analytics</Link>
      </section>
    </div>
  );
}
