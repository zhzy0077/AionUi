# QQ Bot Plugin

QQ Bot channel plugin for AionUi personal assistant.

## Features

- **C2C Private Chat** (`C2C_MESSAGE_CREATE`): One-on-one conversations with users
- **Group @ Mentions** (`GROUP_AT_MESSAGE_CREATE`): Respond when mentioned in groups
- **Guild Channel Messages** (`GUILD_MESSAGE_CREATE`, `DIRECT_MESSAGE_CREATE`): Support for QQ Guilds/Channels
- **Text and Markdown Messages**: Full support for formatted messages
- **Media Support**: Receive images, videos, audio, and files
- **Pairing-based Authorization**: Secure user whitelist management
- **WebSocket Reconnection**: Automatic reconnection with exponential backoff

## Configuration

### Required Credentials

- **App ID**: Your QQ Bot App ID (from QQ Open Platform)
- **App Secret**: Your QQ Bot App Secret

### Optional Settings

- **Sandbox Mode**: Enable to use the sandbox environment for testing

## Setup

1. Go to [QQ Open Platform](https://q.qq.com) and create a bot
2. Copy the App ID and App Secret
3. In AionUi Settings → Channels → QQ Bot, enter the credentials
4. Enable the plugin

## Architecture

### Message Flow

```
User (QQ) → QQ Bot Gateway → WebSocket → QQBotPlugin → Adapter → Unified Format → ActionExecutor → AI
```

### WebSocket Opcodes

- `0` DISPATCH — Event dispatch
- `1` HEARTBEAT — Heartbeat
- `2` IDENTIFY — Authentication
- `6` RESUME — Resume session
- `7` RECONNECT — Reconnect request
- `9` INVALID_SESSION — Invalid session
- `10` HELLO — Connection established
- `11` HEARTBEAT_ACK — Heartbeat acknowledged

### Message Types

| Type         | Value | Description                   |
| ------------ | ----- | ----------------------------- |
| TEXT         | 0     | Plain text message            |
| MARKDOWN     | 2     | Markdown formatted message    |
| ARK          | 3     | ARK template message          |
| EMBED        | 4     | Embed message                 |
| INPUT_NOTIFY | 6     | Typing indicator              |
| MEDIA        | 7     | Rich media (image/video/file) |

### Chat ID Format

- **C2C**: `c2c:{openid}` — Private chat
- **Group**: `group:{group_openid}` — Group chat
- **Guild**: `guild:{guild_id}:{channel_id}` — Guild channel

## API Reference

- [QQ Bot API v2 Documentation](https://bot.q.qq.com/wiki/)
- Uses WebSocket Gateway for real-time message delivery

## Limitations

- **No Message Editing**: QQ Bot API does not support editing sent messages. Streaming responses send new messages instead of editing existing ones.
- **Voice Messages**: Voice message transcription (STT) and generation (TTS) are not implemented in MVP
- **Image Sending**: Image upload and generation are not implemented in MVP
- **File Sending**: File upload capability is not implemented in MVP

## Future Enhancements

### Phase 2

- Voice message support (requires `silk-wasm` dependency for SILK codec)
- Image upload/send (via URL or base64)
- Text-to-speech with SILK encoding
- Reference index tracking (`ref_idx`) for message threading
- Upload caching (file hash-based to avoid re-upload)

### Phase 3

- Image understanding (via Gemini vision)
- Video upload support
- Interactive buttons via Markdown
- Multi-account support (account ID-based routing)

## Development Notes

### Token Refresh

Access tokens are automatically refreshed 60 seconds before expiration. The token is obtained via:

```
POST https://bots.qq.com/app/getAppAccessToken
{
  "appId": "your-app-id",
  "clientSecret": "your-app-secret"
}
```

### Reconnection Strategy

The plugin uses exponential backoff with jitter for reconnection:

- Base delay: 1 second
- Maximum attempts: 10
- Formula: `delay = base * 2^(attempt-1) * (0.5 + random())`

### Event Deduplication

Events are deduplicated using a Map with 5-minute TTL to prevent duplicate processing during reconnections.
