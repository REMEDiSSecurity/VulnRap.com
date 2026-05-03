// Task #733 — Welcome / confirm email dispatch for newsletter signups.
//
// VulnRap intentionally does not carry SMTP credentials in the
// production environment (see avri-drift-notifications.ts for the same
// rationale). Instead, this module POSTs a small JSON payload to a
// configurable webhook (NEWSLETTER_EMAIL_WEBHOOK_URL) that the
// operator wires up to whatever delivery service they prefer
// (SendGrid, SES, Mailgun, Postmark, an internal MTA, etc.). The
// payload includes the rendered subject + plain-text + HTML bodies so
// the bridge service does no templating of its own.
//
// When the webhook URL is not configured the dispatcher is a no-op
// that logs a single warning per process — the subscribe handler still
// records the row so the address is on the list, the user just won't
// receive a welcome email until an operator wires up delivery.
//
// The dispatcher is best-effort and fire-and-forget from the route's
// point of view: the subscribe response returns the moment the row is
// persisted, and a failed email never blocks the user-facing flow.

import { logger } from "./logger";

export type NewsletterEmailKind = "welcome" | "confirm";

export interface NewsletterEmailPayload {
  kind: NewsletterEmailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string;
  /** Only present on `kind === "confirm"` payloads. */
  confirmUrl?: string;
}

export type NewsletterEmailDispatcher = (
  payload: NewsletterEmailPayload,
) => Promise<{ ok: boolean; status?: number; error?: string }>;

const PRODUCT_NAME = "VulnRap";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RenderEmailInput {
  kind: NewsletterEmailKind;
  to: string;
  unsubscribeUrl: string;
  confirmUrl?: string;
}

export function renderNewsletterEmail(
  input: RenderEmailInput,
): NewsletterEmailPayload {
  const { kind, to, unsubscribeUrl, confirmUrl } = input;
  if (kind === "confirm") {
    if (!confirmUrl) {
      throw new Error(
        "[newsletter-email] confirmUrl is required for kind=confirm",
      );
    }
    const subject = `Confirm your ${PRODUCT_NAME} subscription`;
    const text = [
      `Thanks for signing up for the ${PRODUCT_NAME} community mailing list.`,
      "",
      "We need one click from you to confirm this address is yours.",
      "Click the link below — it will only ever be used to confirm this signup:",
      "",
      confirmUrl,
      "",
      "If you did not sign up, you can ignore this email and the address will",
      "be discarded automatically. You can also unsubscribe immediately:",
      unsubscribeUrl,
      "",
      `— The ${PRODUCT_NAME} team`,
    ].join("\n");
    const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#111;line-height:1.5">
<p>Thanks for signing up for the <strong>${PRODUCT_NAME}</strong> community mailing list.</p>
<p>We need one click from you to confirm this address is yours.</p>
<p><a href="${escapeHtml(confirmUrl)}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Confirm subscription</a></p>
<p style="font-size:12px;color:#666">If you did not sign up, ignore this email and the address will be discarded automatically.<br/>
Or <a href="${escapeHtml(unsubscribeUrl)}">unsubscribe immediately</a>.</p>
</body></html>`;
    return {
      kind,
      to,
      subject,
      text,
      html,
      unsubscribeUrl,
      confirmUrl,
    };
  }
  const subject = `Welcome to the ${PRODUCT_NAME} mailing list`;
  const text = [
    `You're on the ${PRODUCT_NAME} community mailing list — welcome.`,
    "",
    "What to expect:",
    "  * Low volume. Major releases, new detection signals, and the",
    "    occasional calibration audit / field-test write-up.",
    "  * No tracking pixels, no third-party newsletter platform.",
    "  * Plain text or lightly-formatted HTML, never marketing fluff.",
    "",
    "If this address ends up on the list by mistake, or you change your",
    "mind, one click unsubscribes — no login, no confirmation page:",
    "",
    unsubscribeUrl,
    "",
    `— The ${PRODUCT_NAME} team`,
  ].join("\n");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#111;line-height:1.5">
<p>You're on the <strong>${PRODUCT_NAME}</strong> community mailing list — welcome.</p>
<p><strong>What to expect:</strong></p>
<ul>
  <li>Low volume. Major releases, new detection signals, the occasional calibration audit / field-test write-up.</li>
  <li>No tracking pixels, no third-party newsletter platform.</li>
  <li>Plain text or lightly-formatted HTML, never marketing fluff.</li>
</ul>
<p style="font-size:12px;color:#666">Changed your mind? <a href="${escapeHtml(unsubscribeUrl)}">One-click unsubscribe</a> — no login, no confirmation page.</p>
</body></html>`;
  return { kind, to, subject, text, html, unsubscribeUrl };
}

let warnedNoWebhook = false;

export const defaultEmailDispatcher: NewsletterEmailDispatcher = async (
  payload,
) => {
  const url = process.env.NEWSLETTER_EMAIL_WEBHOOK_URL?.trim() || "";
  const token = process.env.NEWSLETTER_EMAIL_WEBHOOK_TOKEN?.trim() || "";
  const from = process.env.NEWSLETTER_EMAIL_FROM?.trim() || "";
  if (!url) {
    if (!warnedNoWebhook) {
      warnedNoWebhook = true;
      logger.warn(
        "[newsletter-email] NEWSLETTER_EMAIL_WEBHOOK_URL is not set — welcome / confirm emails will not be delivered. Wire it up to your delivery bridge (SES, SendGrid, internal MTA, …) to enable.",
      );
    }
    return { ok: false, error: "no webhook configured" };
  }
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "vulnrap-newsletter-mailer/1.0",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...payload,
        from: from || undefined,
      }),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, kind: payload.kind },
        "[newsletter-email] delivery webhook returned non-2xx",
      );
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    logger.warn(
      { err, kind: payload.kind },
      "[newsletter-email] delivery webhook unreachable",
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

let activeDispatcher: NewsletterEmailDispatcher = defaultEmailDispatcher;

/** Test seam — replaces the dispatcher used by sendNewsletterEmail. */
export function __setNewsletterEmailDispatcher(
  d: NewsletterEmailDispatcher | null,
): void {
  activeDispatcher = d ?? defaultEmailDispatcher;
}

export async function sendNewsletterEmail(
  input: RenderEmailInput,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const payload = renderNewsletterEmail(input);
  return activeDispatcher(payload);
}
