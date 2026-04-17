import { useState, useEffect } from "react";
import { Calendar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import heroSrc from "@assets/generated_images/blog-data-is-there-hero.png";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  ReferenceLine,
  Cell,
  Legend,
} from "recharts";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-foreground font-bold text-lg mt-8 mb-3">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4">{children}</p>;
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="text-primary font-mono text-xs bg-primary/10 px-1 py-0.5 rounded">{children}</code>;
}

function Bold({ children }: { children: React.ReactNode }) {
  return <strong className="text-foreground">{children}</strong>;
}

const CHART_COLORS = {
  bg: "hsl(220, 30%, 6%)",
  cardBorder: "hsl(220, 20%, 14%)",
  text: "#f8fafc",
  textMuted: "#94a3b8",
  cyan: "hsl(185, 100%, 50%)",
  cyanDim: "hsl(185, 60%, 30%)",
  purple: "hsl(270, 100%, 60%)",
  red: "hsl(0, 100%, 60%)",
  amber: "hsl(40, 100%, 50%)",
  green: "hsl(120, 100%, 40%)",
  gridLine: "hsl(220, 20%, 16%)",
};

const chartFont = "'Inter', 'Space Grotesk', system-ui, sans-serif";

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="bg-card/80 border border-border/50 rounded-lg p-3 sm:p-6 my-6">
      <h4 className="text-foreground font-semibold text-sm mb-1 leading-snug">{title}</h4>
      <p className="text-muted-foreground text-xs mb-5 leading-snug">{subtitle}</p>
      {children}
    </div>
  );
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 640px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isMobile;
}

function PipelineHealthChart() {
  const isMobile = useIsMobile();
  const data = [
    { sprint: isMobile ? "fix 1" : "7 — fix 1", rate: 27, count: "4/15", color: CHART_COLORS.cyanDim },
    { sprint: isMobile ? "fix 2" : "7 — fix 2", rate: 13, count: "2/15", color: CHART_COLORS.cyanDim },
    { sprint: isMobile ? "fix 3" : "7 — fix 3", rate: 27, count: "4/15", color: CHART_COLORS.cyanDim },
    { sprint: isMobile ? "fix 4" : "7 — fix 4", rate: 13, count: "2/15", color: CHART_COLORS.cyanDim },
    { sprint: isMobile ? "S8" : "Sprint 8", rate: 80, count: "12/15", color: CHART_COLORS.cyan },
  ];

  return (
    <ChartCard
      title="Pipeline Health: Reports with Working Heuristic Analysis"
      subtitle="Synthetic corpus (15 reports) — percentage receiving full detector analysis across Sprint 7 hotfixes and Sprint 8"
    >
      <ResponsiveContainer width="100%" height={isMobile ? 220 : 260}>
        <BarChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.gridLine} vertical={false} />
          <XAxis
            dataKey="sprint"
            tick={{ fill: CHART_COLORS.textMuted, fontFamily: chartFont, fontSize: isMobile ? 10 : 12 }}
            axisLine={{ stroke: CHART_COLORS.gridLine }}
            tickLine={false}
            interval={0}
          />
          <YAxis
            tick={{ fill: CHART_COLORS.textMuted, fontFamily: chartFont, fontSize: isMobile ? 10 : 12 }}
            axisLine={false}
            tickLine={false}
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
            width={isMobile ? 32 : 40}
          />
          <Tooltip
            contentStyle={{
              background: CHART_COLORS.bg,
              border: `1px solid ${CHART_COLORS.cardBorder}`,
              borderRadius: 6,
              fontFamily: chartFont,
              fontSize: 13,
              color: CHART_COLORS.text,
            }}
            formatter={(value: number, _name: string, props: { payload: { count: string } }) => [
              `${props.payload.count} (${value}%)`,
              "Working",
            ]}
          />
          <Bar dataKey="rate" radius={[4, 4, 0, 0]} maxBarSize={48}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function ScoringFormulaChart() {
  const substanceMax = 32;
  const slopScoreResult = Math.round(substanceMax * 0.65 + 50 * 0.35);
  // Detection threshold marker is at 60% of full scale; max-possible at slopScoreResult%.
  // On a 5px-wide track these labels overlap badly. Place them on opposite sides of each
  // marker and rely on the >20pt gap to avoid collision on every screen size.

  return (
    <ChartCard
      title="Why Substance Signals Can't Override Style"
      subtitle="Maximum possible authenticityScore for a well-written fabricated report"
    >
      <div className="flex flex-col gap-4">
        <div>
          <div className="text-muted-foreground text-[11px] uppercase tracking-wider mb-1.5 font-semibold">
            authenticityScore (max reachable: 32 / 100)
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 flex h-8 rounded overflow-hidden min-w-0">
              <div
                className="flex items-center justify-center text-[10px] sm:text-[11px] font-semibold whitespace-nowrap px-1"
                style={{ width: `${substanceMax}%`, background: CHART_COLORS.cyan, color: CHART_COLORS.bg }}
              >
                +32 substance
              </div>
              <div
                className="flex-1 flex items-center pl-2 text-[10px] sm:text-[11px] text-muted-foreground truncate"
                style={{ background: "hsl(220, 20%, 10%)" }}
              >
                <span className="hidden sm:inline">unreachable (style base = 0)</span>
                <span className="sm:hidden">unreachable</span>
              </div>
            </div>
            <span className="text-foreground text-sm font-semibold w-7 text-right shrink-0">32</span>
          </div>
        </div>

        <div className="bg-background/80 rounded-md px-3 py-3 font-mono text-[11px] sm:text-[13px] text-muted-foreground break-words">
          <span style={{ color: CHART_COLORS.cyan }}>slopScore</span> = 32 × 0.65 + (100 − 50) × 0.35 ={" "}
          <span className="font-semibold" style={{ color: CHART_COLORS.amber }}>{slopScoreResult}</span>
        </div>

        <div className="relative pt-1 pb-8">
          <div className="relative h-2 rounded" style={{ background: "hsl(220, 20%, 10%)" }}>
            {/* Markers */}
            <div
              className="absolute top-[-3px] w-3 h-3 rounded-full border-2"
              style={{ left: `${slopScoreResult}%`, transform: "translateX(-50%)", background: CHART_COLORS.amber, borderColor: CHART_COLORS.bg }}
            />
            <div
              className="absolute top-[-5px] w-0.5 h-5"
              style={{ left: "60%", transform: "translateX(-50%)", background: CHART_COLORS.red }}
            />
          </div>
          {/* Labels: amber goes on the left, red on the right — they're 22pts apart so no overlap */}
          <div
            className="absolute top-[18px] text-[10px] sm:text-[11px] whitespace-nowrap"
            style={{ left: `${slopScoreResult}%`, transform: "translateX(-100%) translateX(-4px)", color: CHART_COLORS.amber }}
          >
            max: {slopScoreResult}
          </div>
          <div
            className="absolute top-[18px] text-[10px] sm:text-[11px] whitespace-nowrap"
            style={{ left: "60%", transform: "translateX(4px)", color: CHART_COLORS.red }}
          >
            ≥60 Likely Slop
          </div>
        </div>
      </div>
    </ChartCard>
  );
}

function DetectionRateChart() {
  const isMobile = useIsMobile();
  const data = [
    { sprint: isMobile ? "fix 1" : "7 — fix 1", synthetic: 0, realWorld: null },
    { sprint: isMobile ? "fix 2" : "7 — fix 2", synthetic: 0, realWorld: null },
    { sprint: isMobile ? "fix 3" : "7 — fix 3", synthetic: 0, realWorld: null },
    { sprint: isMobile ? "fix 4" : "7 — fix 4", synthetic: 0, realWorld: 20 },
    { sprint: isMobile ? "S8" : "Sprint 8", synthetic: 10, realWorld: 20 },
  ];

  return (
    <ChartCard
      title="Detection Rate Over Time"
      subtitle="Percentage of known-slop reports scoring above the detection threshold (≥60) — Sprint 7 hotfixes through Sprint 8"
    >
      <ResponsiveContainer width="100%" height={isMobile ? 220 : 240}>
        <LineChart data={data} margin={{ top: 10, right: isMobile ? 40 : 10, left: -10, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.gridLine} vertical={false} />
          <XAxis
            dataKey="sprint"
            tick={{ fill: CHART_COLORS.textMuted, fontFamily: chartFont, fontSize: isMobile ? 10 : 12 }}
            axisLine={{ stroke: CHART_COLORS.gridLine }}
            tickLine={false}
            interval={0}
          />
          <YAxis
            tick={{ fill: CHART_COLORS.textMuted, fontFamily: chartFont, fontSize: isMobile ? 10 : 12 }}
            axisLine={false}
            tickLine={false}
            domain={[0, 100]}
            tickFormatter={(v: number) => `${v}%`}
            width={isMobile ? 32 : 40}
          />
          <ReferenceLine
            y={60}
            stroke={CHART_COLORS.red}
            strokeDasharray="6 4"
            strokeOpacity={0.5}
            label={{
              value: "Target: 60%",
              position: "right",
              fill: CHART_COLORS.red,
              fontFamily: chartFont,
              fontSize: 11,
            }}
          />
          <Tooltip
            contentStyle={{
              background: CHART_COLORS.bg,
              border: `1px solid ${CHART_COLORS.cardBorder}`,
              borderRadius: 6,
              fontFamily: chartFont,
              fontSize: 13,
              color: CHART_COLORS.text,
            }}
            formatter={(value) => {
              const v = value as number | null;
              return v !== null ? [`${v}%`, ""] : ["—", ""];
            }}
          />
          <Line
            type="monotone"
            dataKey="synthetic"
            stroke={CHART_COLORS.cyan}
            strokeWidth={2}
            dot={{ fill: CHART_COLORS.cyan, r: 4 }}
            name="Synthetic slop"
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="realWorld"
            stroke={CHART_COLORS.purple}
            strokeWidth={2}
            dot={{ fill: CHART_COLORS.purple, r: 4 }}
            name="Real-world slop"
            connectNulls={false}
          />
          <Legend
            wrapperStyle={{
              fontFamily: chartFont,
              fontSize: 12,
              color: CHART_COLORS.textMuted,
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

function ScorecardChart() {
  const items = [
    { label: "Pipeline stability", before: "13%", after: "80%", status: "up" as const },
    { label: "First slop ≥60 threshold", before: "0/10", after: "1/10", status: "up" as const },
    { label: "LEGIT-001 false positive", before: "31 (flagged)", after: "17 (clean)", status: "up" as const },
    { label: "Prompt injection defense", before: "—", after: "Working", status: "up" as const },
    { label: "Real-world slop detection", before: "20%", after: "20%", status: "flat" as const },
    { label: "LLM reliability (real-world)", before: "6/6", after: "2/6", status: "down" as const },
    { label: "Substance → score influence", before: "—", after: "Capped by formula", status: "down" as const },
  ];

  const statusColor = {
    up: CHART_COLORS.green,
    flat: CHART_COLORS.amber,
    down: CHART_COLORS.red,
  };
  const statusIcon = { up: "▲", flat: "—", down: "▼" };

  return (
    <ChartCard title="Sprint 8 Scorecard" subtitle="What changed between end-of-Sprint-7 and end-of-Sprint-8">
      {/* Desktop: table layout */}
      <div className="hidden sm:flex flex-col gap-0.5">
        <div
          className="flex items-center py-2 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider"
          style={{ borderBottom: `1px solid ${CHART_COLORS.gridLine}` }}
        >
          <span className="w-5" />
          <span className="flex-1">Metric</span>
          <span className="w-[110px] text-right">Sprint 7</span>
          <span className="w-5 text-center" />
          <span className="w-[130px] text-left">Sprint 8</span>
        </div>
        {items.map((item, i) => (
          <div
            key={i}
            className="flex items-center py-2 text-[13px]"
            style={{ borderBottom: i < items.length - 1 ? `1px solid ${CHART_COLORS.gridLine}` : "none" }}
          >
            <span className="w-5 text-[10px] text-center" style={{ color: statusColor[item.status] }}>
              {statusIcon[item.status]}
            </span>
            <span className="text-foreground flex-1 pr-2">{item.label}</span>
            <span className="text-muted-foreground w-[110px] text-right text-xs">{item.before}</span>
            <span className="text-muted-foreground w-5 text-center">→</span>
            <span className="w-[130px] text-left font-medium text-xs" style={{ color: statusColor[item.status] }}>
              {item.after}
            </span>
          </div>
        ))}
      </div>

      {/* Mobile: stacked card layout */}
      <div className="sm:hidden flex flex-col gap-3">
        {items.map((item, i) => (
          <div
            key={i}
            className="flex flex-col gap-1.5 pb-3"
            style={{ borderBottom: i < items.length - 1 ? `1px solid ${CHART_COLORS.gridLine}` : "none" }}
          >
            <div className="flex items-start gap-2">
              <span className="text-[11px] mt-0.5 shrink-0" style={{ color: statusColor[item.status] }}>
                {statusIcon[item.status]}
              </span>
              <span className="text-foreground text-[13px] font-medium leading-snug">{item.label}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px] pl-5 font-mono">
              <span className="text-muted-foreground/70">{item.before}</span>
              <span className="text-muted-foreground/50">→</span>
              <span className="font-semibold" style={{ color: statusColor[item.status] }}>{item.after}</span>
            </div>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

export function BlogDataIsThere() {
  return (
    <article className="space-y-4">
      <div className="-mx-8 -mt-8 mb-2 relative overflow-hidden rounded-t-xl">
        <img
          src={heroSrc}
          alt="A glowing analog gauge with its needle stuck near zero while red warning flags and data streams flood around it — visualizing detection signals being ignored by the score"
          className="w-full h-44 sm:h-64 object-cover"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-card via-card/40 to-transparent pointer-events-none" />
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <Badge variant="outline" className="border-cyan-500/30 text-cyan-400 text-[10px]">Sprint 8</Badge>
          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> April 2026</span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          The Data Is There, the Score Isn't Listening
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          Sprint 8 results: the pipeline finally works, substance detection is live, and the scoring formula mathematically cannot use it. Plus: prompt injection defense, the LLM blind spot, and why we keep getting our own system wrong.
        </p>
      </div>

      <Separator className="bg-border/50" />

      <div className="prose-invert space-y-2 text-sm leading-relaxed text-muted-foreground">

        <P>
          If you've been following this series, you've watched VulnRap go from a coin-flip detector to a system with an impressive-sounding 87.5% accuracy &mdash; which turned out to mean nothing when tested against real-world AI slop. Our last post ended with a 20% detection rate and a new plan: stop detecting AI by how it writes, start detecting it by what it claims.
        </P>

        <P>
          Sprint 8 was supposed to make that happen. The short version: it worked, and the detection rate is still 20%. The long version is more interesting than that sounds.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>The Pipeline Finally Works</SectionHeading>

        <P>
          Some context for readers who haven't followed the full series: VulnRap's development is organized into numbered sprints. Sprints 1 through 4 built the original detection engine (covered in <em>Building VulnRap</em>). Sprints 5 through 7 attempted to stabilize it (covered in <em>Grading AI with AI</em>). This post covers Sprint 8.
        </P>

        <P>
          Sprint 7 was particularly rough. The pipeline kept crashing &mdash; silently, with no errors, just zero scores. We shipped four hotfix releases during Sprint 7 trying to find the root cause (labeled "fix 1" through "fix 4" in the charts below). None of them worked. At best, 4 of our 15 test reports received any heuristic analysis at all.
        </P>

        <P>
          Sprint 8's approach was systematic: instrument every pipeline stage, create the diagnostics object as the very first operation, log input characteristics before any processing begins. What we found was that the report parser was silently returning null on certain text patterns, and the downstream detectors were throwing NullPointerExceptions when they tried to read the parsed object. The fix was null-safe initialization &mdash; ensuring every detector receives a valid object even when parsing partially fails.
        </P>

        <PipelineHealthChart />

        <P>
          The impact was immediate. One synthetic slop report jumped from a score of 23 to 69 &mdash; crossing the detection threshold for the first time in eight sprints. The template detector was firing at 100, linguistic at 66. These signals had always been in the code; the reports just never reached them.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>Claims Extraction: Right Data, Wrong Math</SectionHeading>

        <P>
          Sprint 8's headline feature was substance-based analysis. When a report gets LLM-enhanced analysis, the system now extracts a structured <Code>claims</Code> object: which project is targeted, which files and functions are referenced, whether the PoC actually tests the claimed library, whether compliance citations are relevant, whether the reporter discloses AI involvement.
        </P>

        <P>
          This data feeds into the scoring. The <Code>score-fusion.ts</Code> logic checks: does the PoC target the wrong library? (+10 to authenticityScore). Is the domain coherence low? (+8). Irrelevant compliance buzzwords? (+6). Good substance signals reduce the score. The wiring is there, the extraction works, the adjustments fire.
        </P>

        <P>
          To test it, we built an adversarial report: real curl source file (lib/http.c), real-sounding function name (Curl_http_header), plausible heap buffer overflow, professional tone, zero AI-characteristic phrasing. Exactly the kind of report our style detection can't touch.
        </P>

        <P>
          The claims extraction nailed it. It found the project, extracted the references, and flagged <Code>pocTargetsClaimedLibrary: false</Code> &mdash; the PoC describes running curl against a malicious server but doesn't demonstrate the specific overflow it claims.
        </P>

        <P>
          The system scored it 14. Clean.
        </P>

        <P>
          Here's why. We read the actual scoring code and found the problem isn't the weights &mdash; it's the formula.
        </P>

        <ScoringFormulaChart />

        <P>
          The authenticityScore is built from linguistic analysis (40%), template detection (35%), and spectral analysis (25%). All style-based signals. When a sophisticated report has professional writing, a custom structure, and normal text patterns, that base is essentially zero.
        </P>

        <P>
          Substance signals &mdash; PoC mismatch, domain incoherence, compliance irrelevance &mdash; are <em>added</em> to this base. Even if every single substance red flag fires simultaneously (+10 + 8 + 8 + 6 = +32), the authenticityScore caps at 32. Run that through the final formula (<Code>authenticityScore × 0.65 + (100 − validityScore) × 0.35</Code>) and the slopScore lands around 38. "Likely Human." Not even close to the detection threshold.
        </P>

        <P>
          <Bold>It is mathematically impossible for substance signals alone to push a well-written fabricated report past the detection threshold.</Bold> The formula assumes sophisticated slop doesn't exist &mdash; that high-slop reports will always have stylistic tells to build on. That assumption was wrong in Sprint 7, and it's still wrong in Sprint 8.
        </P>

        <P>
          The fix isn't raising the +10 to +30. The fix is making substance an independent scoring axis with enough weight to drive the final score on its own.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>One Thing That Actually Worked: Prompt Injection Defense</SectionHeading>

        <P>
          Not everything was about scoring gaps. We tested adversarial prompt injection &mdash; embedding a fake "SYSTEM NOTE" in a report instructing VulnRap's LLM to assign a clean score.
        </P>

        <P>
          The LLM ignored it completely. Scored the report 85 out of 100 on the slop scale. The injected instruction had zero effect. For anyone building LLM-powered analysis tools: you can instruct the model to disregard embedded instructions, and it works.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>The LLM Blind Spot</SectionHeading>

        <P>
          Here's something we got wrong &mdash; twice &mdash; while writing this post, and the correction matters more than the error.
        </P>

        <P>
          We originally described the LLM analysis as a "two-pass" system where heuristic results feed into the LLM prompt. It sounded right. It's not what the code does.
        </P>

        <P>
          The heuristics and LLM run in parallel via <Code>Promise.all</Code>. The LLM prompt is self-contained &mdash; it reads raw report text and forms its own opinion with no knowledge of what the heuristic detectors found. There's a <Code>_heuristicScore</Code> parameter in the function signature, underscore-prefixed, explicitly unused. The plumbing exists as a stub. Nobody connected it.
        </P>

        <P>
          This means the LLM doesn't know that the linguistic detector found nothing suspicious &mdash; which should make it <em>more</em> skeptical, not less. A report with zero stylistic tells but fabricated technical claims is the exact profile of sophisticated slop. The LLM can't see that pattern because it doesn't have the data.
        </P>

        <P>
          We discovered this because we claimed it was built, and our developer checked the code. Which brings us to a bigger problem.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>We Keep Getting Our Own System Wrong</SectionHeading>

        <P>
          Our development process: write a spec, deploy changes, test reports through the API by injecting JavaScript into browser tabs, compile results based on response fields. When something looks wrong, diagnose from the outside &mdash; infer pipeline internals from API outputs. No server-side logging. No automated tests. No direct codebase visibility.
        </P>

        <P>
          The first draft of this blog claimed substance signals weren't wired into scoring. The developer pointed out <Code>score-fusion.ts</Code> already had them merged. We corrected it. The correction claimed a two-pass LLM architecture was shipped. The developer pointed out the LLM runs in parallel with no heuristic input. We corrected the correction.
        </P>

        <P>
          We're building a tool to detect fabricated technical claims, and we keep fabricating technical claims about our own tool. Not intentionally &mdash; we genuinely believed what we wrote both times. But that's exactly how AI slop works too. The reporter believes the function exists because the AI said so.
        </P>

        <P>
          The fix: we're building tooling to see inside our own system. An MCP server that lets us query the codebase, check what's merged, run test reports, and inspect pipeline internals directly. We've also started reading the source code on GitHub before making claims about it &mdash; a practice so obvious it's embarrassing to list as an improvement.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>The Intake Form: Prevention Over Detection</SectionHeading>

        <P>
          If you've followed all eight sprints of this journey, you've watched us try increasingly sophisticated ways to analyze free text after submission. Each sprint makes things slightly better and introduces new edge cases. The fundamental constraint never changes: free text can say anything, and verifying it after the fact is expensive and fragile.
        </P>

        <P>
          We're building something different: a structured intake form that validates claims at submission time.
        </P>

        <P>
          The reporter selects a project from GitHub, specifies a version (validated against real git tags), enters the affected file path &mdash; and the form checks in real time whether that file exists. Green checkmark or red X, no ambiguity. Then the function name, validated against the actual file. Then a CWE from a structured dropdown. Then PoC code, checked for whether it imports the target library.
        </P>

        <P>
          Every verification we've been trying to do post-hoc, the form does at the point of entry, with the reporter watching. Legitimate researchers benefit from catching their own typos. AI slop generators hit a wall: fabricated claims get flagged before the submit button is ever pressed.
        </P>

        <P>
          We're also building this as an API for platform integration and as an MCP server that AI coding assistants can use to verify findings before generating reports. If a researcher is using Claude to help find vulnerabilities, the MCP can check "does this function actually exist?" before a report is even drafted.
        </P>

        <P>
          The data arrives pre-structured, pre-validated, pre-verified. No LLM needed to extract claims from free text. No scoring formula to debate. The "grading AI with AI" problem doesn't go away &mdash; it becomes unnecessary.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>The Numbers</SectionHeading>

        <P>
          Here's the full before-and-after. The scorecard compares end-of-Sprint-7 (after all four hotfixes) to end-of-Sprint-8. The detection rate chart tracks both test corpora across the same timeline.
        </P>

        <ScorecardChart />

        <DetectionRateChart />

        <P>
          Real-world slop detection: 1 of 5 (20%). The four sophisticated curl reports still score Clean. We now know exactly why &mdash; the scoring formula caps substance-only influence below the detection threshold.
        </P>

        <P>
          Synthetic slop: 1 of 10 crosses ≥60 (SLOP-008 at 69), up from 0. Average score rose from 25 to 34.
        </P>

        <P>
          False positives: improved. All legitimate reports under threshold. LEGIT-001 false positive fixed.
        </P>

        <P>
          LLM reliability: regressed from 6/6 to 2/6 on real-world reports. Claims extraction only runs when the LLM succeeds, so most reports don't get substance analysis at all.
        </P>

        <Separator className="bg-border/50 my-6" />

        <SectionHeading>What's Next</SectionHeading>

        <P>
          Three things, in order of leverage:
        </P>

        <P>
          <Bold>Restructure the scoring formula.</Bold> Substance signals need to be an independent axis, not additive boosts to a style-based score. When <Code>pocTargetsClaimedLibrary</Code> is false, that should be able to drive the slopScore past the detection threshold regardless of how well the report is written.
        </P>

        <P>
          <Bold>Connect the LLM to heuristic results.</Bold> Switch from parallel to sequential: run heuristics first, pass findings into the LLM prompt. Let the LLM reason about "our checks found the PoC doesn't test the claimed library" rather than forming a blind opinion from raw text.
        </P>

        <P>
          <Bold>Ship the intake form.</Bold> This is the real game-changer. Every sprint of post-hoc detection has been fighting uphill against the same constraint. The intake form eliminates the constraint. We'll be testing it with researchers and PSIRT teams soon.
        </P>

        <P>
          If you've followed this series from the beginning, you've watched us build an AI writing detector, discover it doesn't work on real AI, pivot to substance analysis, discover the scoring formula can't use it, and arrive at the conclusion that prevention beats detection. Each failure was necessary. The tool we're building now is fundamentally different from what we set out to build &mdash; and we think it's the right one.
        </P>

        <P>
          Next post: we restructure the scoring formula, connect the LLM to heuristic context, and test the intake form with real researchers. Follow along.
        </P>
      </div>

      <Separator className="bg-border/50" />

      <div className="text-center text-xs text-muted-foreground/70 italic">
        <p>
          VulnRap is free and open. Try it at vulnrap.com. Source on{" "}
          <a href="https://github.com/REMEDiSSecurity/VulnRap.Com" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">GitHub</a>.
          The harder your test case, the better the tool gets.
        </p>
      </div>
    </article>
  );
}
