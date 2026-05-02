import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Render the impossible_http_response marker IDs (emitted by the
// detector in `hallucination-detector.ts`) as one badge per tell, with
// a hover/tap tooltip explaining the RFC violation in plain language.
// Static marker IDs are listed in STATIC_MARKER_INFO; dynamic IDs that
// embed a status code / header / method are matched by regex.

interface MarkerInfo {
  /** One-line, plain-language headline shown on the badge. */
  label: string;
  /** Short paragraph (1–2 sentences) explaining the RFC violation. */
  explanation: string;
}

const STATIC_MARKER_INFO: Record<string, MarkerInfo> = {
  content_length_zero_but_body_present: {
    label: "Content-Length: 0 but body present",
    explanation:
      "RFC 7230 §3.3.2 ties Content-Length to the byte count of the body that follows. A real server emitting `Content-Length: 0` cannot also send body bytes; this is the classic shape of a paste author who copied a header block and a body block from different sources.",
  },
  content_length_declared_but_body_empty: {
    label: "Content-Length declared but body empty",
    explanation:
      "The header advertises ≥100 bytes of payload but the excerpt has none. A real HTTP/1.1 stack would either send the bytes or close the connection mid-message — it would never produce a fully-formed message that contradicts its own framing header.",
  },
  content_length_disagrees_with_body: {
    label: "Content-Length disagrees with body bytes",
    explanation:
      "The advertised Content-Length is off from the actual body by more than 50% (and at least 50 bytes). Real responses always agree because the framing is what HTTP parsers use to find the next message; a recipient seeing this would treat the connection as broken.",
  },
};

interface DynamicMarkerPattern {
  /** Regex over the marker ID; named captures fill in the label/tooltip. */
  match: RegExp;
  /** Build the label/explanation from the regex match groups. */
  build: (groups: Record<string, string>) => MarkerInfo;
}

const DYNAMIC_MARKER_PATTERNS: DynamicMarkerPattern[] = [
  {
    match: /^status_(?<code>\d{3})_must_have_no_body$/,
    build: ({ code }) => ({
      label: `${code} response carries a body`,
      explanation:
        `RFC 7230 §3.3.3 forbids 1xx, 204, and 304 responses from carrying a payload body. ` +
        `An HTTP/1.1 server cannot emit a ${code} status line and then send body bytes; ` +
        `recipients are required to ignore framing headers on these codes, so any body that follows is impossible by spec.`,
    }),
  },
  {
    match: /^status_(?<code>\d{3})_with_wrong_reason_phrase$/,
    build: ({ code }) => ({
      label: `${code} status line has the wrong reason phrase`,
      explanation:
        `The reason phrase paired with status ${code} doesn't match the canonical wording for that code (RFC 7231 / IANA HTTP Status Code Registry). Real servers either emit the canonical phrase or omit it; an LLM mixing "200 Not Found" or "404 OK" is reading the two halves of the status line from different templates.`,
    }),
  },
  {
    match: /^response_carries_request_only_(?<header>[a-z][a-z0-9-]*)$/,
    build: ({ header }) => ({
      label: `Response carries request-only header: ${humanHeader(header)}`,
      explanation:
        `${humanHeader(header)} is defined as a request header (RFC 7231 / RFC 6265 §3 for Cookie). A real HTTP stack never emits it on a response; an LLM that has seen request and response excerpts in the same window has confused which side the header belongs to.`,
    }),
  },
  {
    match: /^request_carries_response_only_(?<header>[a-z][a-z0-9-]*)$/,
    build: ({ header }) => ({
      label: `Request carries response-only header: ${humanHeader(header)}`,
      explanation:
        `${humanHeader(header)} is defined as a response header (RFC 6265 §3 for Set-Cookie, RFC 7235 for WWW-Authenticate / Proxy-Authenticate, RFC 7231 §7.1.2 for Location). A real client never sends it on a request; this is a classic AI-mirroring tell.`,
    }),
  },
  {
    match: /^response_to_(?<method>[A-Z]+)_must_have_no_body$/,
    build: ({ method }) => ({
      label: `${method} response carries a body`,
      explanation:
        `RFC 7230 §3.3.3 forbids responses to ${method} from carrying a payload body. ` +
        `Real servers either omit the body entirely (HEAD) or only emit framing for the tunnel (CONNECT); an excerpt that pairs ${method} with body bytes is internally inconsistent.`,
    }),
  },
];

// Lower-cased marker fragment ("set_cookie") → "Set-Cookie".
function humanHeader(fragment: string): string {
  return fragment
    .split(/[-_]/)
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join("-");
}

function lookupMarkerInfo(markerId: string): MarkerInfo {
  const stat = STATIC_MARKER_INFO[markerId];
  if (stat) return stat;
  for (const pat of DYNAMIC_MARKER_PATTERNS) {
    const m = pat.match.exec(markerId);
    if (m && m.groups) return pat.build(m.groups);
  }
  return {
    label: markerId.replace(/_/g, " "),
    explanation:
      "This marker was emitted by the impossible-HTTP-response detector but isn't in the badge label table yet. The marker ID itself is the canonical name from the detector source (`hallucination-detector.ts`, `detectImpossibleHttpResponse`).",
  };
}

export interface ImpossibleHttpMarkersProps {
  /** Deduplicated marker IDs from the `markers` field on the evidence row. */
  markers: string[];
  /** Test-id prefix so e2e specs can target the badges deterministically. */
  testIdPrefix?: string;
}

export function ImpossibleHttpMarkers({
  markers,
  testIdPrefix = "impossible-http-marker",
}: ImpossibleHttpMarkersProps) {
  if (markers.length === 0) return null;
  return (
    <TooltipProvider delayDuration={150}>
      <div
        className="flex flex-wrap gap-1.5 mt-1.5"
        data-testid={`${testIdPrefix}-list`}
        aria-label={`${markers.length} impossibility marker${markers.length === 1 ? "" : "s"}`}
      >
        {markers.map((id) => {
          const info = lookupMarkerInfo(id);
          return (
            <Tooltip key={id}>
              <TooltipTrigger
                type="button"
                className="cursor-help inline-flex"
                data-testid={`${testIdPrefix}-${id}`}
                aria-label={`${info.label}: ${info.explanation}`}
              >
                <Badge
                  variant="outline"
                  className="text-[10px] border-red-500/40 text-red-300 font-mono normal-case"
                >
                  <span className="font-semibold">{info.label}</span>
                  <span className="ml-1 text-red-400/70 text-[9px]">({id})</span>
                </Badge>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                align="start"
                collisionPadding={12}
                className="max-w-sm glass-card glow-border text-popover-foreground text-left font-normal normal-case px-3 py-2 whitespace-normal text-[11px] leading-snug"
                data-testid={`${testIdPrefix}-${id}-tooltip`}
              >
                <div className="font-semibold mb-1">{info.label}</div>
                <div className="text-foreground/80">{info.explanation}</div>
                <div className="text-muted-foreground mt-1 text-[10px] font-mono">{id}</div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

export const __testables = {
  lookupMarkerInfo,
  STATIC_MARKER_INFO,
  DYNAMIC_MARKER_PATTERNS,
};
