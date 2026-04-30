export const redactionCategories = [
  {
    label: "Personal Information",
    color: "text-red-400",
    items: [
      { what: "Email addresses", example: "user@company.com", replacement: "[REDACTED_EMAIL]" },
      { what: "Phone numbers", example: "+1 (555) 123-4567", replacement: "[REDACTED_PHONE]" },
      { what: "Social Security numbers", example: "123-45-6789", replacement: "[REDACTED_SSN]" },
      { what: "Credit card numbers", example: "4111 1111 1111 1111", replacement: "[REDACTED_CARD]" },
      { what: "Usernames & attributions", example: "reported by: jdoe", replacement: "[REDACTED_USERNAME]" },
    ],
  },
  {
    label: "Secrets & Credentials",
    color: "text-orange-400",
    items: [
      { what: "API keys & tokens", example: "api_key: sk_live_abc123...", replacement: "[REDACTED_API_KEY]" },
      { what: "Bearer tokens", example: "Bearer eyJhbG...", replacement: "Bearer [REDACTED_TOKEN]" },
      { what: "JWTs", example: "eyJhbG...eyJzdW...sig", replacement: "[REDACTED_JWT]" },
      { what: "AWS access keys", example: "AKIAIOSFODNN7...", replacement: "[REDACTED_AWS_KEY]" },
      { what: "Private keys (RSA/EC)", example: "-----BEGIN PRIVATE KEY-----", replacement: "[REDACTED_PRIVATE_KEY]" },
      { what: "Passwords", example: "password: hunter2", replacement: "[REDACTED_PASSWORD]" },
      { what: "Hex secrets", example: "secret: a1b2c3d4e5f6...", replacement: "[REDACTED_SECRET]" },
    ],
  },
  {
    label: "Infrastructure",
    color: "text-cyan-400",
    items: [
      { what: "IPv4 addresses", example: "192.168.1.100", replacement: "[REDACTED_IP]" },
      { what: "IPv6 addresses", example: "2001:0db8:85a3::8a2e", replacement: "[REDACTED_IP]" },
      { what: "Connection strings", example: "postgres://user:pass@host/db", replacement: "[REDACTED_CONNECTION_STRING]" },
      { what: "URLs with credentials", example: "https://admin:pass@host", replacement: "[REDACTED_URL_WITH_CREDS]" },
      { what: "Internal hostnames", example: "dev1.corp.internal", replacement: "[REDACTED_HOSTNAME]" },
      { what: "Internal/private URLs", example: "http://10.0.0.1:8080/admin", replacement: "[REDACTED_INTERNAL_URL]" },
      { what: "UUIDs", example: "550e8400-e29b-41d4-a716-...", replacement: "[REDACTED_UUID]" },
    ],
  },
  {
    label: "Organization",
    color: "text-purple-400",
    items: [
      { what: "Company names", example: "...at Acme Corp", replacement: "[REDACTED_COMPANY] Corp" },
    ],
  },
];

export const similarityMethods = [
  {
    label: "MinHash + Jaccard",
    color: "text-cyan-400",
    description: "Estimates set similarity between documents using randomized hashing.",
    details: [
      "Text is normalized (lowercased, whitespace collapsed) and split into 5-word shingles (sliding windows)",
      "Each shingle is hashed with MD5, then 128 independent hash functions produce a MinHash signature",
      "Two signatures are compared by counting matching positions — the ratio approximates Jaccard similarity",
      "Fast O(n) comparison regardless of document length",
    ],
  },
  {
    label: "SimHash",
    color: "text-blue-400",
    description: "Produces a 64-bit fingerprint that preserves structural similarity.",
    details: [
      "Each word is hashed with SHA-256, then bits are weighted (+1 or −1) across a 64-position vector",
      "Final fingerprint is the sign of each position — similar documents produce similar bit patterns",
      "Compared using Hamming distance (count of differing bits), converted to a 0–100% similarity score",
      "Good at catching structurally similar reports even when word choices differ",
    ],
  },
  {
    label: "LSH Banding",
    color: "text-green-400",
    description: "Locality-Sensitive Hashing narrows the search space before full comparison.",
    details: [
      "The 128-value MinHash signature is divided into 16 bands of 8 rows each",
      "Each band is hashed independently — if any band matches between two reports, they become candidates",
      "Candidates get full Jaccard + SimHash comparison; non-candidates are skipped entirely",
      "This makes similarity search sub-linear: we avoid comparing every report against every other report",
    ],
  },
  {
    label: "Section-Level Hashing",
    color: "text-purple-400",
    description: "Each section of your report is hashed and compared independently.",
    details: [
      "Reports are split by Markdown headers (# / ## / ### / ####), or by paragraph breaks if unstructured",
      "Each section is SHA-256 hashed after normalization — identical sections produce identical hashes",
      "Sections are weighted by type: high-value (vulnerability, PoC, impact), medium (environment, scope), or standard",
      "Detects when someone copies a specific section (e.g. the same PoC) even if the rest of the report differs",
    ],
  },
  {
    label: "Content Hash",
    color: "text-yellow-400",
    description: "SHA-256 of the full document for exact-match deduplication.",
    details: [
      "A single SHA-256 hash of the entire report text",
      "If two reports produce the same hash, they are byte-for-byte identical (after redaction)",
      "Used as a fast first-pass check before running heavier similarity algorithms",
    ],
  },
];

export const matchTypes = [
  { type: "Near-duplicate", threshold: "Jaccard ≥ 80% or LSH candidate + Jaccard ≥ 60%", color: "text-red-400" },
  { type: "High-similarity", threshold: "Jaccard ≥ 50%", color: "text-orange-400" },
  { type: "Structural", threshold: "SimHash ≥ 80%", color: "text-yellow-400" },
  { type: "Semantic", threshold: "Combined ≥ 15% (catch-all)", color: "text-muted-foreground" },
];

export const authenticitySignals = [
  {
    label: "Formulaic Phrase Detection",
    color: "text-violet-400",
    description: "Scans for 30+ weighted phrases that are hallmarks of AI-generated text. Compound multipliers increase the score when multiple phrases appear together.",
    phrases: [
      "it is important to note", "delve into", "comprehensive analysis", "in today's digital landscape",
      "robust security", "multifaceted", "paramount", "holistic approach", "meticulous",
      "it's crucial to", "represents a significant", "proactive measures",
    ],
    scoring: "Each phrase has an individual weight (3–10). Multiple hits apply compound multipliers (1.0× → 1.2× → 1.5× → 2.0× → 3.0×).",
  },
  {
    label: "Template Detection",
    color: "text-cyan-400",
    description: "Detects known report templates and boilerplate structure. Contributes 35% of the Authenticity axis.",
    checks: [
      { what: "Software version", points: "+8 if missing", example: "version 2.4.1" },
      { what: "Affected component/path", points: "+8 if missing", example: "/api/auth/login" },
      { what: "Reproduction steps", points: "+10 if missing", example: "Steps to reproduce" },
      { what: "Code blocks or PoC", points: "+5 if missing", example: "```curl ...```" },
      { what: "Attack vector / CVE / CWE", points: "+5 if missing", example: "CWE-79, network" },
      { what: "Impact assessment", points: "+5 if missing", example: "severity: high" },
      { what: "Expected vs. observed behavior", points: "+5 if missing", example: "should return 403" },
    ],
  },
  {
    label: "Spectral & Statistical Analysis",
    color: "text-orange-400",
    description: "Analyzes text entropy, periodicity, sentence structure, and vocabulary diversity. Contributes 25% of the Authenticity axis.",
    checks: [
      { what: "Report length", points: "<30 words: +25, <100: +10, >5000: +10", example: "Extremely short or padded" },
      { what: "Average sentence length", points: "+8 if avg >30 words/sentence", example: "AI tends to write long sentences" },
      { what: "Vocabulary diversity", points: "+10 if unique ratio <30%", example: "Repetitive, low-diversity language" },
      { what: "Text entropy & periodicity", points: "Spectral analysis of character patterns", example: "AI text is more uniform" },
    ],
  },
];

export const llmSubstanceDimensions = [
  {
    label: "PoC Validity (pocValidity)",
    description: "Does the proof-of-concept actually exercise the claimed vulnerability? Does it target the right library, use realistic inputs, and produce the described outcome?",
    example: "A real curl command hitting the vulnerable endpoint vs. a generic template with placeholder URLs",
  },
  {
    label: "Claim Specificity (claimSpecificity)",
    description: "Are version numbers, file paths, endpoints, and payloads concrete and internally consistent, or vague placeholders?",
    example: "\"/api/v2/users/profile\" with version 2.4.1 vs. \"the API endpoint\"",
  },
  {
    label: "Domain Coherence (domainCoherence)",
    description: "Does the reporter understand what the project actually does? Do the claimed vulnerabilities make sense for this type of software?",
    example: "Claiming SSRF in a client-side UI library, or SQLi in a project that doesn't use a database",
  },
  {
    label: "Substance Score (substanceScore)",
    description: "Overall technical depth — does the report contain real evidence, original analysis, and actionable details? Or is it generic padding?",
    example: "Specific error messages and stack traces vs. textbook vulnerability definitions",
  },
  {
    label: "Coherence Score (coherenceScore)",
    description: "Is the report internally consistent? Do reproduction steps match claims? Does the narrative flow logically without contradictions?",
    example: "SQLi claim matched with SQLi payload vs. an XSS payload paired with a SQLi description",
  },
];

export const slopTiers = [
  { tier: "Clean", range: "0–19", color: "text-green-500", bg: "bg-green-500/10" },
  { tier: "Likely Human", range: "20–39", color: "text-emerald-400", bg: "bg-emerald-400/10" },
  { tier: "Questionable", range: "40–59", color: "text-yellow-500", bg: "bg-yellow-500/10" },
  { tier: "Likely Slop", range: "60–79", color: "text-orange-500", bg: "bg-orange-500/10" },
  { tier: "Slop", range: "80–100", color: "text-destructive", bg: "bg-destructive/10" },
];
