import { Link, useLocation } from "react-router-dom";
import { ArrowRight, FileWarning, Lock, Send } from "lucide-react";
import { Button } from "@/components/ui/button";

const E1_HEX = { fill: "#facc15", track: "rgba(250,204,21,0.10)", ring: "rgba(250,204,21,0.35)" };
const E2_HEX = { fill: "#22d3ee", track: "rgba(34,211,238,0.10)", ring: "rgba(34,211,238,0.35)" };
const E3_HEX = { fill: "#a78bfa", track: "rgba(167,139,250,0.10)", ring: "rgba(167,139,250,0.35)" };

function EngineLine({
  label,
  raw,
  effective,
  width,
  weight,
  hex,
  note,
  inverted,
}: {
  label: string;
  raw: number;
  effective?: number;
  width: number;
  weight: number;
  hex: { fill: string; track: string; ring: string };
  note?: string;
  inverted?: boolean; // Engine 1 (AI Authorship) is inverted in the composite: lower raw = higher contribution.
}) {
  const clamped = effective !== undefined && effective !== raw;
  const shownPct = (clamped ? effective! : raw) / 100;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[12px] sm:text-[13px] font-mono">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: hex.fill }} />
          <span className="text-slate-200 font-semibold truncate">{label}</span>
          <span className="text-slate-500 hidden sm:inline">{`\u00D7${weight}%`}</span>
        </div>
        <div className="text-right shrink-0 tabular-nums">
          {clamped ? (
            <>
              <span className="text-slate-500 line-through mr-1.5">{raw}</span>
              <span className="font-bold" style={{ color: hex.fill }}>{effective}</span>
            </>
          ) : (
            <span className="font-bold" style={{ color: hex.fill }}>{raw}</span>
          )}
          <span className="text-slate-500"> / 100</span>
        </div>
      </div>
      <div
        className="relative h-2 rounded-full overflow-hidden"
        style={{ background: hex.track, boxShadow: `inset 0 0 0 1px ${hex.ring}` }}
      >
        {clamped && (
          <div
            className="absolute inset-y-0 left-0 opacity-30"
            style={{ width: `${raw}%`, background: hex.fill }}
            aria-hidden
          />
        )}
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${shownPct * 100}%`, background: hex.fill }}
        />
      </div>
      <div className="flex items-baseline justify-between gap-2 text-[10.5px] sm:text-[11px] font-mono text-slate-500 leading-tight">
        <span className="truncate">{note}</span>
        <span className="shrink-0 tabular-nums">
          {inverted ? (
            <>0.{weight.toString().padStart(2, "0")} {`\u00D7`} (100 {`\u2212`} {raw}) ={" "}</>
          ) : (
            <>0.{weight.toString().padStart(2, "0")} {`\u00D7`} {clamped ? effective : raw} ={" "}</>
          )}
          <span className="text-slate-300">{width.toFixed(2)}</span>
        </span>
      </div>
    </div>
  );
}

export default function NotFound() {
  const location = useLocation();
  // Sanitize the path for display: strip any HTML-ish characters, cap length.
  const rawPath = (location.pathname || "/") + (location.search || "");
  const sanitized = rawPath.replace(/[<>"'`]/g, "").slice(0, 80);
  const displayPath = sanitized.length < rawPath.length ? sanitized + "\u2026" : sanitized;

  // Engine math (matches the real composite formula on the home page diagram).
  // E1 is inverted in the weighted sum: contribution = 0.05 * (100 - rawE1).
  // E2 < 30 fires the substance gate, which would cap E3 at 42 in the sum.
  // Here raw E3 (8) is already below 42, so the gate fires conceptually but
  // produces no visible clamp — we show that honestly in the annotation copy.
  //   E1 contrib: 0.05 * (100 - 87) = 0.65
  //   E2 contrib: 0.55 * 0          = 0.00
  //   E3 contrib: 0.40 * 8          = 3.20
  //   Composite : 3.85              → rounds to 4 (AUTO_CLOSE band, < 25)
  const e1Raw = 87;
  const e2Raw = 0;
  const e3Raw = 8;
  const e3Eff = 8;
  const e1Contrib = 0.05 * (100 - e1Raw);
  const e2Contrib = 0.55 * e2Raw;
  const e3Contrib = 0.40 * e3Eff;
  const composite = Math.round(e1Contrib + e2Contrib + e3Contrib);

  return (
    <div className="min-h-[70vh] py-10 sm:py-16 px-4 flex items-start justify-center">
      <div className="w-full max-w-2xl space-y-6">
        {/* Glass scorecard */}
        <div
          className="relative rounded-xl border border-cyan-500/20 p-5 sm:p-7 overflow-hidden"
          style={{
            background: "linear-gradient(135deg, rgba(15,23,42,0.75) 0%, rgba(15,23,42,0.45) 100%)",
            boxShadow: "0 0 0 1px rgba(0,255,255,0.04) inset, 0 8px 32px rgba(0,0,0,0.35)",
          }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.18]"
            style={{
              background:
                "radial-gradient(ellipse 60% 40% at 12% 100%, rgba(244,63,94,0.22), transparent 70%), radial-gradient(ellipse 60% 40% at 88% 0%, rgba(52,211,153,0.18), transparent 70%)",
            }}
          />

          <div className="relative space-y-5">
            {/* Status header */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-[10.5px] sm:text-[11px] font-mono font-bold tracking-[0.18em] text-slate-400 uppercase">
                <FileWarning className="w-3.5 h-3.5 text-rose-400" />
                Report received {`\u00B7`} triage complete
              </div>
              <div className="text-[10.5px] sm:text-[11px] font-mono font-bold tracking-[0.18em] text-rose-400 uppercase">
                404 {`\u00B7`} not found
              </div>
            </div>

            {/* The "report" — the URL the visitor mistyped */}
            <div className="space-y-2">
              <div className="text-[10px] font-mono font-bold tracking-[0.18em] text-slate-500 uppercase">
                Report contents
              </div>
              <div
                className="font-mono text-sm sm:text-[15px] text-slate-200 break-all rounded-lg px-3 py-2.5 border border-slate-700/60"
                style={{ background: "rgba(2,6,23,0.55)" }}
                aria-label={`Missing path: ${displayPath}`}
              >
                <span className="text-cyan-400">GET</span> {displayPath}
              </div>
              <div className="text-[12px] sm:text-[13px] text-slate-400 italic leading-snug">
                No proof of concept. No payload. No file path. No CVSS. No CWE cited.
                <br />
                Just{" "}
                <span className="text-slate-500 line-through">a critical zero-day</span>
                {" "}a URL that doesn{"\u2019"}t exist.
              </div>
            </div>

            {/* Engine scores */}
            <div className="space-y-3.5 pt-1">
              <EngineLine
                label="AI Authorship"
                raw={e1Raw}
                width={e1Contrib}
                weight={5}
                hex={E1_HEX}
                note="Reads like an LLM made it up."
                inverted
              />
              <EngineLine
                label="Technical Substance"
                raw={e2Raw}
                width={e2Contrib}
                weight={55}
                hex={E2_HEX}
                note="Zero evidence. Zero reproduction steps."
              />
              <div className="space-y-1">
                <EngineLine
                  label="CWE Coherence"
                  raw={e3Raw}
                  effective={e3Eff}
                  width={e3Contrib}
                  weight={40}
                  hex={E3_HEX}
                  note="No weakness identified."
                />
                <div
                  className="inline-flex items-center gap-1.5 text-[10.5px] font-mono font-semibold rounded px-2 py-1"
                  style={{
                    background: "rgba(251,191,36,0.10)",
                    color: "#fbbf24",
                    border: "1px solid rgba(251,191,36,0.45)",
                  }}
                >
                  <Lock className="w-3 h-3" />
                  substance gate {`\u00B7`} E2 {`<`} 30 {`\u2192`} would cap E3 at 42
                </div>
              </div>
            </div>

            {/* Composite + verdict */}
            <div className="pt-2 mt-2 border-t border-slate-800 flex items-end justify-between gap-4 flex-wrap">
              <div>
                <div className="text-[10px] font-mono font-bold tracking-[0.18em] text-slate-500 uppercase mb-1">
                  Composite score
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-5xl sm:text-6xl font-extrabold text-rose-400 tabular-nums leading-none">
                    {composite}
                  </span>
                  <span className="text-slate-500 font-mono text-sm">/ 100</span>
                </div>
                <div className="text-[11px] font-mono text-slate-500 mt-1">
                  {e1Contrib.toFixed(2)} + {e2Contrib.toFixed(2)} + {e3Contrib.toFixed(2)} ={" "}
                  {(e1Contrib + e2Contrib + e3Contrib).toFixed(2)} {`\u2248`} {composite}
                </div>
              </div>
              <div className="flex flex-col items-stretch sm:items-end gap-1.5">
                <div className="text-[10px] font-mono font-bold tracking-[0.18em] text-slate-500 uppercase">
                  Triage verdict
                </div>
                <div
                  className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 font-mono font-bold text-sm"
                  style={{
                    background: "rgba(244,63,94,0.12)",
                    color: "#fb7185",
                    border: "1px solid rgba(244,63,94,0.45)",
                  }}
                >
                  AUTO_CLOSE
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* The story — what VulnRap is, in two beats */}
        <div className="space-y-3 px-1">
          <p className="text-slate-300 text-[14px] sm:text-[15px] leading-relaxed">
            <span className="font-bold text-cyan-400">VulnRap</span> scores vulnerability reports the
            same way we just scored that URL{": "}
            <span className="font-mono text-slate-200">5%</span> AI Authorship,{" "}
            <span className="font-mono text-slate-200">55%</span> Technical Substance,{" "}
            <span className="font-mono text-slate-200">40%</span> CWE Coherence{". "}
            About <span className="font-bold text-slate-200">78%</span> of submissions PSIRT teams
            see right now look{" "}
            <span className="italic text-slate-400">a lot like the report above</span>{": "}
            confidently written, technically empty.
          </p>
          <p className="text-slate-400 text-[13px] sm:text-[14px] leading-relaxed">
            We help triagers spend their time on the other 22%. Paste a report, get a composite
            score and a triage action in seconds {`\u2014`} no signup, no upload, nothing stored
            unless you ask.
          </p>
        </div>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
          <Button asChild className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold flex-1">
            <Link to="/">
              <Send className="w-4 h-4 mr-2" />
              Submit a real report
            </Link>
          </Button>
          <Button asChild variant="outline" className="border-slate-700 hover:bg-slate-800 flex-1">
            <Link to="/developers">
              See the API
              <ArrowRight className="w-4 h-4 ml-2" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
