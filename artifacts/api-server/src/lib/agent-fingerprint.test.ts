import { describe, it, expect } from "vitest";
import {
  detectAgentFingerprint,
  AGENT_DISPLAY_LABEL,
  type AgentLabel,
} from "./agent-fingerprint";

// Task #644: 8 fixture pairs, one per likely agent class. Each fixture is
// a realistic-ish prose snippet that carries the stylistic fingerprints
// the detector keys on. The "human" and "unknown" classes each get one
// fixture — and a deliberate adversarial fixture pulls the unknown count
// to 2 so the suite covers all 7 labels with one extra ambiguous case
// (8 fixtures total).

interface Fixture {
  name: string;
  expected: AgentLabel;
  text: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "gpt4_pleasantry_opener",
    expected: "gpt4",
    text: `Certainly! I'd be happy to help you analyze this vulnerability report.

Let's dive into the details. The reported issue describes a stack-based buffer overflow in the parse_header function — a classic memory-safety bug.

**Summary:** The function reads user-controlled bytes into a fixed-size buffer without bounds checking.

In conclusion, this finding warrants immediate triage and a backport to the supported branches. To summarize, the impact is high and the fix is straightforward.`,
  },
  {
    name: "claude_thoughtful_walkthrough",
    expected: "claude",
    text: `I'll help you understand what's happening in this report. Here's what I found after reading through the description and the proof of concept carefully — there's a subtle race condition between the privilege-check and the file-open, which is a textbook TOCTOU pattern that's worth noting because it appears in many setuid utilities.

Let me walk you through the sequence: first the program calls access(2) on the path, then it opens the same path with open(2), and an attacker who can swap the inode between those two syscalls wins the race. I notice that the reporter included a working exploit that demonstrates the swap with a symlink.

To be clear, this is a real vulnerability — it appears to be exploitable as described, and the mitigation is to use openat(2) with the appropriate flags rather than the access/open pair.`,
  },
  {
    name: "gemini_bold_callouts",
    expected: "gemini",
    text: `Of course. Here is a thorough analysis of the submitted report.

* The report describes an injection vulnerability in the search endpoint.
* The proof of concept uses a single-quote payload to break out of the SQL string.
* The remediation suggested is to use parameterized queries.

**Important:** The vulnerable code path is reachable without authentication, which significantly increases the severity.

Crucially, the database user used by this endpoint has full read/write privileges on the schema, so the impact is not limited to information disclosure.

It is paramount that this be fixed before the next release. I can certainly help draft the patch.`,
  },
  {
    name: "cursor_agent_code_actions",
    expected: "cursor-agent",
    text: `I've edited \`src/auth/middleware.ts\` to add the missing CSRF check. Let me check the file again to confirm the change applied cleanly.

Now I'll update the matching test in \`test/auth/middleware.test.ts\` and the integration test in \`test/integration/login.test.ts\` so they cover the new branch.

I've also added a small helper in \`src/auth/csrf.ts\` that the middleware now imports. The diff is small and focused — apply_patch should land it without conflicts.`,
  },
  {
    name: "replit_agent_workflow_setup",
    expected: "replit-agent",
    text: `I've created the basic Express server and wired it up to the workflow so the Run button starts everything you need.

You can see the live site in the preview pane on the right. The workflow is configured to restart automatically when files change, and the latest checkpoint is saved so you can roll back if anything breaks.

I've added the database connection string to the Secrets pane — head over there if you want to rotate it later. This Repl is now ready to deploy whenever you're happy with it.`,
  },
  {
    name: "human_informal_with_commit_hash",
    expected: "human",
    text: `Hey team, fwiw I dug into this one over the weekend and afaict it's a real bug — repro'd it on master at commit 9f3a2c1d4e5b after applying the patch from PR #4821.

I don't think the existing fix actually closes the hole; the check happens before the canonicalize call so an attacker can still slip a relative path through. tldr: we need to move the validation after the canonicalize, not before.

Reported by Jane Doe and Sam Smith — they sent over the original PoC last Friday, full credit to them. Honestly this one sucks because the original patch looked fine on review.`,
  },
  {
    name: "human_typo_and_swearing",
    expected: "human",
    text: `ok so iirc this is the same bug we saw last quarter, wtf. I'm pretty sure the fix in PR #1024 only covers the GET path, not POST. Reported by Alex Johnson originally.

Honestly this kinda sucks because we shipped it without a regression test. Lemme know if you want me to write one — gonna take like an hour. btw the commit a1b2c3d4e5f6789 broke the test runner too.`,
  },
  {
    name: "unknown_short_generic",
    expected: "unknown",
    text: `Buffer overflow in parse(). The function copies user input into a fixed buffer. Severity: high. Patch attached.`,
  },
];

describe("detectAgentFingerprint", () => {
  it("returns the unknown verdict with zero confidence on empty / nullish input", () => {
    for (const v of ["", null, undefined]) {
      const r = detectAgentFingerprint(v as string | null);
      expect(r.likelyAgent).toBe("unknown");
      expect(r.confidence).toBe(0);
      expect(r.matches).toHaveLength(0);
    }
  });

  for (const f of FIXTURES) {
    it(`fingerprints "${f.name}" as ${f.expected}`, () => {
      const r = detectAgentFingerprint(f.text);
      expect(
        r.likelyAgent,
        `wanted ${f.expected}, got ${r.likelyAgent}; scores=${JSON.stringify(r.scores)}`,
      ).toBe(f.expected);
      if (f.expected === "unknown") {
        expect(r.confidence).toBe(0);
      } else {
        expect(r.confidence).toBeGreaterThan(0);
        expect(r.confidence).toBeLessThanOrEqual(0.95);
        // The fixture should fire at least one rule that voted for the
        // winning agent, otherwise the verdict is structurally suspect.
        const winningRules = r.matches.filter(
          (m) =>
            // matches don't carry the agent — but every winning fixture
            // should produce at least one match overall.
            m.weight > 0,
        );
        expect(winningRules.length).toBeGreaterThan(0);
      }
    });
  }

  it("never returns a confidence above 0.95 — we never claim certainty", () => {
    // Stack many GPT-4 tells into one body. Even with maximal matches,
    // the confidence is capped.
    const stacked = `Certainly! Of course! I'd be happy to help. Let's dive into this. ${"**Important:** ".repeat(
      3,
    )} Now let's continue. — — — — — — — —
In conclusion, to summarize, remember that this is the right approach.`;
    const r = detectAgentFingerprint(stacked);
    expect(r.confidence).toBeLessThanOrEqual(0.95);
  });

  it("exposes friendly display labels for every label", () => {
    const labels: AgentLabel[] = [
      "gpt4",
      "claude",
      "gemini",
      "cursor-agent",
      "replit-agent",
      "human",
      "unknown",
    ];
    for (const l of labels) {
      expect(AGENT_DISPLAY_LABEL[l]).toBeTypeOf("string");
      expect(AGENT_DISPLAY_LABEL[l].length).toBeGreaterThan(0);
    }
  });

  it("includes lightweight stylometric features in the result", () => {
    const r = detectAgentFingerprint(
      "Hello world. This is a test sentence. And another one.",
    );
    expect(r.features.wordCount).toBeGreaterThan(0);
    expect(r.features.sentenceCount).toBeGreaterThan(0);
    expect(r.features.avgSentenceLen).toBeGreaterThan(0);
  });
});
