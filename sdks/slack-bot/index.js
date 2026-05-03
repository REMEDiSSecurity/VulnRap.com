import 'dotenv/config';
import pkg from '@slack/bolt';

const { App, LogLevel } = pkg;

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const API_BASE = (process.env.VULNRAP_API_BASE || 'https://vulnrap.com/api').replace(/\/$/, '');
const PUBLIC_URL = (process.env.VULNRAP_PUBLIC_URL || 'https://vulnrap.com').replace(/\/$/, '');

if (!BOT_TOKEN || !APP_TOKEN) {
  console.error('Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN in environment.');
  process.exit(1);
}

const TIER_EMOJI = {
  CLEAN: ':white_check_mark:',
  LIKELY_HUMAN: ':white_check_mark:',
  LOW: ':large_green_circle:',
  MEDIUM: ':large_yellow_circle:',
  HIGH: ':large_orange_circle:',
  SLOP: ':red_circle:',
  AI_SLOP: ':red_circle:',
};

function emojiForTier(tier) {
  if (!tier) return ':grey_question:';
  const key = String(tier).toUpperCase().replace(/[^A-Z_]/g, '_');
  return TIER_EMOJI[key] ?? ':grey_question:';
}

function parseReportId(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const stripped = value.replace(/^#/, '').replace(/^VR[-_]?/i, '');
  if (/^\d+$/.test(stripped)) return stripped;
  return null;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'vulnrap-slack-bot/0.1' },
  });
  if (res.status === 404) {
    const err = new Error('Report not found.');
    err.status = 404;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`VulnRap API returned ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function topFiredSignals(report, limit = 3) {
  const evidence = Array.isArray(report?.evidence) ? report.evidence : [];
  if (evidence.length === 0) return [];
  return [...evidence]
    .filter((e) => e && (e.type || e.description))
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, limit);
}

function buildBlocks({ badge, report, reportId }) {
  const tier = badge.slopTier ?? 'UNKNOWN';
  const score = typeof badge.slopScore === 'number' ? badge.slopScore : null;
  const code = badge.reportCode || `#${badge.id ?? reportId}`;
  const reportUrl = `${PUBLIC_URL}/results/${badge.id ?? reportId}`;
  const fired = topFiredSignals(report);

  const firedLines = fired.length
    ? fired
        .map((e) => {
          const label = e.description || e.type;
          const weight = typeof e.weight === 'number' ? ` _(+${e.weight})_` : '';
          return `• ${label}${weight}`;
        })
        .join('\n')
    : '_No notable signals fired._';

  const similarity = badge.similarityMatchCount ?? 0;
  const sectionReuse = badge.sectionMatchCount ?? 0;

  return [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emojiForTier(tier)} VulnRap report ${code}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Slop score*\n${score === null ? '—' : `*${score}* / 100`}`,
        },
        {
          type: 'mrkdwn',
          text: `*Tier*\n\`${tier}\``,
        },
        {
          type: 'mrkdwn',
          text: `*Similarity*\n${similarity} match(es)`,
        },
        {
          type: 'mrkdwn',
          text: `*Section reuse*\n${sectionReuse} block(s)`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Top fired signals*\n${firedLines}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open report', emoji: true },
          url: reportUrl,
          style: 'primary',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `vulnrap.com — open the report for the full breakdown` },
      ],
    },
  ];
}

const app = new App({
  token: BOT_TOKEN,
  appToken: APP_TOKEN,
  signingSecret: SIGNING_SECRET,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

app.command('/vulnrap', async ({ command, ack, respond }) => {
  await ack();

  const raw = (command.text || '').trim().split(/\s+/)[0];
  const reportId = parseReportId(raw);

  if (!reportId) {
    await respond({
      response_type: 'ephemeral',
      text:
        `\`${raw || '(empty)'}\` does not look like a numeric report id. ` +
        `Try the number from the URL, e.g. \`/vulnrap 1234\`.`,
    });
    return;
  }

  try {
    const [badge, report] = await Promise.all([
      fetchJson(`${API_BASE}/reports/${encodeURIComponent(reportId)}/verify`),
      fetchJson(`${API_BASE}/reports/${encodeURIComponent(reportId)}`).catch(() => null),
    ]);

    await respond({
      response_type: 'in_channel',
      blocks: buildBlocks({ badge, report, reportId }),
      text: `VulnRap report ${badge.reportCode || `#${reportId}`}: slop ${badge.slopScore}/100 (${badge.slopTier})`,
    });
  } catch (err) {
    const msg =
      err.status === 404
        ? `No report found for id \`${reportId}\`.`
        : `Could not reach VulnRap API: ${err.message}`;
    await respond({ response_type: 'ephemeral', text: msg });
  }
});

app.error(async (err) => {
  console.error('Slack app error:', err);
});

await app.start();
console.log(`VulnRap Slack bot running in Socket Mode. API base: ${API_BASE}`);
