import { SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("vulnrap-score")
    .setDescription("Look up a VulnRap score for a vulnerability report ID.")
    .addStringOption((option) =>
      option
        .setName("id")
        .setDescription(
          "Numeric report id from the URL (e.g. 1234 from vulnrap.com/results/1234).",
        )
        .setRequired(true)
        .setMaxLength(32),
    )
    .toJSON(),
];
