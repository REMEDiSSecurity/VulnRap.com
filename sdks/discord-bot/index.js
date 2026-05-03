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

async function fetchVerification(reportId) {
  const url = `${API_BASE}/reports/${encodeURIComponent(reportId)}/verify`;
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
    )
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
    const badge = await fetchVerification(reportId);
    await interaction.editReply({ embeds: [buildEmbed(badge)] });
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
