import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

const route = guildId
  ? Routes.applicationGuildCommands(clientId, guildId)
  : Routes.applicationCommands(clientId);

try {
  console.log(
    `Registering ${commands.length} command(s) ${
      guildId ? `to guild ${guildId}` : 'globally (may take up to 1h to propagate)'
    }...`,
  );
  const data = await rest.put(route, { body: commands });
  console.log(`Registered ${Array.isArray(data) ? data.length : 0} command(s).`);
} catch (err) {
  console.error('Failed to register commands:', err);
  process.exit(1);
}
