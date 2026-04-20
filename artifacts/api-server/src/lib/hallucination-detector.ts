export interface HallucinationSignal {
  type: string;
  description: string;
  weight: number;
}

export interface HallucinationResult {
  score: number;
  signals: HallucinationSignal[];
  totalWeight: number;
}

export function detectHallucinationSignals(text: string): HallucinationResult {
  const signals: HallucinationSignal[] = [];

  const stackFrames = text.match(/#\d+\s+0x[0-9a-f]+\s+in\s+\S+/gi) || [];
  if (stackFrames.length >= 3) {
    const uniqueFrames = new Set(stackFrames.map(f => f.replace(/#\d+/, "#N")));
    const repetitionRatio = 1 - (uniqueFrames.size / stackFrames.length);
    if (repetitionRatio > 0.5) {
      signals.push({
        type: "fabricated_stack_trace",
        description: `Stack trace has ${Math.round(repetitionRatio * 100)}% repeated frames — real crashes have varied call chains`,
        weight: 15,
      });
    }
  }

  // v3.6.0 §6: Allowlist of known ASAN/allocator sentinel addresses that look
  // round but are commonly seen in real crash output. Plus require >=5
  // trailing zeros (was 4) to reduce false positives like 0x60200000.
  const KNOWN_ALLOCATOR_ADDRESSES = new Set([
    "0x60200000",
    "0x7fff0000",
    "0x602000000000",
    "0x10000000",
    "0x00400000",
    "0x7f0000000000",
  ]);
  const addresses = text.match(/0x[0-9a-f]{8,16}/gi) || [];
  const roundAddresses = addresses.filter(a => {
    const lower = a.toLowerCase();
    if (KNOWN_ALLOCATOR_ADDRESSES.has(lower)) return false;
    const hex = lower.replace("0x", "");
    const trailing = hex.match(/0+$/)?.[0].length || 0;
    const sequential = /(?:1234|5678|9abc|abcd|dead|beef|cafe|face)/.test(hex);
    return trailing >= 5 || sequential;
  });
  // v3.6.0 §6: Real ASan/gdb crash dumps frequently include some round-looking
  // addresses (allocator boundaries, page-aligned regions). Only flag the
  // round-address pattern when there are no other corroborating real-crash
  // indicators in the surrounding text — otherwise we falsely accuse legit
  // sanitizer reports that happen to land on aligned addresses.
  const hasRealCrashIndicators =
    /SUMMARY:\s*AddressSanitizer/i.test(text) ||
    /==\d+==ERROR:\s*AddressSanitizer/i.test(text) ||
    /Thread\s+\d+\s+received\s+signal\s+SIG/i.test(text) ||
    /Program\s+received\s+signal\s+SIG/i.test(text) ||
    /\(gdb\)\s+(?:bt|backtrace|info\s+registers)/i.test(text) ||
    /==\d+==\s*(?:READ|WRITE)\s+of\s+size\s+\d+/i.test(text);
  if (
    addresses.length >= 2 &&
    roundAddresses.length / addresses.length > 0.5 &&
    !hasRealCrashIndicators
  ) {
    signals.push({
      type: "fabricated_addresses",
      description: `${roundAddresses.length}/${addresses.length} memory addresses appear artificially constructed (round/sequential values)`,
      weight: 10,
    });
  }

  const exploitScripts = text.match(/(?:exploit|payload|poc|attack)\.py/gi) || [];
  if (exploitScripts.length > 0 && !text.includes("import ") && !text.includes("def ")) {
    signals.push({
      type: "phantom_exploit_script",
      description: `References "${exploitScripts[0]}" but provides no actual source code`,
      weight: 8,
    });
  }

  const hasAsan = /AddressSanitizer/i.test(text);
  const hasAsanDetails = /SUMMARY:\s*AddressSanitizer/i.test(text);
  if (hasAsan && !hasAsanDetails) {
    signals.push({
      type: "incomplete_asan",
      description: "ASan output appears truncated/fabricated — missing SUMMARY section that real ASan always produces",
      weight: 12,
    });
  }

  const pids = text.match(/==(\d+)==/g) || [];
  if (pids.length > 0 && pids[0]) {
    const pid = pids[0].replace(/==/g, "");
    if (/^(12345|11111|99999|10000|54321)$/.test(pid)) {
      signals.push({
        type: "fabricated_pid",
        description: `Process ID "${pid}" appears fabricated — real PIDs are arbitrary numbers`,
        weight: 6,
      });
    }
  }

  const functionRefs = text.match(/\b(\w+(?:_\w+)+)\s*\(/g) || [];
  const codeBlocks = text.match(/```[\s\S]*?```/g) || [];
  const codeContent = codeBlocks.join(" ");

  if (functionRefs.length >= 3) {
    const phantomFunctions = functionRefs.filter(f => {
      const name = f.replace(/\s*\($/, "");
      return !codeContent.includes(name);
    });
    if (phantomFunctions.length >= 3 && codeBlocks.length === 0) {
      signals.push({
        type: "phantom_functions",
        description: `References ${phantomFunctions.length} specific functions but provides no code showing them — claims may be fabricated`,
        weight: 10,
      });
    }
  }

  const versions = text.match(/(?:version\s+|v)((\d+)\.(\d+)\.(\d+))/gi) || [];
  for (const ver of versions) {
    const parts = ver.match(/(\d+)\.(\d+)\.(\d+)/);
    if (parts) {
      const [, majorStr, , patchStr] = parts;
      const major = Number(majorStr);
      const patch = Number(patchStr);
      if (patch > 200 && major < 10) {
        signals.push({
          type: "implausible_version",
          description: `Version "${parts[0]}" has an unusually high patch number — may be fabricated`,
          weight: 5,
        });
      }
    }
  }

  const hasXSS = /(?:cross.?site\s+scripting|XSS)/i.test(text);
  const claimsRCE = /(?:remote\s+code\s+execution|RCE|arbitrary\s+code\s+execution)/i.test(text);
  if (hasXSS && claimsRCE && !/(?:electron|node|server.?side|SSR)/i.test(text)) {
    signals.push({
      type: "impact_escalation",
      description: "Claims RCE from XSS without mentioning a server-side or Electron context — typical AI overstatement",
      weight: 8,
    });
  }

  const mentionsPython = /(?:python|\.py|pip|django|flask)/i.test(text);
  const mentionsJS = /(?:node\.?js|npm|express|\.js\b|require\s*\()/i.test(text);
  const mentionsC = /(?:\.c\b|\.h\b|gcc|malloc|free\s*\(|#include)/i.test(text);
  const languageCount = [mentionsPython, mentionsJS, mentionsC].filter(Boolean).length;
  if (languageCount >= 3) {
    signals.push({
      type: "language_confusion",
      description: "Report references Python, JavaScript, AND C/C++ — a single vulnerability rarely spans 3 language ecosystems",
      weight: 8,
    });
  }

  const sentencesArr = text.split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 20);
  const seen = new Map<string, number>();
  let duplicates = 0;
  for (const s of sentencesArr) {
    const normalized = s.replace(/\s+/g, " ");
    if (seen.has(normalized)) {
      duplicates++;
    }
    seen.set(normalized, (seen.get(normalized) || 0) + 1);
  }
  if (duplicates >= 2) {
    signals.push({
      type: "repeated_sentences",
      description: `${duplicates} duplicate sentences detected — may indicate copy-paste generation artifacts`,
      weight: 6,
    });
  }

  const hasResponsibleDisclosure = /responsible\s+disclosure/i.test(text);
  const hasTimeline = /(?:reported|disclosed|notified|contacted)\s+(?:on|at)?\s*\d{4}[-/]\d{2}[-/]\d{2}/i.test(text);
  const hasVendorContact = /(?:vendor|maintainer|developer)\s+(?:response|confirmed|acknowledged)/i.test(text);
  if (hasResponsibleDisclosure && !hasTimeline && !hasVendorContact) {
    signals.push({
      type: "empty_disclosure_claim",
      description: 'Claims "responsible disclosure" but provides no disclosure timeline or vendor communication — boilerplate padding',
      weight: 5,
    });
  }

  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const score = Math.max(0, 100 - totalWeight * 2);

  return { score, signals, totalWeight };
}
