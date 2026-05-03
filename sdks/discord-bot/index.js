import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";

const TOKEN = process.env.DISCORD_TOKEN;
const API_BASE = (
  process.env.VULNRAP_API_BASE || "https://vulnrap.com/api"
).replace(/\/$/, "");
const PUBLIC_URL = (
  process.env.VULNRAP_PUBLIC_URL || "https://vulnrap.com"
).replace(/\/$/, "");

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in environment.");
  process.exit(1);
}

const TIER_COLORS = {
  CLEAN: 0x22c55e,
  LIKELY_HUMAN: 0x22c55e,
  LOW: 0x84cc16,
  MEDIUM: 0xf59e0b,
  HIGH: 0xf97316,
  SLOP: 0xef4444,
  AI_SLOP: 0xef4444,
};

function colorForTier(tier) {
  if (!tier) return 0x6366f1;
  const key = String(tier)
    .toUpperCase()
    .replace(/[^A-Z_]/g, "_");
  return TIER_COLORS[key] ?? 0x6366f1;
}

function parseReportId(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  // Accept numeric id, "VR-000B", "#1234", "1234"
  const stripped = value.replace(/^#/, "").replace(/^VR[-_]?/i, "");
  // If it's all digits, treat as numeric id; otherwise pass through (server resolves codes via lookup endpoints).
  if (/^\d+$/.test(stripped)) return stripped;
  // For codes like "000B" or "VR-000B" we still pass the original to API; but verify endpoint expects integer id.
  // Return null for non-numeric so caller can show a friendly error.
  return null;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "vulnrap-discord-bot/0.1",
    },
  });
  if (res.status === 404) {
    const err = new Error("Report not found.");
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

async function fetchVerification(reportId) {
  return fetchJson(
    `${API_BASE}/reports/${encodeURIComponent(reportId)}/verify`,
  );
}

async function fetchReport(reportId) {
  return fetchJson(`${API_BASE}/reports/${encodeURIComponent(reportId)}`);
}

// Pulls richer report data so we can show top fired signals; on any
// non-404 failure we fall back to the lightweight verify badge so the
// command still produces a useful embed.
async function fetchReportData(reportId) {
  try {
    const report = await fetchReport(reportId);
    return { source: "report", data: reportFromAnalysis(report) };
  } catch (err) {
    if (err.status === 404) throw err;
    const badge = await fetchVerification(reportId);
    return { source: "verify", data: badge };
  }
}

function reportFromAnalysis(report) {
  const evidence = Array.isArray(report.evidence) ? report.evidence : [];
  const topSignals = [...evidence]
    .filter((e) => e && typeof e.weight === "number")
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, 3);

  return {
    id: report.id,
    reportCode: report.reportCode,
    slopScore: report.slopScore,
    slopTier: report.slopTier,
    similarityMatchCount: Array.isArray(report.similarityMatches)
      ? report.similarityMatches.length
      : 0,
    sectionMatchCount: Array.isArray(report.sectionMatches)
      ? report.sectionMatches.length
      : 0,
    createdAt: report.createdAt,
    verifyUrl: report.verifyUrl,
    topSignals,
  };
}

function truncate(text, max = 80) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function formatTopSignals(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return null;
  return signals
    .map((sig) => {
      const desc = truncate(sig.description || sig.type || "signal");
      const weight = typeof sig.weight === "number" ? ` (+${sig.weight})` : "";
      return `• ${desc}${weight}`;
    })
    .join("\n");
}

function buildEmbed(badge) {
  const tier = badge.slopTier ?? "UNKNOWN";
  const score = typeof badge.slopScore === "number" ? badge.slopScore : null;
  const reportUrl = badge.verifyUrl || `${PUBLIC_URL}/results/${badge.id}`;
  const code = badge.reportCode || `#${badge.id}`;

  const embed = new EmbedBuilder()
    .setColor(colorForTier(tier))
    .setTitle(`VulnRap report ${code}`)
    .setURL(reportUrl)
    .addFields(
      {
        name: "Slop score",
        value: score === null ? "—" : `**${score} / 100**`,
        inline: true,
      },
      {
        name: "Tier",
        value: `\`${tier}\``,
        inline: true,
      },
      {
        name: "Similarity",
        value: `${badge.similarityMatchCount ?? 0} match(es)`,
        inline: true,
      },
      {
        name: "Section reuse",
        value: `${badge.sectionMatchCount ?? 0} block(s)`,
        inline: true,
      },
    );

  const topSignalsValue = formatTopSignals(badge.topSignals);
  if (topSignalsValue) {
    embed.addFields({
      name: "Top signals",
      value: topSignalsValue,
      inline: false,
    });
  }

  embed
    .setFooter({
      text: "vulnrap.com — open the report for the full breakdown",
    });

  if (badge.createdAt) {
    const ts = Date.parse(badge.createdAt);
    if (!Number.isNaN(ts)) embed.setTimestamp(new Date(ts));
  }

  return embed;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}. API base: ${API_BASE}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "vulnrap-score") return;

  const raw = interaction.options.getString("id", true);
  const reportId = parseReportId(raw);

  if (!reportId) {
    await interaction.reply({
      content:
        `\`${raw}\` does not look like a numeric report id. ` +
        `Try the number from the URL, e.g. \`/vulnrap-score 1234\`.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const { data } = await fetchReportData(reportId);
    await interaction.editReply({ embeds: [buildEmbed(data)] });
  } catch (err) {
    const msg =
      err.status === 404
        ? `No report found for id \`${reportId}\`.`
        : `Could not reach VulnRap API: ${err.message}`;
    await interaction.editReply({ content: msg });
  }
});

client.on(Events.Error, (err) => {
  console.error("Discord client error:", err);
});

await client.login(TOKEN);
