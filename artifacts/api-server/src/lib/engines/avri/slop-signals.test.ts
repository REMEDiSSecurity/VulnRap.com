import { describe, expect, it } from "vitest";
import { fabricatedPatchPenalty } from "./slop-signals";

describe("fabricatedPatchPenalty", () => {
  it("does not fire on a report that contains no patch/fix/diff claim", () => {
    const text = `An IDOR exists at /api/users/{id}. Two accounts are involved.
GET /api/users/42 returns Bob's data when authenticated as Alice.`;
    expect(fabricatedPatchPenalty(text).points).toBe(0);
  });

  it("does not fire when a real unified-diff hunk is present", () => {
    const text = `# Bug
Suggested patch:

\`\`\`diff
--- a/foo.py
+++ b/foo.py
@@ -1,3 +1,4 @@
-    return query
+    return safe(query)
\`\`\``;
    expect(fabricatedPatchPenalty(text).points).toBe(0);
  });

  it("does not fire when a code fence with leading +/- lines is present", () => {
    const text = `Suggested patch:

\`\`\`
- old_line()
+ new_line()
\`\`\``;
    expect(fabricatedPatchPenalty(text).points).toBe(0);
  });

  it("does not fire when the report shows a substantive code block (≥2 lines)", () => {
    const text = `Here's the fix (illustrative):

\`\`\`python
def update_profile(req, target_id):
    if req.user.id != target_id:
        abort(403)
    apply_changes(target_id, req.body)
\`\`\``;
    expect(fabricatedPatchPenalty(text).points).toBe(0);
  });

  it("fires on a 'suggested patch' written in prose with no diff or code", () => {
    const text = `# Authorization bypass

Suggested patch (illustrative, written from memory):

> Look up the profile, then insert an ownership check that compares
> the requester's session against the record's owner field, returning
> a 403 when the check fails.`;
    const result = fabricatedPatchPenalty(text);
    expect(result.points).toBeLessThan(0);
    expect(result.reason).toMatch(/AVRI_FABRICATED_PATCH/);
  });

  it("fires on 'here is the fix' followed by prose-only remediation", () => {
    const text = `The endpoint is vulnerable. Here's the fix: validate the
requester owns the target row before applying any update, otherwise
return 403. Severity: High.`;
    expect(fabricatedPatchPenalty(text).points).toBeLessThan(0);
  });

  it("fires on 'illustrative diff' with no actual diff body", () => {
    const text = `# Bug
Proposed diff (illustrative): wrap the call in a permission check
and bail out early when the actor is not the owner.`;
    expect(fabricatedPatchPenalty(text).points).toBeLessThan(0);
  });

  it("does not fire on a one-line 'Fix:' description (legitimate concise remediation)", () => {
    const text = `# XXE
Fix: drop XML_PARSE_NOENT and XML_PARSE_DTDLOAD; install
xmlSetExternalEntityLoader returning NULL.`;
    expect(fabricatedPatchPenalty(text).points).toBe(0);
  });
});
