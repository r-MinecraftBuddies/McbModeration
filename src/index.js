const { Client, GatewayIntentBits, Collection, ModalBuilder, TextInputBuilder, ActionRowBuilder, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { handleHoistedName } = require('./utils/antiHoist');
const { handleBlockedLink } = require('./utils/antiLink');
const { connect, close } = require('./utils/database');

// Load configuration
const config = yaml.load(fs.readFileSync(path.join(__dirname, '../config.yml'), 'utf8'));

// Verify configuration
if (!config.bot.token) {
    console.error('Missing bot token in config.yml');
    process.exit(1);
}

if (!config.bot.clientId) {
    console.error('Missing client ID in config.yml');
    process.exit(1);
}

if (!config.bot.guildId) {
    console.error('Missing guild ID in config.yml');
    process.exit(1);
}

// Add error handlers
process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// Command collections
client.commands = new Collection();
client.contextMenus = new Collection(); // Separate collection for context menus

// Load commands
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

console.log(`Found ${commandFiles.length} command files:`, commandFiles);

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    try {
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
            
            // Store context menu commands separately
            if ('contextMenu' in command) {
                if (Array.isArray(command.contextMenu)) {
                    command.contextMenu.forEach(ctx => {
                        client.contextMenus.set(ctx.name, command);
                    });
                } else {
                    client.contextMenus.set(command.contextMenu.name, command);
                }
            }
        } else {
            console.warn(`Command at ${file} is missing required "data" or "execute" property`);
        }
    } catch (error) {
        console.error(`Error loading command from ${file}:`, error);
    }
}

// Create REST client for refreshing commands
const rest = new REST({ version: '10' }).setToken(config.bot.token);

// Event handlers
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await connect();

    try {
        console.log('Starting command registration...');
        
        // Get slash commands
        const slashCommands = Array.from(client.commands.values())
            .filter(cmd => cmd.data)
            .map(command => {
                try {
                    return command.data.toJSON();
                } catch (e) {
                    console.error(`Error converting command to JSON:`, e);
                    return null;
                }
            })
            .filter(cmd => cmd !== null);
        console.log('Slash commands to register:', slashCommands.map(cmd => cmd.name));
        
        // Get context menu commands
        const contextCommands = Array.from(client.commands.values())
            .filter(cmd => cmd.contextMenu)
            .flatMap(command => {
                try {
                    return Array.isArray(command.contextMenu) 
                        ? command.contextMenu.map(ctx => ctx.toJSON())
                        : [command.contextMenu.toJSON()];
                } catch (e) {
                    console.error(`Error converting context menu to JSON:`, e);
                    return [];
                }
            })
            .filter(cmd => cmd !== null);
        console.log('Context commands to register:', contextCommands.map(cmd => cmd.name));

        // Combine all commands
        const commands = [...slashCommands, ...contextCommands];
        console.log(`Total commands to register: ${commands.length}`);

        if (commands.length === 0) {
            console.error('No commands to register! Check command loading.');
            return;
        }

        // Register commands both globally and to the guild
        console.log('Registering commands globally and to guild...');
        
        // Register globally
        await rest.put(
            Routes.applicationCommands(config.bot.clientId),
            { body: commands }
        );
        console.log('Global registration complete');

        // Also register to guild for immediate availability
        await rest.put(
            Routes.applicationGuildCommands(config.bot.clientId, config.bot.guildId),
            { body: commands }
        );
        console.log('Guild registration complete');

        console.log('All command registrations successful!');

    } catch (error) {
        console.error('Error registering commands:', error);
        if (error.rawError) {
            console.error('Discord API Error:', error.rawError);
        }
        if (error.code === 50001) {
            console.error('Missing Access! Check bot permissions and scopes!');
        }
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'ban_reason') {
            const banCommand = client.commands.get('ban');
            if (banCommand && banCommand.handleBan && interaction.message?.embeds[0]?.description) {
                const match = interaction.message.embeds[0].description.match(/<@!?(\d+)>/);
                if (match && match[1]) {
                    const targetUser = match[1];
                    await banCommand.handleBan(interaction, { id: targetUser }, interaction.values[0]);
                }
            }
            return;
        }
        if (interaction.customId === 'mute_reason') {
            const muteCommand = client.commands.get('mute');
            if (muteCommand && muteCommand.handleMute && interaction.message?.embeds[0]?.description) {
                const match = interaction.message.embeds[0].description.match(/\((\d+)\)/);
                if (match && match[1]) {
                    const targetUser = await client.users.fetch(match[1]);
                    const durationField = interaction.message.embeds[0].fields.find(f => f.name === 'Duration');
                    const duration = parseInt(durationField.value);
                    await muteCommand.handleMute(interaction, targetUser, interaction.values[0], duration);
                }
            }
            return;
        }
        if (interaction.customId === 'warn_reason') {
            const warnCommand = client.commands.get('warn');
            if (warnCommand && warnCommand.handleWarning && interaction.message?.embeds[0]?.description) {
                const match = interaction.message.embeds[0].description.match(/<@!?(\d+)>/);
                if (match && match[1]) {
                    const targetUser = match[1];
                    const selectedReason = config.warnings.reasons.find(r => r.title === interaction.values[0]);
                    if (selectedReason.title === 'Other') {
                        // Store target user data for modal handler
                        interaction.client.tempWarnData = {
                            targetUser: { 
                                id: targetUser,
                                tag: interaction.message.embeds[0].description.split(' ')[3]
                            }
                        };

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

                        await interaction.showModal(modal);
                    } else {
                        // Handle predefined reason
                        const userTag = interaction.message.embeds[0].description.split(' ')[3];
                        await warnCommand.handleWarning(interaction, { id: targetUser, tag: userTag }, selectedReason);
                    }
                }
            }
            return;
        }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'warn_custom_reason') {
            const warnCommand = client.commands.get('warn');
            if (warnCommand && warnCommand.handleWarning) {
                const { targetUser } = interaction.client.tempWarnData;
                const customReason = {
                    title: interaction.fields.getTextInputValue('reason'),
                    description: 'Custom reason',
                    emoji: '❓'
                };
                
                // Clean up temporary data
                delete interaction.client.tempWarnData;
                
                await warnCommand.handleWarning(interaction, targetUser, customReason);
            }
        } else if (interaction.customId === 'mute_custom_reason') {
            const muteCommand = client.commands.get('mute');
            if (muteCommand && muteCommand.handleModalSubmit) {
                await muteCommand.handleModalSubmit(interaction);
            }
        }
    }

    // Handle context menu commands
    if (interaction.isMessageContextMenuCommand() || interaction.isUserContextMenuCommand()) {
        console.log(`Received context menu interaction: ${interaction.commandName}`);
        const command = client.contextMenus.get(interaction.commandName);
        
        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            return;
        }

        try {
            console.log('Executing context menu command...');
            await command.execute(interaction, client);
            console.log('Context menu command executed successfully');
        } catch (error) {
            console.error('Error executing context menu command:', error);
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
        return;
    }

    // Handle commands
    if (interaction.isCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        try {
            await command.execute(interaction, client);
        } catch (error) {
            console.error('Error executing command:', error);
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
        return;
    }
});

// Handle new members
client.on('guildMemberAdd', async member => {
    await handleHoistedName(member);
});

// Handle nickname changes
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (oldMember.displayName !== newMember.displayName) {
        await handleHoistedName(newMember);
    }
});

// Handle messages
client.on('messageCreate', async message => {
    // Ignore bot messages
    if (message.author.bot) return;
    
    // Handle blocked links
    await handleBlockedLink(message);
});

// Handle process termination
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await close();
    process.exit(0);
});

// Login to Discord
client.login(config.bot.token); 