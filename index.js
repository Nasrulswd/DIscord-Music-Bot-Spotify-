require('dotenv').config();

async function main() {
  const sodium = require('libsodium-wrappers');
  await sodium.ready;
  console.log('✅ Sodium encryption ready');

  const {
    Client, GatewayIntentBits, Events, AuditLogEvent, MessageFlags,
    ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle,
    ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  } = require('discord.js');
  const { handleCommand }  = require('./src/commands');
  const { handleButton }   = require('./src/buttons');
  const { setClient, postIdlePanel, updatePanel, stopPanel } = require('./src/panel');
  const { getPlayer, removePlayer } = require('./src/player');
  const { getPlaylists }   = require('./src/playlists');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  const emptyTimers = new Map();

  client.once(Events.ClientReady, async (c) => {
    setClient(c);
    console.log(`✅ Bot is online! Logged in as ${c.user.tag}`);
    console.log(`   Serving ${c.guilds.cache.size} server(s)`);

    // Clear stale messages then post fresh standby dashboard in each music channel
    const channelIds = (process.env.MUSIC_CHANNEL_IDS || process.env.MUSIC_CHANNEL_ID || '')
      .split(',').map(id => id.trim()).filter(Boolean);

    for (const id of channelIds) {
      try {
        const channel = await c.channels.fetch(id);
        const fetched = await channel.messages.fetch({ limit: 100 });
        if (fetched.size >= 2) {
          await channel.bulkDelete(fetched, true).catch(() => {});
        } else if (fetched.size === 1) {
          await fetched.first().delete().catch(() => {});
        }
        await postIdlePanel(channel);
        console.log(`✅ Standby dashboard posted in #${channel.name}`);
      } catch (err) {
        console.error(`[Startup Panel] Failed for ${id}:`, err.message);
      }
    }
  });

  // ── Voice state monitoring ────────────────────────────────────────────────────
  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const guild   = oldState.guild ?? newState.guild;
    const guildId = guild.id;
    const botId   = client.user.id;

    // ── Bot's own state changed ─────────────────────────────────────────────────
    if (oldState.id === botId) {

      // Forced disconnect — bot removed from voice by someone
      if (oldState.channelId && !newState.channelId) {
        const player = getPlayer(guildId);
        if (player.currentTrack) { // only act if we were playing (not a voluntary leave)
          let byUser = 'the server';
          try {
            await new Promise(r => setTimeout(r, 600)); // give Discord time to write the audit log
            const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberDisconnect, limit: 1 });
            const entry = logs.entries.first();
            if (entry?.executor?.id) byUser = `<@${entry.executor.id}>`;
          } catch {}
          const lastAction = { label: '⏹ Disconnected', user: byUser };
          player.stop();
          removePlayer(guildId);
          await stopPanel(guildId, byUser, lastAction);
          try { await guild.members.me.setNickname(null); } catch {}
        }
        return;
      }

      // Server-muted — pause audio and show in panel
      if (!oldState.serverMute && newState.serverMute) {
        const player = getPlayer(guildId);
        if (player.currentTrack) {
          player.pause();
          player.lastAction = { label: '× Server muted', user: 'the server' };
          await updatePanel(guildId, player);
        }
        return;
      }
    }

    // ── Auto-leave when voice channel has no human users ───────────────────────
    const botChannel = guild.members.me?.voice?.channelId;
    if (!botChannel) {
      if (emptyTimers.has(guildId)) { clearTimeout(emptyTimers.get(guildId)); emptyTimers.delete(guildId); }
      return;
    }
    const voiceChannel = guild.channels.cache.get(botChannel);
    if (!voiceChannel) return;
    const humans = voiceChannel.members.filter(m => !m.user.bot).size;
    if (humans === 0) {
      if (!emptyTimers.has(guildId)) {
        console.log(`[Empty Channel] Leaving in 5 min (${guild.name})`);
        emptyTimers.set(guildId, setTimeout(async () => {
          emptyTimers.delete(guildId);
          const player = getPlayer(guildId);
          if (player?.voiceConnection) {
            player.stop();
            removePlayer(guildId);
            await stopPanel(guildId, 'everyone left');
          }
        }, 5 * 60 * 1000));
      }
    } else {
      if (emptyTimers.has(guildId)) { clearTimeout(emptyTimers.get(guildId)); emptyTimers.delete(guildId); }
    }
  });

  // Stores the btn_play_modal interaction per user so we can delete the ephemeral
  // when they click "Add Song" (showing a modal prevents doing both in one response)
  const _pendingAdd = new Map();

  function _buildPlayModal(ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle) {
    return new ModalBuilder()
      .setCustomId('modal_play')
      .setTitle('🎵 What do you want to play?')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('play_query')
            .setLabel('Song name, artist, or URL')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. ROSÉ - number one girl')
            .setRequired(true)
        )
      );
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    try {

      // ── Slash commands ─────────────────────────────────────────────────────────
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction);

      // ── Play modal submit ──────────────────────────────────────────────────────
      } else if (interaction.isModalSubmit() && interaction.customId === 'modal_play') {
        const query        = interaction.fields.getTextInputValue('play_query').trim();
        const voiceChannel = interaction.member?.voice?.channel;

        if (!voiceChannel) {
          await interaction.reply({ content: '✕ Join a voice channel first.', flags: 64 });
          setTimeout(() => interaction.deleteReply().catch(() => {}), 60_000);
          return;
        }

        await interaction.deferReply({ flags: 64 });

        // Reuse the same play logic as /play command
        const { playTrack } = require('./src/commands');
        await playTrack({
          guildId:   interaction.guildId,
          guild:     interaction.guild,
          member:    interaction.member,
          channel:   interaction.channel,
          userId:    interaction.user.id,
          userName:  interaction.user.displayName || interaction.user.username,
          query,
          onDone:    () => interaction.deleteReply().catch(() => {}),
          onError:   (msg) => { interaction.editReply(`✕ ${msg}`).catch(() => {}); setTimeout(() => interaction.deleteReply().catch(() => {}), 60_000); },
        });

      // ── Play button — open modal directly, or show playlists menu if any saved ──
      } else if (interaction.isButton() && interaction.customId === 'btn_play_modal') {
        const saved = getPlaylists();
        if (!saved.length) {
          // No saved playlists — open modal immediately (zero extra clicks)
          await interaction.showModal(_buildPlayModal(ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle));
        } else {
          // Show ephemeral with both "Add Song" button and saved playlists dropdown
          const components = [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('btn_open_modal').setLabel('＋ Add Song').setStyle(ButtonStyle.Success)
            ),
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId('select_saved_playlist')
                .setPlaceholder('Or pick a saved playlist...')
                .addOptions(saved.map(p => ({
                  label:       p.name.slice(0, 100),
                  value:       p.url.slice(0, 100),
                  description: `Added by ${p.addedBy}`.slice(0, 100),
                })))
            ),
          ];
          await interaction.reply({ content: '**Add to Queue**', components, flags: MessageFlags.Ephemeral });
          // Store so we can delete it when the user acts
          const key = `${interaction.guildId}-${interaction.user.id}`;
          _pendingAdd.set(key, interaction);
          setTimeout(() => { _pendingAdd.delete(key); interaction.deleteReply().catch(() => {}); }, 60_000);
        }

      // ── "Add Song" button inside the playlists menu → open modal ─────────────
      } else if (interaction.isButton() && interaction.customId === 'btn_open_modal') {
        await interaction.showModal(_buildPlayModal(ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle));
        // Delete the ephemeral via the stored original interaction
        const key = `${interaction.guildId}-${interaction.user.id}`;
        const orig = _pendingAdd.get(key);
        if (orig) { _pendingAdd.delete(key); orig.deleteReply().catch(() => {}); }

      // ── Other buttons / select menus ───────────────────────────────────────────
      } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
        await handleButton(interaction);
      }

    } catch (err) {
      console.error('[Unhandled Error]', err);
      const msg = { content: '✕ Something went wrong.', flags: 64 };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(msg).catch(() => {});
      } else {
        await interaction.reply(msg).catch(() => {});
      }
    }
  });

  client.login(process.env.DISCORD_TOKEN);
}

main().catch(console.error);
