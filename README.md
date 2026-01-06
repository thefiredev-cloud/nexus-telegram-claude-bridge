# NEXUS - Remote AI Command Center

Control your Windows computer remotely through Telegram using Claude AI.

## Features

- **Telegram Bridge** - Send messages from your iPhone/phone to control your PC
- **Claude AI** - Intelligent command processing and task execution
- **Admin Dashboard** - Web interface at http://localhost:3000
- **MCP Integration** - 20+ MCP servers for memory, filesystem, browser automation
- **Knowledge Graph** - Persistent memory across sessions

## Quick Start

```bash
# Start NEXUS
START-BRIDGE.bat

# Or via PowerShell
powershell -ExecutionPolicy Bypass -File start-all.ps1
```

## Architecture

```
iPhone/Telegram -> Bot API -> bridge.js -> Claude AI -> Your Computer
                                |
                           admin-server.js -> Dashboard (localhost:3000)
```

## MCP Servers (Installed)

| Category | MCPs |
|----------|------|
| Memory | memory, memory-sqlite, memory-libsql, knowledge-graph, memento |
| Browser | playwright, puppeteer, chrome-devtools |
| Database | sqlite, mcp-sqlite, postgres |
| Files | filesystem |
| Tools | n8n, netlify, notion, github, bullmq |

## Skills & Agents

- `/nexus` - Manage NEXUS from Claude Code
- `nexus-bot` - Specialized monitoring agent

## Files

| File | Purpose |
|------|---------|
| bridge.js | Main Telegram-Claude bridge |
| admin-server.js | Dashboard server |
| health.json | Live metrics |
| messages.json | Message history |
| bridge.log | Activity logs |

## Configuration

1. Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

2. Edit `.env` with your values:
```
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_ALLOWED_CHAT_IDS=your_chat_id_here
WORKING_DIR=C:\path\to\working\directory
```

### Getting Your Credentials

- **TELEGRAM_BOT_TOKEN**: Create a bot via [@BotFather](https://t.me/botfather) on Telegram
- **TELEGRAM_ALLOWED_CHAT_IDS**: Get your chat ID from [@userinfobot](https://t.me/userinfobot)
- **WORKING_DIR**: The default directory Claude will work in

### Optional Settings

```
POLLING_INTERVAL=1000
ALLOWED_DIRECTORIES=C:\path1;C:\path2
ADMIN_PORT=3000
```

## License

MIT
