# VulnRap: Scoring Overhaul — Development Prompt

## Context

VulnRap (vulnrap.com) detects AI-generated "slop" vulnerability reports for PSIRT teams. Built on Replit, API at `/api/reports/check` (read-only) and `/api/reports` (analysis + storage).

**Current state:** Blind test of 14 slop + 15 legit reports → Cohen's d = 0.06, AUC ≈ 0.52, best accuracy 58.6%. The heuristics measure *report formatting quality* not *AI provenance*. A fabricated Java deser report scores 18 while a real kernel dev report scores 48. `llmSlopScore` is always null — the LLM feature is broken/disabled.

**Root cause:** Quality signals (missing versions, no code blocks) are treated as slop signals. These are orthogonal questions.

---

## Architecture: Three-Axis Scoring → Bayesian Fusion

```
INPUT → [Axis 1: Linguistic AI Fingerprinting] ─┐
       [Axis 2: Structural Quality (SEPARATE)] │ → Bayesian Fusion → slopScore + qualityScore + confidence
       [Axis 3: Factual Verification] ──────────┤
       [Axis 4: LLM Deep Analysis] ────────────┘
```

**Outputs:** `slopScore` (0-100, AI likelihood from axes 1/3/4), `qualityScore` (0-100, report completeness from axis 2), `confidence` (0-1), per-axis breakdown, specific evidence list.

---

## Axis 1: Linguistic AI Fingerprinting

### 1A: Lexical Markers

```python
AI_PHRASES = {
    # High confidence (8-10)
    "certainly!": 10, "certainly,": 10,
    "let me elaborate": 9, "allow me to explain": 9,
    "i hope this helps": 8, "i hope this finds you well": 8,
    "i hope this message finds you": 8, "i would be happy to provide": 8,
    "please don't hesitate to reach out": 8, "please do not hesitate": 8,
    "feel free to reach out": 7, "i look forward to hearing": 7,
    "thank you for your dedication to security": 9,
    "thank you for your time and attention": 7,
    "best regards,\nsecurity researcher": 10,
    "best regards,\nresearcher": 10,
    # Medium confidence (4-6)
    "i apologize for": 5, "i am sorry for any confusion": 6,
    "upon further analysis": 5, "during my comprehensive": 5,
    "during my thorough": 5, "during my extensive": 5,
    "as a senior penetration tester": 6, "with over": 4,
    "in my professional experience": 5, "as per cwe-": 4,
    "as defined by owasp": 5, "it is worth noting that": 5,
    "it should be noted that": 5, "it is important to note": 5,
    "this represents a significant": 4, "security posture": 4,
    "attack surface": 3, "threat actor": 3, "sophisticated attacker": 4,
    "could potentially": 4, "may potentially": 5, "might potentially": 5,
    # Low confidence (2-3, meaningful in aggregate)
    "comprehensive security audit": 3, "routine security research": 3,
    "security assessment": 2, "executive summary": 2,
    "in conclusion": 3, "to summarize": 3,
    "recommended actions": 2, "remediation steps": 2,
}

def score_lexical(text):
    text_lower = text.lower()
    total_weight = 0
    matches = []
    for phrase, weight in AI_PHRASES.items():
        if phrase in text_lower:
            total_weight += weight
            matches.append((phrase, weight))
    import math
    normalized = min(100, 30 * math.log1p(total_weight))
    return normalized, matches
```

### 1B: Statistical Text Analysis

```python
import re, numpy as np
from collections import Counter
import math

def sentence_length_variance(text):
    """Low CV = uniform sentences = AI. Human CV > 0.6, AI CV 0.3-0.5."""
    sentences = [s.strip() for s in re.split(r'[.!?]+', text) if len(s.strip()) > 3]
    if len(sentences) < 5:
        return 0
    lengths = [len(s.split()) for s in sentences]
    cv = np.std(lengths) / np.mean(lengths) if np.mean(lengths) > 0 else 0
    if cv < 0.3: return 80
    elif cv < 0.5: return 60 - (cv - 0.3) * 100
    elif cv < 0.7: return 30 - (cv - 0.5) * 50
    else: return max(5, 20 - (cv - 0.7) * 30)

def passive_voice_ratio(text):
    """AI: 35-55% passive. Human: 15-25%."""
    sentences = [s.strip() for s in re.split(r'[.!?]+', text) if len(s.strip()) > 5]
    passive_patterns = [
        r'\b(?:is|are|was|were|been|being|be)\s+\w+ed\b',
        r'\b(?:is|are|was|were|been|being|be)\s+\w+en\b',
        r'\bhas been\b', r'\bhave been\b', r'\bwas found\b',
        r'\bwas discovered\b', r'\bwas identified\b',
        r'\bcan be exploited\b', r'\bcould be used\b',
    ]
    passive_count = sum(1 for s in sentences if any(re.search(p, s, re.IGNORECASE) for p in passive_patterns))
    ratio = passive_count / len(sentences) if sentences else 0
    if ratio > 0.5: return 75
    elif ratio > 0.35: return 50
    elif ratio > 0.25: return 25
    else: return 10

def contraction_absence_score(text):
    """AI avoids contractions. High formality ratio = AI signal."""
    contractions = ["don't", "doesn't", "can't", "won't", "isn't", "aren't",
                    "wasn't", "weren't", "couldn't", "shouldn't", "wouldn't",
                    "hasn't", "haven't", "hadn't", "it's", "that's", "there's",
                    "i'm", "i've", "i'd", "i'll", "we're", "we've", "we'd",
                    "they're", "they've", "you're", "you've"]
    formal_equivalents = ["do not", "does not", "cannot", "will not", "is not",
                         "are not", "was not", "were not", "could not",
                         "should not", "would not", "has not", "have not",
                         "had not", "it is", "that is", "there is",
                         "i am", "i have", "i would", "i will"]
    text_lower = text.lower()
    contraction_count = sum(1 for c in contractions if c in text_lower)
    formal_count = sum(1 for f in formal_equivalents if f in text_lower)
    total = contraction_count + formal_count
    if total < 3: return 0
    ratio = formal_count / total
    if ratio > 0.9: return 60
    elif ratio > 0.7: return 40
    elif ratio > 0.5: return 20
    else: return 5

def bigram_entropy(text):
    """Lower entropy = more predictable = AI. AI: 0.85-0.92, Human: 0.93-0.99."""
    words = text.lower().split()
    if len(words) < 20: return 0
    bigrams = [(words[i], words[i+1]) for i in range(len(words)-1)]
    counts = Counter(bigrams)
    total = len(bigrams)
    entropy = -sum((c/total) * math.log2(c/total) for c in counts.values())
    max_entropy = math.log2(total)
    normalized = entropy / max_entropy if max_entropy > 0 else 0
    if normalized < 0.88: return 65
    elif normalized < 0.92: return 40
    elif normalized < 0.95: return 20
    else: return 5
```

**Optional (if server can run inference):** GPT-2 perplexity scoring. AI text has perplexity 15-50; human text 50-200. Use `transformers` library, truncate input to 1024 tokens.

### 1C: Template Detection

```python
KNOWN_TEMPLATES = [
    {"name": "classic_bounty_template",
     "required_sections": ["title", "description", "steps to reproduce", "impact"],
     "ordering_strict": True, "weight": 15},
    {"name": "dear_security_team",
     "markers": ["dear security team", "i hope this", "best regards"], "weight": 25},
    {"name": "dependency_dump",
     "markers": [r"@\d+\.\d+\.\d+.*CVE-\d{4}-\d+"], "min_matches": 3, "weight": 30},
    {"name": "owasp_padding",
     "markers": ["as defined by owasp", "owasp top 10", "as recommended by owasp"], "weight": 20},
    {"name": "audit_checklist",
     "markers": [r"\d+\.\s+(use of|missing|insufficient|potential|insecure)"],
     "min_matches": 4, "weight": 25},
]

def detect_templates(text):
    text_lower = text.lower()
    total, matched = 0, []
    for tmpl in KNOWN_TEMPLATES:
        if "markers" in tmpl:
            hits = sum(1 for m in tmpl["markers"]
                      if (re.search(m, text_lower) if any(c in m for c in r"[]().*+?")
                          else m in text_lower))
            if hits >= tmpl.get("min_matches", 1):
                total += tmpl["weight"]
                matched.append(tmpl["name"])
    return total, matched
```

---

## Axis 2: Structural Quality (SEPARATE from slop score)

Keep existing heuristics (missing version, no code blocks, no repro steps, etc.) but output as `qualityScore` only. **These do NOT feed into slopScore.**

```javascript
// New API response format:
{
  "slopScore": 72,           // AI likelihood (axes 1, 3, 4)
  "qualityScore": 35,        // report completeness (axis 2)
  "combinedScore": 58,       // weighted blend for backward compat
  "confidence": 0.73,
  "breakdown": { "linguistic": 65, "structural_quality": 35, "factual": 80, "llm_analysis": 75 },
  "evidence": [
    {"signal": "ai_phrase", "text": "Certainly! Let me elaborate", "weight": 10},
    {"signal": "hallucinated_function", "text": "curl_parse_header_secure() not in curl source", "weight": 25},
    {"signal": "low_sentence_variance", "cv": 0.31, "weight": 8},
    {"signal": "template_match", "template": "dear_security_team", "weight": 15}
  ],
  "feedback": [...]           // quality suggestions (separate)
}
```

---

## Axis 3: Factual Verification

### 3A: Function/File Verification via GitHub API

```python
import re, requests

def extract_code_references(text):
    functions = re.findall(r'\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\)', text)
    file_refs = re.findall(r'(?:^|\s)((?:[\w\-]+/)*[\w\-]+\.[chpyrsjtml]{1,4})(?::(\d+))?', text)
    return functions, file_refs

def verify_against_github(project_url, functions, file_refs):
    """GitHub search API: GET /search/code?q={func}+repo:{owner/repo}
    Rate limit: 10/min unauth, 30/min auth. Skip STDLIB_FUNCTIONS."""
    results = []
    for func in functions:
        if func in STDLIB_FUNCTIONS: continue
        resp = requests.get("https://api.github.com/search/code",
            params={"q": f"{func} repo:{project_url}"},
            headers={"Accept": "application/vnd.github.v3+json"})
        if resp.status_code == 200 and resp.json()["total_count"] == 0:
            results.append({"type": "hallucinated_function", "name": func, "exists": False, "weight": 25})
        elif resp.status_code == 200:
            results.append({"type": "verified_function", "name": func, "exists": True, "weight": -5})
    return results
```

### 3B: CVE Verification via NVD API

```python
def verify_cves(text):
    cves = re.findall(r'CVE-(\d{4})-(\d{4,})', text)
    results = []
    for year, number in cves:
        cve_id = f"CVE-{year}-{number}"
        resp = requests.get("https://services.nvd.nist.gov/rest/json/cves/2.0", params={"cveId": cve_id})
        if resp.status_code == 200 and resp.json().get("totalResults", 0) == 0:
            results.append({"type": "fabricated_cve", "cve": cve_id, "weight": 20})
        if int(year) < 2024:
            results.append({"type": "stale_cve", "cve": cve_id, "weight": 10})
    return results
```

### 3C: Severity Inflation

```python
def detect_severity_inflation(text):
    """Claims CVSS 9.8 Critical without RCE/auth-bypass evidence → slop signal."""
    t = text.lower()
    claims_critical = any(p in t for p in ["cvss: 9.8", "cvss 9.8", "cvss 3.1: 9.8", "severity: critical", "critical (cvss"])
    has_evidence = any(p in t for p in ["code execution confirmed", "reverse shell", "uid=", "whoami output", "calc.exe", "command executed"])
    has_poc = bool(re.search(r'(curl|wget|python|java|nc|ncat)\s+.*\S{10,}', text))
    if claims_critical and not has_evidence and not has_poc:
        return {"type": "severity_inflation", "weight": 15}
    return None
```

### 3D: Placeholder URLs

```python
PLACEHOLDER_URLS = ["example.com", "target.com", "vulnerable-server.com", "attacker.com",
                    "evil.com", "malicious.com", "test.com", "victim.com", "your-domain.com"]

def detect_placeholder_urls(text):
    hits = [url for url in PLACEHOLDER_URLS if url in text.lower()]
    return {"type": "placeholder_urls", "urls": hits, "weight": 12} if hits else None
```

### 3E: Fabricated Debug Output

```python
def detect_fake_debug_output(text):
    """Detect fabricated ASan/GDB/valgrind output."""
    signals = []
    # ASan: round/sequential addresses are fake
    asan_match = re.search(r'AddressSanitizer.*?0x([0-9a-f]+)', text)
    if asan_match and (asan_match.group(1).endswith('0000') or asan_match.group(1).endswith('000')):
        signals.append({"type": "suspicious_asan_address", "weight": 8})
    # Stack traces: repeating frames = fabricated
    stack_frames = re.findall(r'#\d+\s+0x[0-9a-f]+\s+in\s+(\w+)', text)
    if len(stack_frames) >= 3 and len(set(stack_frames)) < len(stack_frames) / 2:
        signals.append({"type": "repeating_stack_frames", "weight": 15})
    # GDB: all registers sharing same prefix = fabricated
    gdb_regs = re.findall(r'(rax|rbx|rcx|rdx|rsi|rdi|rsp|rbp|rip)\s*=?\s*0x([0-9a-f]+)', text, re.IGNORECASE)
    if len(gdb_regs) >= 4:
        addrs = [g[1] for g in gdb_regs]
        if len(set(a[:4] for a in addrs)) <= 2:
            signals.append({"type": "fabricated_registers", "weight": 10})
    return signals
```

---

## Axis 4: LLM Deep Analysis (CRITICAL — currently broken)

**This is the #1 priority fix.** Debug why `llmSlopScore` is always null. The LLM call must actually execute.

### LLM Prompt

```python
LLM_ANALYSIS_PROMPT = """You are a PSIRT triage analyst evaluating whether a vulnerability report was written by a human or generated by AI.

REPORT:
---
{report_text}
---

Score each dimension 0-100 (100 = definitely AI):

1. SPECIFICITY: Real, verifiable details (specific commits, exact paths) vs plausible-but-unverifiable claims?
2. ORIGINALITY: Original insight vs textbook/CWE definition repackaged as a "finding"?
3. VOICE: Human personality (contractions, fragments, typos) vs formal AI (perfect grammar, hedging, politeness)?
4. COHERENCE: Do technical claims make internal sense? Does the PoC match the described vuln?
5. HALLUCINATION: Fabricated function names, wrong file paths, nonexistent CVEs, synthetic debug output?

Return ONLY JSON:
{
  "specificity": <0-100>, "originality": <0-100>, "voice": <0-100>,
  "coherence": <0-100>, "hallucination": <0-100>, "overall": <0-100>,
  "reasoning": "<2-3 sentences>",
  "red_flags": ["<specific quotes or patterns>"]
}"""
```

### Integration

```python
import json

async def llm_analyze(report_text, llm_client):
    prompt = LLM_ANALYSIS_PROMPT.format(report_text=report_text[:4000])
    response = await llm_client.chat(
        model="gpt-4o-mini",  # or claude-3-haiku — fast, cheap (~$0.01/report)
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1, max_tokens=500)
    try:
        scores = json.loads(response.content)
        llm_score = (scores["specificity"] * 0.15 + scores["originality"] * 0.25 +
                     scores["voice"] * 0.20 + scores["coherence"] * 0.15 +
                     scores["hallucination"] * 0.25)
        return {"llmSlopScore": round(llm_score), "llmBreakdown": scores,
                "llmFeedback": scores.get("reasoning", ""),
                "llmRedFlags": scores.get("red_flags", []), "llmEnhanced": True}
    except (json.JSONDecodeError, KeyError):
        return {"llmSlopScore": None, "llmEnhanced": False}
```

**Cost:** ~$0.01/report with GPT-4o-mini = $1/day at 100 reports. If needed: only run LLM when heuristic score is in ambiguous zone (20-60), cache by content hash.

---

## Score Fusion

```python
def compute_final_score(linguistic, quality, factual, llm_score,
                        linguistic_evidence, factual_evidence):
    weights = {"linguistic": 0.25, "factual": 0.30, "llm": 0.35, "template": 0.10}

    # Hallucinated function = near-conclusive → boost factual weight
    if any(e["type"] == "hallucinated_function" for e in factual_evidence):
        weights = {"linguistic": 0.15, "factual": 0.50, "llm": 0.25, "template": 0.10}

    # If LLM failed, redistribute its weight
    if llm_score is None:
        weights["linguistic"] += weights["llm"] * 0.4
        weights["factual"] += weights["llm"] * 0.4
        weights["template"] += weights["llm"] * 0.2
        weights["llm"] = 0
        llm_score = 0

    raw_score = (linguistic * weights["linguistic"] + factual * weights["factual"] +
                 llm_score * weights["llm"] + linguistic * weights["template"])

    # Confidence: more evidence → more confidence, uncertain → pull toward 50
    evidence_count = len(linguistic_evidence) + len(factual_evidence)
    confidence = min(1.0, 0.3 + evidence_count * 0.07 + (0.2 if llm_score else 0))
    final_score = raw_score * confidence + 50 * (1 - confidence)

    return {"slopScore": round(final_score), "qualityScore": round(quality), "confidence": round(confidence, 2)}
```

---

## Evaluation Framework (ship with the feature)

### Ground Truth

Create `test_reports.json` with 100+ labeled reports (50 slop, 50 legit) from:
- Our 29-report blind test (in `vulnrap_sample_reports_and_sources.md`)
- Daniel Stenberg's curl AI slop gist (20+ full-text slop)
- HuggingFace `Hacker0x01/hackerone_disclosed_reports` (50+ legit)
- Full Disclosure / oss-security archives (50+ legit)

### Metrics

```python
def evaluate(predictions, ground_truth):
    from sklearn.metrics import roc_auc_score, precision_recall_curve
    y_true = [1 if gt == "slop" else 0 for gt in ground_truth]
    y_scores = predictions

    auc = roc_auc_score(y_true, y_scores)
    slop_scores = [s for s, gt in zip(y_scores, y_true) if gt == 1]
    legit_scores = [s for s, gt in zip(y_scores, y_true) if gt == 0]
    cohens_d = (np.mean(slop_scores) - np.mean(legit_scores)) / np.sqrt(
        (np.var(slop_scores) + np.var(legit_scores)) / 2)
    precisions, recalls, thresholds = precision_recall_curve(y_true, y_scores)
    f1s = 2 * precisions * recalls / (precisions + recalls + 1e-8)
    best_f1 = np.max(f1s)

    threshold_80 = sorted(slop_scores)[int(0.2 * len(slop_scores))]
    fpr_at_80 = sum(1 for s in legit_scores if s >= threshold_80) / len(legit_scores)

    return {"auc_roc": round(auc, 3), "cohens_d": round(cohens_d, 2),
            "best_f1": round(best_f1, 3), "fpr_at_80_sensitivity": round(fpr_at_80, 3),
            "score_gap": round(np.mean(slop_scores) - np.mean(legit_scores), 1)}
```

### Targets

| Metric | Current | Min Target | Stretch |
|--------|---------|------------|---------|
| AUC-ROC | ~0.52 | 0.85 | 0.95 |
| Cohen's d | 0.06 | 1.0 | 1.5 |
| Best F1 | ~0.55 | 0.80 | 0.90 |
| Score gap | 0.5 pts | 25 pts | 40 pts |
| FPR @ 80% sensitivity | ~73% | <15% | <5% |

### CI/CD Gate

```bash
python evaluate.py --test-set test_reports.json --min-auc 0.85 --min-cohens-d 1.0
```

---

## Implementation Priority

1. **Fix LLM scoring** — Debug why `llmSlopScore` is null. This alone → AUC ~0.80.
2. **Separate quality from slop** — New `qualityScore` output. Fixes false positives on terse legit reports.
3. **Add lexical AI markers** (1A) — `AI_PHRASES` dict, ~50 lines, catches 3-4 more slop.
4. **Severity inflation detection** (3C) — Catches 60%+ of slop.
5. **Placeholder URL detection** (3D) — Catches template slop.
6. **Statistical text features** (1B) — Sentence variance, passive voice, contraction absence.
7. **Template detection** (1C) — "Dear Security Team", dependency dump patterns.
8. **Factual verification** (3A-B) — GitHub/NVD API lookups. Highest effort, catches sophisticated slop.
9. **Evaluation framework** — Ship labeled test data + metrics. Run on every deploy.
10. **Score fusion** — Bayesian combination with confidence estimation.

---

## Companion Files

- `vulnrap_sample_reports_and_sources.md` — 50+ sample reports, source URLs, API examples, batch scripts
- `vulnrap_accuracy_analysis.md` — 29-report blind test results with statistics
- `fulldisclosure_reports.txt` — 25+ raw Full Disclosure advisories for testing
