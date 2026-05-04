import { existsSync, readFileSync } from "fs";
import path from "path";
import { Router, type IRouter, type Request } from "express";
import { ListIncidentsResponse } from "@workspace/api-zod";
import { buildPublicUrl } from "../lib/public-url";

const router: IRouter = Router();

const INCIDENTS_CANDIDATES = [
  process.env.INCIDENTS_PATH,
  path.resolve(process.cwd(), "data/incidents.json"),
  path.resolve(process.cwd(), "artifacts/api-server/data/incidents.json"),
].filter((p): p is string => !!p);

function resolveIncidentsPath(): string {
  for (const candidate of INCIDENTS_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `[incidents-feed] Could not find incidents.json. Tried: ${INCIDENTS_CANDIDATES.join(", ")}`,
  );
}

function loadIncidents() {
  const raw = JSON.parse(
    readFileSync(resolveIncidentsPath(), "utf8"),
  ) as Record<string, unknown>;
  return ListIncidentsResponse.parse({
    version: raw.version,
    incidents: raw.incidents,
  });
}

const INCIDENT_LOG = loadIncidents();

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wrapCdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function toRfc3339(date: Date): string {
  if (Number.isNaN(date.getTime())) return new Date(0).toISOString();
  return date.toISOString();
}

function severityLabel(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface IncidentLike {
  id: string;
  date: Date;
  duration: string;
  severity: string;
  summary: string;
  rootCause: string;
  remediation: string;
  changelogAnchor?: string;
}

function formatDateHtml(date: Date): string {
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toISOString().slice(0, 10);
}

function buildIncidentHtml(
  incident: IncidentLike,
  baseUrl: string,
): string {
  const parts: string[] = [];
  parts.push(
    `<p><strong>Date:</strong> ${escapeHtml(formatDateHtml(incident.date))}</p>`,
  );
  parts.push(
    `<p><strong>Severity:</strong> ${escapeHtml(severityLabel(incident.severity))}</p>`,
  );
  parts.push(
    `<p><strong>Duration:</strong> ${escapeHtml(incident.duration)}</p>`,
  );
  parts.push(
    `<p><strong>Summary:</strong> ${escapeHtml(incident.summary)}</p>`,
  );
  parts.push(`<h3>Root Cause</h3>`);
  parts.push(`<p>${escapeHtml(incident.rootCause)}</p>`);
  parts.push(`<h3>Remediation</h3>`);
  parts.push(`<p>${escapeHtml(incident.remediation)}</p>`);
  if (incident.changelogAnchor) {
    parts.push(
      `<p><a href="${escapeHtml(baseUrl)}/changelog#${escapeHtml(incident.changelogAnchor)}">Related changelog entry</a></p>`,
    );
  }
  return parts.join("");
}

export function buildIncidentsAtomFeed(
  incidents: IncidentLike[],
  baseUrl: string,
): string {
  const feedSelf = `${baseUrl}/incidents/feed.xml`;
  const incidentsUrl = `${baseUrl}/incidents`;
  const updated =
    incidents.length > 0
      ? toRfc3339(incidents[0].date)
      : new Date(0).toISOString();

  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>VulnRap Incident Postmortems</title>`,
    `  <subtitle>Operational incidents — engine outages, scoring regressions, calibration mistakes — with root cause and remediation.</subtitle>`,
    `  <id>${escapeXml(incidentsUrl)}</id>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(incidentsUrl)}"/>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(feedSelf)}"/>`,
    `  <updated>${updated}</updated>`,
    `  <author><name>VulnRap</name></author>`,
  ];

  for (const incident of incidents) {
    const id = `${incidentsUrl}#${incident.id}`;
    const title = `[${severityLabel(incident.severity)}] ${incident.summary}`;
    const html = buildIncidentHtml(incident, baseUrl);
    const summary = incident.summary.length > 280
      ? incident.summary.slice(0, 277) + "…"
      : incident.summary;

    lines.push("  <entry>");
    lines.push(`    <id>${escapeXml(id)}</id>`);
    lines.push(`    <title>${escapeXml(title)}</title>`);
    lines.push(
      `    <link rel="alternate" type="text/html" href="${escapeXml(id)}"/>`,
    );
    lines.push(`    <updated>${toRfc3339(incident.date)}</updated>`);
    lines.push(`    <published>${toRfc3339(incident.date)}</published>`);
    lines.push(`    <summary type="text">${escapeXml(summary)}</summary>`);
    lines.push(`    <content type="html">${wrapCdata(html)}</content>`);
    lines.push("  </entry>");
  }

  lines.push("</feed>");
  return lines.join("\n");
}

router.get("/incidents/feed.xml", (req: Request, res) => {
  try {
    const baseUrl = buildPublicUrl({ req }).replace(/\/$/, "");
    const sorted = [...INCIDENT_LOG.incidents].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
    const xml = buildIncidentsAtomFeed(sorted, baseUrl);
    res.set(
      "Cache-Control",
      "public, max-age=3600, stale-while-revalidate=600",
    );
    res.type("application/atom+xml; charset=utf-8").send(xml);
  } catch (err) {
    res
      .status(500)
      .type("application/atom+xml; charset=utf-8")
      .send(
        `<?xml version="1.0" encoding="utf-8"?>\n<error>${escapeXml(
          (err as Error).message,
        )}</error>`,
      );
  }
});

export default router;
