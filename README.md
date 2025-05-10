# MCB Moderation Bot

A Discord moderation bot for the MinecraftBuddies community. This bot handles warnings, mutes, bans, anti-hoisting, and anti-link protection.

## Features

- Warning System with configurable expiration
- Mute Management
- Ban Management
- Anti-Hoisting Protection
- Anti-Link Protection
- Configurable Moderation Actions
- Detailed Logging System

## Setup

1. Clone the repository:
```bash
git clone https://github.com/r-MinecraftBuddies/McbModeration.git
cd McbModeration
```

2. Copy the example config:
```bash
cp config.yml.example config.yml
```

3. Edit `config.yml` with your:
   - MongoDB URI
   - Bot Token
   - Client ID
   - Guild ID
   - Channel IDs
   - Role IDs

## Configuration

The bot is highly configurable through the `config.yml` file. You can customize:

- Warning thresholds and expiration
- Mute durations and roles
- Ban settings
- Anti-hoisting settings
- Anti-link protection
- Moderation reason presets
- Log channels

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.