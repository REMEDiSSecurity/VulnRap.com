import { Calendar, Terminal } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

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

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="text-[11px] font-mono bg-background/50 border border-border/50 rounded-md p-3 overflow-x-auto leading-relaxed mb-4 text-muted-foreground">
      {children}
    </pre>
  );
}

export function BlogUpdate14DeployFix() {
  return (
    <article id="update14-deploy-fix" className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          <Badge
            variant="outline"
            className="border-yellow-500/30 text-yellow-300 text-[10px]"
          >
            Update #14
          </Badge>
          <span className="flex items-center gap-1">
            <Calendar className="w-3 h-3" /> May 2026
          </span>
          <span>by the REMEDiS Security team</span>
        </div>
        <h2 className="text-2xl font-bold tracking-tight">
          60 Seconds of Silence: What the Production Startup Hang Taught Us
        </h2>
        <p className="text-xs text-muted-foreground/80">
          Update #14 in the VulnRap Sprint Series &mdash; Previous:{" "}
          <Link
            to="/blog/update13-mcp-launch"
            className="text-primary hover:underline"
          >
            VulnRap Now Speaks MCP
          </Link>
        </p>
      </div>

      <Separator className="bg-border/50" />

      <div className="prose-invert space-y-2 text-sm leading-relaxed text-muted-foreground">
        <SectionHeading>The symptom</SectionHeading>

        <P>
          Every production deploy was failing, but not in any useful way. The
          server started, ran for exactly 60 seconds, and was killed by the
          deployment watchdog with no error message and no stack trace. The
          deployment logs showed three lines and then silence:
        </P>

        <CodeBlock>{`[Info]  artifact process started pid=18
[warn]  [newsletter] NEWSLETTER_CHALLENGE_HMAC_KEY not set — using ephemeral key
[Error] (node:18) Warning: SECURITY WARNING … sslmode=verify-full`}</CodeBlock>

        <P>
          The newsletter warning is from route module loading. The SSL warning
          fires when <code>pg</code> parses the <code>DATABASE_URL</code>
          —&nbsp;meaning the process had reached the migration pool constructor.
          Then nothing. Port 8080 never opened. The watchdog sent SIGTERM at 60
          seconds and the cycle repeated on the next deploy.
        </P>

        <SectionHeading>The investigation</SectionHeading>

        <P>
          The silence was the first clue. The migration runner logs its steps
          with <code>pino</code>, and pino output <em>was</em> being captured
          (we could see the newsletter warn). The fact that not a single
          migration log line appeared meant the hang was happening before the
          first <code>log()</code> call inside <code>runMigrations()</code>
          —&nbsp;which meant it was inside <code>baselineExistingSchemaIfNeeded()</code>,
          at the very first <code>pool.query()</code>:
        </P>

        <CodeBlock>{`const probe = await pool.query(
  'SELECT to_regclass($1) AS oid',
  ['public.reports'],
);`}</CodeBlock>

        <P>
          A <code>SELECT to_regclass</code> should be nearly instant. To confirm
          the theory, we queried the production database directly. The result was
          unambiguous:{" "}
          <Bold>
            the <code>drizzle.__drizzle_migrations</code> journal table existed
            but had zero rows.
          </Bold>{" "}
          The table had been created by a previous startup attempt, but the
          baseline INSERT that should have followed it had never committed. Every
          deploy had run the same sequence, hit the same hang, and been killed
          before any write could complete.
        </P>

        <SectionHeading>Root cause: autoscale + no connection timeout</SectionHeading>

        <P>
          The production environment is autoscale: when a new version is
          deployed, the platform starts the new instance while the old one is
          still alive and serving traffic. The old instance holds its database
          connection pool. The new instance's migration pool calls{" "}
          <code>pool.query()</code>, which internally tries to open a new
          connection to Postgres. If the database is already at its connection
          limit (held by the old instance), the <code>pg</code> pool doesn't
          fail—it queues the request and waits.
        </P>

        <P>
          The default value of{" "}
          <code>connectionTimeoutMillis</code> in <code>pg.Pool</code> is{" "}
          <Bold>0</Bold>: no timeout, wait forever. So the new instance queued
          its first migration query, the old instance kept its connections alive
          until it received SIGTERM, and the new instance's queue never cleared
          before the watchdog arrived.
        </P>

        <P>
          The deeper issue is architectural: running Drizzle migrations at
          startup is an anti-pattern in an autoscale environment. In the Replit
          deployment model, schema changes are applied during the Publish flow
          (Replit diffs dev vs. prod and applies the delta). The
          startup migration runner was redundant in production and—as we just
          demonstrated—actively harmful.
        </P>

        <SectionHeading>The fix</SectionHeading>

        <P>Two changes, both small:</P>

        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4 space-y-3 mb-4">
          <div className="flex items-center gap-2 text-xs font-bold text-yellow-300">
            <Terminal className="w-3.5 h-3.5" />
            What changed
          </div>
          <ul className="space-y-2 text-xs text-muted-foreground leading-relaxed">
            <li className="flex gap-2">
              <span className="text-yellow-400 mt-0.5 shrink-0">1.</span>
              <span>
                <Bold>
                  Set <code>RUN_STARTUP_MIGRATIONS=0</code> in the production
                  environment.
                </Bold>{" "}
                The codebase already had this flag; it skips the versioned
                Drizzle migrator entirely and falls through to the runtime DDL
                (the <code>page_views</code> table, which is idempotent). The
                Publish flow handles everything else.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-yellow-400 mt-0.5 shrink-0">2.</span>
              <span>
                <Bold>
                  Added <code>connectionTimeoutMillis: 15_000</code> to the
                  migration pool.
                </Bold>{" "}
                If the migrator ever runs again (e.g. in a self-hosted
                environment where the old instance holds connections), it now
                fails with a real error after 15 seconds instead of hanging
                silently until the watchdog fires.
              </span>
            </li>
          </ul>
        </div>

        <P>
          The next deploy went through clean. Port 8080 opened in under 3
          seconds and the startup logs showed the runtime DDL check completing
          normally.
        </P>

        <SectionHeading>Also shipped: agent defaults code block</SectionHeading>

        <P>
          A smaller but visible change: the{" "}
          <Bold>For AI agents specifically</Bold> card on the home page now has
          a code block alongside its bullet points, matching the curl example
          already present on the <em>Three calls</em> side. It shows the
          recommended defaults at a glance:
        </P>

        <CodeBlock>{`# Recommended defaults — use these unless user opts out
showInFeed=true   # community learns from every report
contentMode=full  # richest verdict back

# After the human acts:
POST /api/feedback { reportId, rating, helpful, comment }`}</CodeBlock>

        <P>
          The full agent integration guide (proof-of-work feedback solver in
          Node.js and Python, recommended defaults table, privacy modes) is at{" "}
          <a
            href="/agents.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            /agents.md
          </a>
          .
        </P>

        <Separator className="bg-border/50 my-6" />

        <p className="text-xs text-muted-foreground/60">
          Next post:{" "}
          <Link
            to="/blog"
            className="text-primary/70 hover:text-primary hover:underline"
          >
            Back to all posts
          </Link>
        </p>
      </div>
    </article>
  );
}
