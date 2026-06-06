// Run this file ONCE to register slash commands with Discord:
//   node deploy.js
//
// You only need to re-run it if you add or change commands.

require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song — search by name, artist, or paste a YouTube link')
    .addStringOption((opt) =>
      opt
        .setName('query')
        .setDescription('Song name, artist name, or YouTube URL')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop the music and disconnect the bot from the voice channel'),

  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song and play the next one in the queue'),

  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the current song'),

  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused song'),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the list of songs waiting to be played'),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show the song that is currently playing'),


].map((cmd) => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('📡 Registering slash commands with Discord...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands,
    });
    console.log('✅ All slash commands registered successfully!');
    console.log('   Commands may take up to 1 hour to appear globally.');
    console.log('   To test instantly, use a server-specific deploy instead.');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
})();
