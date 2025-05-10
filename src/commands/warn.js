const { SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const fs = require('fs');
const yaml = require('js-yaml');
const { addWarning, getUserWarnings, shouldMuteUser, getWarningCount, addMute } = require('../utils/database');
const path = require('path');

// Load configuration
const config = yaml.load(fs.readFileSync(path.join(__dirname, '../../config.yml'), 'utf8'));

// Create the slash command
const data = new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a user for breaking server rules')
    .addUserOption(option =>
        option.setName('user')
            .setDescription('The user to warn')
            .setRequired(true));

// Create the context menu commands
const userContextMenu = new ContextMenuCommandBuilder()
    .setName('Warn User')
    .setType(ApplicationCommandType.User)
    .setDMPermission(false)
    .setDefaultMemberPermissions('0');

const messageContextMenu = new ContextMenuCommandBuilder()
    .setName('Warn Message Author')
    .setType(ApplicationCommandType.Message)
    .setDMPermission(false)
    .setDefaultMemberPermissions('0');

async function execute(interaction, client) {
    try {
        // Check if user has staff role or is owner
        const member = interaction.member;
        const isOwner = member.id === interaction.guild.ownerId;
        const hasStaffRole = member.roles.cache.has(config.roles.staffRoleId.toString());
        
        console.log('Permission Debug:', {
            userId: member.id,
            isOwner,
            hasStaffRole,
            userRoles: Array.from(member.roles.cache.keys()),
            configStaffRole: config.roles.staffRoleId,
            guildOwner: interaction.guild.ownerId
        });

        if (!hasStaffRole && !isOwner) {
            return interaction.reply({ 
                content: 'You do not have permission to use this command.', 
                ephemeral: true 
            });
        }

        // Defer the reply immediately to prevent timeout
        await interaction.deferReply({ ephemeral: true });

        let targetUser;
        if (interaction.isUserContextMenuCommand()) {
            targetUser = interaction.targetUser;
        } else if (interaction.isMessageContextMenuCommand()) {
            targetUser = interaction.targetMessage.author;
        } else {
            targetUser = interaction.options.getUser('user');
        }

        // Get current warning count
        const warningCount = await getWarningCount(targetUser.id);

        // Create embed showing warning information
        const embed = new EmbedBuilder()
            .setColor('#FFA500')
            .setTitle('Warning Confirmation')
            .setDescription(`You are about to warn ${targetUser.tag}`)
            .addFields(
                { name: 'User ID', value: targetUser.id, inline: true },
                { name: 'Current Warnings', value: `${warningCount}/${config.warnings.maxWarnings}`, inline: true },
                { name: 'Warning Expiration', value: `${config.warnings.warningExpirationDays} days`, inline: true }
            )
            .setTimestamp();

        // Create select menu for warning reasons
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('warn_reason')
            .setPlaceholder('Select a reason for the warning')
            .addOptions(
                config.warnings.reasons.map(reason => ({
                    label: reason.title,
                    description: reason.description,
                    emoji: reason.emoji,
                    value: reason.title
                }))
            );

        const row = new ActionRowBuilder().addComponents(selectMenu);

        // Edit the deferred reply with the embed and select menu
        await interaction.editReply({ 
            embeds: [embed], 
            components: [row],
            ephemeral: true 
        });

        // Handle the select menu interaction
        const filter = i => i.customId === 'warn_reason' && i.user.id === interaction.user.id;
        const collector = interaction.channel.createMessageComponentCollector({ filter, time: 60000 });

        collector.on('collect', async i => {
            const selectedReason = config.warnings.reasons.find(r => r.title === i.values[0]);
            
            if (selectedReason.title === 'Other') {
                // Create modal for custom reason
                const modal = new ModalBuilder()
                    .setCustomId('warn_custom_reason')
                    .setTitle('Custom Warning Reason');

                const reasonInput = new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Please specify the reason for the warning')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);

                const actionRow = new ActionRowBuilder().addComponents(reasonInput);
                modal.addComponents(actionRow);

                await i.showModal(modal);
            } else {
                // Handle predefined reason
                await handleWarning(i, targetUser, selectedReason);
            }
        });
    } catch (error) {
        console.error('Error in warn command execution:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: 'There was an error while executing this command!', 
                ephemeral: true 
            });
        } else if (interaction.deferred) {
            await interaction.editReply({
                content: 'There was an error while executing this command!',
                ephemeral: true
            });
        }
    }
}

async function handleWarning(interaction, targetUser, reason) {
    const timestamp = Date.now();
    
    // Add warning to database
    await addWarning(targetUser.id, reason.title, interaction.user.id, timestamp);

    // Check if user should be muted after this warning
    const shouldMute = await shouldMuteUser(targetUser.id);
    const warningCount = await getWarningCount(targetUser.id);

    // Get message content if this is a context menu command
    let messageContent = '';
    if (interaction.isMessageContextMenuCommand() && interaction.targetMessage) {
        // Get the reference message if it exists
        const referencedMessage = interaction.targetMessage.reference ? 
            await interaction.channel.messages.fetch(interaction.targetMessage.reference.messageId).catch(() => null) : null;

        // Add referenced message if it exists
        if (referencedMessage) {
            messageContent = `\nReplying to:\n\`\`\`\n${referencedMessage.content}\n\`\`\`\nMessage:\n\`\`\`\n${interaction.targetMessage.content}\n\`\`\``;
        } else {
            messageContent = `\nMessage:\n\`\`\`\n${interaction.targetMessage.content}\n\`\`\``;
        }
    }

    // Create warning embed that will be used for logging
    const warningEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle(`<@${interaction.user.id}> Gave a Warning`)
        .addFields(
            { name: 'Warning given to:', value: `<@${targetUser.id}> (${targetUser.username})` },
            { name: 'Warnings', value: `${warningCount}/${config.warnings.maxWarnings}` },
            { name: 'Date Given', value: `<t:${Math.floor(timestamp / 1000)}:F>` },
            { name: 'Expire', value: `<t:${Math.floor((timestamp + (config.warnings.warningExpirationDays * 24 * 60 * 60 * 1000)) / 1000)}:F>` },
            { name: 'Reason', value: `\`\`\`\n${reason.title}${reason.description ? `\n${reason.description}` : ''}\n\`\`\`` }
        );

    // Add message content if from context menu
    if (interaction.isMessageContextMenuCommand() && interaction.targetMessage) {
        warningEmbed.addFields({
            name: 'Message',
            value: `\`\`\`\n${interaction.targetMessage.content}\n\`\`\``
        });
    }

    // Create a copy of the embed for DMs with different format
    const dmEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle(`You got a warning in ${interaction.guild.name}`)
        .setDescription(`Warned By: <@${interaction.user.id}>
Reason:
\`\`\`
${reason.title}${reason.description ? `\n${reason.description}` : ''}
\`\`\`
Date: <t:${Math.floor(timestamp / 1000)}:F>
Expire: <t:${Math.floor((timestamp + (config.warnings.warningExpirationDays * 24 * 60 * 60 * 1000)) / 1000)}:F>`)
        .setTimestamp();

    let dmSent = false;
    try {
        // Attempt to send DM to the warned user
        await targetUser.send({ embeds: [dmEmbed] });
        dmSent = true;
    } catch (error) {
        // Log DM failure but continue with other operations
        console.log(`Could not send warning DM to ${targetUser.tag}: ${error.message}`);
    }

    // If user should be muted, apply the mute
    if (shouldMute) {
        try {
            // Get the member object
            const member = await interaction.guild.members.fetch(targetUser.id);
            
            // Fetch the mute role first
            const muteRole = await interaction.guild.roles.fetch(config.roles.mutedRoleId.toString());
            
            if (!muteRole) {
                throw new Error('Mute role not found');
            }
            
            // Add the muted role
            await member.roles.add(muteRole.id);
            
            // Add mute to database with default duration from config
            await addMute(
                targetUser.id,
                `Automatic mute after reaching ${config.warnings.maxWarnings} warnings`,
                interaction.client.user.id,
                config.warnings.autoMuteDurationHours,
                timestamp
            );

            // Add mute notification to the warning embed
            warningEmbed.addFields({
                name: '🔇 Auto-Mute Applied',
                value: `User has been muted for ${config.warnings.autoMuteDurationHours} hours after reaching ${config.warnings.maxWarnings} warnings`,
                inline: false
            });

            // Try to DM the user about the mute
            try {
                const muteEmbed = new EmbedBuilder()
                    .setColor('#FF0000')
                    .setTitle('🔇 You have been muted')
                    .setDescription(`You have been automatically muted in ${interaction.guild.name} for reaching ${config.warnings.maxWarnings} warnings`)
                    .addFields({
                        name: 'Duration',
                        value: `${config.warnings.autoMuteDurationHours} hours`,
                        inline: true
                    })
                    .setTimestamp();

                await targetUser.send({ embeds: [muteEmbed] });
            } catch (error) {
                // Ignore DM errors
            }
        } catch (error) {
            console.error('Error applying auto-mute:', error);
            warningEmbed.addFields({
                name: '❌ Auto-Mute Failed',
                value: 'Failed to apply automatic mute. Please mute user manually.',
                inline: false
            });
        }
    }

    try {
        // Send log to the warning thread
        let logThread;
        try {
            // First try to fetch the thread directly
            logThread = await interaction.guild.channels.fetch(config.warnings.logThreadId.toString());
            
            if (!logThread) {
                // If direct fetch fails, try to fetch it as an active thread
                const activeThreads = await interaction.guild.channels.fetchActiveThreads();
                logThread = activeThreads.threads.get(config.warnings.logThreadId);
                
                if (!logThread) {
                    // If still not found, try archived threads in all channels
                    const channels = await interaction.guild.channels.fetch();
                    for (const [, channel] of channels) {
                        if (channel.isTextBased()) {
                            const archivedThreads = await channel.threads.fetchArchived();
                            const thread = archivedThreads.threads.get(config.warnings.logThreadId);
                            if (thread) {
                                logThread = thread;
                                // Unarchive the thread if found
                                if (thread.archived) {
                                    await thread.setArchived(false);
                                }
                                break;
                            }
                        }
                    }
                }
            }

            if (!logThread) {
                throw new Error('Thread not found in any channel (active or archived)');
            }
            
            if (!logThread.isThread()) {
                throw new Error('The specified ID is not a thread');
            }
        } catch (error) {
            console.error(`Error accessing warning log thread: ${error.message}`);
            throw new Error(`Failed to access warning log thread: ${error.message}. Thread ID: ${config.warnings.logThreadId}`);
        }

        // Send the warning log without DM status
        await logThread.send({ embeds: [warningEmbed] });

        // Try to DM the user but don't track success/failure
        try {
            await targetUser.send({ embeds: [dmEmbed] });
        } catch (error) {
            // Silently handle DM errors
            console.log(`Could not send warning DM to ${targetUser.tag}: ${error.message}`);
        }

        // Update the interaction with confirmation
        const confirmationEmbed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('Warning Issued')
            .setDescription(`${targetUser.tag} has been warned`)
            .addFields(
                { name: 'Reason', value: `${reason.emoji} ${reason.title}\n${reason.description}` },
                { name: 'Warned by', value: interaction.user.tag },
                { name: 'Warning Expiration', value: `${config.warnings.warningExpirationDays} days` }
            )
            .setTimestamp();

        await interaction.update({ 
            embeds: [confirmationEmbed],
            components: [] 
        });
    } catch (error) {
        console.error('Error handling warning:', error);
        await interaction.update({ 
            content: 'There was an error while processing the warning. The warning was recorded but some operations failed.',
            embeds: [],
            components: [] 
        });
    }
}

module.exports = {
    data,
    contextMenu: [userContextMenu, messageContextMenu],
    execute,
    handleWarning
};