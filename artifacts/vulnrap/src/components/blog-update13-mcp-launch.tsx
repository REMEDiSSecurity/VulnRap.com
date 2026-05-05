import { Calendar } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
// Task #1032 — looping demo asset embedded above "What shipped". The
// asset is a self-contained animated SVG (no GIF encoder dependency,
// no external playback) showing the agent calling each of the three
// MCP tools — scoreReport, findSimilar, redact — and the result the
// agent surfaces back to the user. ~24s loop, scales cleanly on
// retina, plays without user interaction in every modern browser.
import mcpDemoSrc from "@/assets/blog-mcp-demo.svg";

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-foreground font-bold text-lg mt-8 mb-3">{children}</h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4">{children}</p>;
}

function Bold({ children }: { children: React.ReactNode }) {
  return <strong className="text-foreground">{children}</strong>;
}

const claudeDesktopConfig = `{
  "mcpServers": {
    "vulnrap": {
      "command": "npx",
      "args": ["-y", "@vulnrap/mcp-server@latest"],
      "env": {
        "VULNRAP_API_BASE": "https://vulnrap.com"
      }
    }
  }
}`;

export function BlogUpdate13McpLaunch() {
  return (
    <article id="update13-mcp-launch" className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <Badge
            variant="outline"
            className="border-emerald-500/30 text-emerald-300 text-[10px]"
          >
            Update #13
          </Badge>
          <span className="flex items-center gap-1">
            <Calendar className="w-3 h-3" /> May 2026
          </span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          VulnRap Now Speaks MCP: Triage From Inside Your Agent
        </h2>
        <p className="text-xs text-muted-foreground/80">
          Update #13 in the VulnRap Sprint Series &mdash; Previous:{" "}
          <Link to="/blog/sprint14-rigor" className="text-primary hover:underline">
            Three Ways Slop Hid This Sprint
          </Link>
        </p>
      </div>

      <Separator className="bg-border/50" />

      <div className="prose-invert space-y-2 text-sm leading-relaxed text-muted-foreground">
        <figure className="mt-2 mb-4">
          <img
            src={mcpDemoSrc}
            alt="Animated demo: an MCP-aware agent calls scoreReport, findSimilar, and redact on a vulnerability report and surfaces each tool's response inline."
            loading="lazy"
            decoding="async"
            className="w-full rounded-md border border-border/50 bg-black/40"
          />
          <figcaption className="text-xs text-muted-foreground/80 mt-2 text-center">
            The agent calls <code>scoreReport</code>, <code>findSimilar</code>,
            and <code>redact</code> end-to-end — no copy-paste, no shell-out.
          </figcaption>
        </figure>

        <SectionHeading>What shipped</SectionHeading>

        <P>
          VulnRap now ships an <Bold>MCP server</Bold>. If you triage reports
          from inside Claude Desktop, Cursor, or any other Model Context
          Protocol client, you can hand the agent a report and have it call
          VulnRap directly &mdash; no copy-paste into the web UI, no shell-out
          to <code>curl</code>, no API client to wire up.
        </P>

        <P>
          The server exposes the three tools that matter for triage:{" "}
          <code>scoreReport</code> (full multi-axis validity scoring with
          per-engine breakdown), <code>findSimilar</code> (MinHash + SimHash +
          section-level hash lookup against the public corpus), and{" "}
          <code>redact</code> (run only the auto-redaction pass and return the
          cleaned text). Every call goes through the same redaction pipeline as
          the web submit path. Raw text never lands in the database.
        </P>

        <SectionHeading>Claude Desktop config</SectionHeading>

        <P>
          Drop this into{" "}
          <code>
            ~/Library/Application Support/Claude/claude_desktop_config.json
          </code>{" "}
          (macOS) or <code>%APPDATA%\Claude\claude_desktop_config.json</code>{" "}
          (Windows) and restart Claude:
        </P>

        <pre className="bg-black/40 border border-border/50 rounded-md p-4 text-xs text-foreground/90 overflow-x-auto">
          <code>{claudeDesktopConfig}</code>
        </pre>

        <P>
          Cursor, Zed, Continue, and Windsurf use the same MCP wire protocol.
          See the{" "}
          <Link to="/connect" className="text-primary hover:underline">
            Connect Your Agent
          </Link>{" "}
          page for copy-paste config snippets for every supported client. No
          accounts, no API keys.
        </P>

        <SectionHeading>Example agent prompts</SectionHeading>

        <P>
          Once the server is connected, the agent can drive triage in plain
          English:
        </P>

        <ul className="space-y-2 list-disc pl-5 mb-4">
          <li>
            <Bold>
              "Score this report and tell me which engine is the weakest
              signal."
            </Bold>{" "}
            Paste the report. The agent calls <code>scoreReport</code>, reads
            back the composite and the four-axis breakdown, and points at the
            axis pulling the score down.
          </li>
          <li>
            <Bold>"Is this a duplicate of anything in the corpus?"</Bold> The
            agent calls <code>findSimilar</code>, ranks matches by Jaccard and
            section-hash overlap, and surfaces the top three with similarity
            percentages.
          </li>
          <li>
            <Bold>"Redact this before I paste it into the ticket."</Bold> The
            agent calls <code>redact</code> and hands back text with emails,
            IPs, keys, and company names stripped &mdash; ready to drop into
            Jira or your VDP backend.
          </li>
          <li>
            <Bold>"Triage these 12 reports and rank them by validity."</Bold>{" "}
            Multi-call workflow. The agent loops <code>scoreReport</code> across
            the batch and sorts the table for you.
          </li>
        </ul>

        <SectionHeading>Source and feedback</SectionHeading>

        <P>
          The MCP server is in the same repo as the rest of VulnRap &mdash;{" "}
          <a
            href="https://github.com/REMEDiSSecurity/VulnRap.Com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            github.com/REMEDiSSecurity/VulnRap.Com
          </a>{" "}
          under <code>artifacts/mcp-server/</code>. If you wire it into a triage
          workflow we haven't thought of, we'd like to hear about it.
        </P>
      </div>
    </article>
  );
}
