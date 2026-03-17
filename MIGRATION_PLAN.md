# AionUi Web Migration Plan

## Converting Electron Desktop App to Pure Web Application

**Version**: 1.0  
**Date**: 2025-03-17  
**Objective**: Full migration while preserving 100% functionality

---

## Executive Summary

This document outlines the complete migration strategy for converting AionUi from an Electron desktop application to a pure web application. The migration aims to:

1. **Reuse 95%+ of existing code** - Maintain all business logic, AI agents, database layer
2. **Preserve all functionality** - Zero feature loss, all capabilities retained
3. **Leverage existing WebUI infrastructure** - The WebUI server already provides 60% of what's needed
4. **Modern web architecture** - REST API + WebSocket for real-time features

**Key Insight**: AionUi already has a sophisticated WebUI mode (`src/webserver/`) that runs the app in a browser. This migration essentially enhances and extends that existing infrastructure.

---

## Current vs Target Architecture

### Current Architecture (Electron)

```
┌─────────────────────────────────────────────────────────────────┐
│                         MAIN PROCESS                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   SQLite    │  │   Express   │  │   Worker Processes      │  │
│  │  Database   │  │  WebUI Srv  │  │  (Gemini, ACP, Codex)   │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │System Tray  │  │Native Dialog│  │  Auto-Updater           │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└───────────────────────────┬─────────────────────────────────────┘
                            │ IPC (via preload.ts)
┌───────────────────────────┴─────────────────────────────────────┐
│                      RENDERER PROCESS                            │
│                   React 19 + TypeScript                          │
│              (Arco Design, UnoCSS, i18n)                         │
│                                                                  │
│   ipcBridge.* calls → window.electronAPI → IPC → Main Process   │
└─────────────────────────────────────────────────────────────────┘
```

### Target Architecture (Pure Web)

```
┌─────────────────────────────────────────────────────────────────┐
│                     BACKEND SERVER (Node.js)                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   SQLite    │  │   Express   │  │   Worker Processes      │  │
│  │  Database   │  │  REST API   │  │  (Gemini, ACP, Codex)   │  │
│  └─────────────┘  └──────┬──────┘  └─────────────────────────┘  │
│  ┌─────────────┐         │         ┌─────────────────────────┐  │
│  │WebSocket Srv│◄────────┴────────►│  JWT Authentication     │  │
│  └─────────────┘                   └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTPS / WSS
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     FRONTEND (Browser)                           │
│                   React 19 + TypeScript                          │
│              (Arco Design, UnoCSS, i18n)                         │
│                                                                  │
│   apiClient.* calls → HTTP/WebSocket → Backend Server           │
│   File uploads → multipart/form-data                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Foundation & Project Structure

### 1.1 New Project Structure

```
aionui-web/                          # New web-only project
├── apps/
│   ├── server/                      # Backend server (from webserver/)
│   │   ├── src/
│   │   │   ├── index.ts             # Entry point
│   │   │   ├── routes/              # REST API routes
│   │   │   ├── websocket/           # WebSocket handlers
│   │   │   ├── services/            # Business logic (from process/)
│   │   │   ├── database/            # SQLite layer (unchanged)
│   │   │   ├── worker/              # Worker management
│   │   │   ├── auth/                # JWT authentication
│   │   │   └── middleware/          # Express middleware
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web/                         # Frontend (from renderer/)
│       ├── src/
│       │   ├── components/          # React components (unchanged)
│       │   ├── pages/               # Page components (unchanged)
│       │   ├── hooks/               # React hooks (unchanged)
│       │   ├── contexts/            # React contexts (unchanged)
│       │   ├── services/            # API client (NEW)
│       │   ├── utils/               # Utilities (most unchanged)
│       │   ├── i18n/                # Translations (unchanged)
│       │   └── styles/              # Styles (unchanged)
│       ├── index.html               # Entry HTML
│       ├── vite.config.ts           # Vite config
│       └── package.json
│
├── packages/
│   ├── shared/                      # Shared types & utilities
│   │   ├── src/
│   │   │   ├── types/               # TypeScript interfaces
│   │   │   └── constants/           # Shared constants
│   │   └── package.json
│   │
│   └── api-client/                  # Generated API client
│       ├── src/
│       │   └── index.ts             # Auto-generated from OpenAPI
│       └── package.json
│
├── docker/
│   ├── Dockerfile.server
│   ├── Dockerfile.web
│   └── docker-compose.yml
│
└── package.json                     # Root workspace config
```

### 1.2 Technology Stack

| Component         | Current (Electron)     | Target (Web)      | Notes                               |
| ----------------- | ---------------------- | ----------------- | ----------------------------------- |
| **Build Tool**    | electron-vite          | Vite              | Same config, remove Electron plugin |
| **Frontend**      | React 19               | React 19          | No change                           |
| **Backend**       | Electron main          | Express + Node.js | WebUI already exists                |
| **Database**      | better-sqlite3         | better-sqlite3    | Works in Node.js server             |
| **Workers**       | fork from main         | fork from server  | Same implementation                 |
| **Communication** | IPC                    | HTTP + WebSocket  | Replace ipcBridge                   |
| **Auth**          | Electron secureStorage | JWT + bcrypt      | WebUI already implemented           |
| **File System**   | Node.js fs             | Node.js fs        | Same in server                      |
| **Styling**       | UnoCSS                 | UnoCSS            | No change                           |
| **UI Library**    | Arco Design            | Arco Design       | No change                           |

### 1.3 Dependencies Changes

**Remove (Electron-specific):**

```json
{
  "electron": "^37.3.1",
  "electron-builder": "^26.6.0",
  "electron-vite": "^5.0.0",
  "electron-log": "^5.4.3",
  "electron-squirrel-startup": "^1.0.1",
  "electron-updater": "^6.6.2",
  "@electron/fuses": "^1.8.0",
  "@electron/notarize": "^3.1.0"
}
```

**Add (Web-specific):**

```json
{
  "express": "^5.1.0",
  "cors": "^2.8.5",
  "helmet": "^7.1.0",
  "compression": "^1.7.4",
  "multer": "^2.0.0",
  "ws": "^8.18.3",
  "swagger-ui-express": "^5.0.0",
  "openapi-types": "^12.1.3"
}
```

---

## Phase 2: API Design (REST + WebSocket Mapping)

### 2.1 IPC Channel to REST API Mapping

Based on analysis of `src/common/ipcBridge.ts` (991 lines, 100+ channels):

#### Category A: File Operations (35 channels)

| IPC Channel                 | HTTP Method | Route                                  | Description             |
| --------------------------- | ----------- | -------------------------------------- | ----------------------- |
| `fs.getFilesByDir`          | GET         | `/api/files/list?dir={dir}`            | List directory contents |
| `fs.readFile`               | GET         | `/api/files/read?path={path}`          | Read file (UTF-8)       |
| `fs.readFileBuffer`         | GET         | `/api/files/read-buffer?path={path}`   | Read file (binary)      |
| `fs.writeFile`              | POST        | `/api/files/write`                     | Write file              |
| `fs.createTempFile`         | POST        | `/api/files/temp`                      | Create temp file        |
| `fs.copyFilesToWorkspace`   | POST        | `/api/files/copy-to-workspace`         | Copy files              |
| `fs.removeEntry`            | DELETE      | `/api/files/delete`                    | Delete file/folder      |
| `fs.renameEntry`            | PUT         | `/api/files/rename`                    | Rename file/folder      |
| `fs.getFileMetadata`        | GET         | `/api/files/metadata?path={path}`      | Get file info           |
| `fs.createZip`              | POST        | `/api/files/zip`                       | Create ZIP archive      |
| `fs.getImageBase64`         | GET         | `/api/files/image-base64?path={path}`  | Get image as base64     |
| `fs.readBuiltinRule`        | GET         | `/api/files/builtin-rule?name={name}`  | Read builtin rule       |
| `fs.readBuiltinSkill`       | GET         | `/api/files/builtin-skill?name={name}` | Read builtin skill      |
| `fs.readAssistantRule`      | GET         | `/api/files/assistant-rule?id={id}`    | Read assistant rule     |
| `fs.writeAssistantRule`     | POST        | `/api/files/assistant-rule`            | Write assistant rule    |
| `fs.readAssistantSkill`     | GET         | `/api/files/assistant-skill?id={id}`   | Read assistant skill    |
| `fs.writeAssistantSkill`    | POST        | `/api/files/assistant-skill`           | Write assistant skill   |
| `fs.listAvailableSkills`    | GET         | `/api/skills/available`                | List skills             |
| `fs.importSkill`            | POST        | `/api/skills/import`                   | Import skill            |
| `fs.scanForSkills`          | POST        | `/api/skills/scan`                     | Scan for skills         |
| `fs.importSkillWithSymlink` | POST        | `/api/skills/import-symlink`           | Import via symlink      |
| `fs.deleteSkill`            | DELETE      | `/api/skills/{name}`                   | Delete skill            |

#### Category B: Conversations (20 channels)

| IPC Channel                             | HTTP Method | Route                                    | Description         |
| --------------------------------------- | ----------- | ---------------------------------------- | ------------------- |
| `conversation.create`                   | POST        | `/api/conversations`                     | Create conversation |
| `conversation.get`                      | GET         | `/api/conversations/{id}`                | Get conversation    |
| `conversation.getAssociateConversation` | GET         | `/api/conversations/{id}/associated`     | Get associated      |
| `conversation.remove`                   | DELETE      | `/api/conversations/{id}`                | Delete conversation |
| `conversation.update`                   | PUT         | `/api/conversations/{id}`                | Update conversation |
| `conversation.reset`                    | POST        | `/api/conversations/{id}/reset`          | Reset conversation  |
| `conversation.stop`                     | POST        | `/api/conversations/{id}/stop`           | Stop generation     |
| `conversation.sendMessage`              | POST        | `/api/conversations/{id}/messages`       | Send message        |
| `conversation.getWorkspace`             | GET         | `/api/conversations/{id}/workspace`      | Get workspace files |
| `conversation.reloadContext`            | POST        | `/api/conversations/{id}/reload-context` | Reload context      |
| `conversation.confirmMessage`           | POST        | `/api/conversations/{id}/confirm`        | Confirm message     |
| `conversation.approval.check`           | GET         | `/api/conversations/{id}/approval`       | Check approval      |

**WebSocket Events (streaming):**

- `chat.response.stream` → `ws://events/chat-response`
- `confirmation.add/update/remove` → `ws://events/confirmation`

#### Category C: Database Operations (3 channels)

| IPC Channel                           | HTTP Method | Route                              | Description        |
| ------------------------------------- | ----------- | ---------------------------------- | ------------------ |
| `database.getConversationMessages`    | GET         | `/api/conversations/{id}/messages` | Get messages       |
| `database.getUserConversations`       | GET         | `/api/conversations`               | List conversations |
| `database.searchConversationMessages` | GET         | `/api/messages/search?q={query}`   | Search messages    |

#### Category D: Application/System (15 channels)

| IPC Channel                    | HTTP Method | Route                          | Description     |
| ------------------------------ | ----------- | ------------------------------ | --------------- |
| `application.systemInfo`       | GET         | `/api/system/info`             | System info     |
| `application.getPath`          | GET         | `/api/system/path?name={name}` | Get system path |
| `application.updateSystemInfo` | PUT         | `/api/system/info`             | Update paths    |
| `application.getZoomFactor`    | GET         | `/api/settings/zoom`           | Get zoom        |
| `application.setZoomFactor`    | PUT         | `/api/settings/zoom`           | Set zoom        |
| `application.getCdpStatus`     | GET         | `/api/system/cdp`              | CDP status      |
| `application.updateCdpConfig`  | PUT         | `/api/system/cdp`              | Update CDP      |

**Removed (Electron-specific):**

- `application.restart` → Not applicable in web
- `application.openDevTools` → Browser DevTools
- `application.isDevToolsOpened` → Not applicable

#### Category E: ACP Agents (12 channels)

| IPC Channel                          | HTTP Method | Route                                         | Description       |
| ------------------------------------ | ----------- | --------------------------------------------- | ----------------- |
| `acpConversation.getAvailableAgents` | GET         | `/api/agents/available`                       | List agents       |
| `acpConversation.detectCliPath`      | GET         | `/api/agents/detect-cli?backend={b}`          | Detect CLI        |
| `acpConversation.checkEnv`           | GET         | `/api/agents/check-env`                       | Check environment |
| `acpConversation.checkAgentHealth`   | GET         | `/api/agents/{id}/health`                     | Health check      |
| `acpConversation.setMode`            | PUT         | `/api/conversations/{id}/mode`                | Set mode          |
| `acpConversation.getMode`            | GET         | `/api/conversations/{id}/mode`                | Get mode          |
| `acpConversation.getModelInfo`       | GET         | `/api/conversations/{id}/model-info`          | Get model info    |
| `acpConversation.probeModelInfo`     | POST        | `/api/agents/probe-model`                     | Probe model       |
| `acpConversation.setModel`           | PUT         | `/api/conversations/{id}/model`               | Set model         |
| `acpConversation.getConfigOptions`   | GET         | `/api/conversations/{id}/config-options`      | Get config        |
| `acpConversation.setConfigOption`    | PUT         | `/api/conversations/{id}/config-options/{id}` | Set config        |

#### Category F: Extensions (16 channels)

| IPC Channel                      | HTTP Method | Route                                | Description       |
| -------------------------------- | ----------- | ------------------------------------ | ----------------- |
| `extensions.getThemes`           | GET         | `/api/extensions/themes`             | Get themes        |
| `extensions.getLoadedExtensions` | GET         | `/api/extensions`                    | List extensions   |
| `extensions.getAssistants`       | GET         | `/api/extensions/assistants`         | Get assistants    |
| `extensions.getAgents`           | GET         | `/api/extensions/agents`             | Get agents        |
| `extensions.getAcpAdapters`      | GET         | `/api/extensions/acp-adapters`       | Get adapters      |
| `extensions.getMcpServers`       | GET         | `/api/extensions/mcp-servers`        | Get MCP servers   |
| `extensions.getSkills`           | GET         | `/api/extensions/skills`             | Get skills        |
| `extensions.getSettingsTabs`     | GET         | `/api/extensions/settings-tabs`      | Get settings tabs |
| `extensions.enable`              | POST        | `/api/extensions/{name}/enable`      | Enable extension  |
| `extensions.disable`             | POST        | `/api/extensions/{name}/disable`     | Disable extension |
| `extensions.getPermissions`      | GET         | `/api/extensions/{name}/permissions` | Get permissions   |

**WebSocket Events:**

- `extensions.stateChanged` → `ws://events/extension-state`

#### Category G: Cron Jobs (7 channels)

| IPC Channel                   | HTTP Method | Route                               | Description          |
| ----------------------------- | ----------- | ----------------------------------- | -------------------- |
| `cron.listJobs`               | GET         | `/api/cron/jobs`                    | List jobs            |
| `cron.listJobsByConversation` | GET         | `/api/conversations/{id}/cron-jobs` | List by conversation |
| `cron.getJob`                 | GET         | `/api/cron/jobs/{id}`               | Get job              |
| `cron.addJob`                 | POST        | `/api/cron/jobs`                    | Create job           |
| `cron.updateJob`              | PUT         | `/api/cron/jobs/{id}`               | Update job           |
| `cron.removeJob`              | DELETE      | `/api/cron/jobs/{id}`               | Remove job           |

**WebSocket Events:**

- `cron.job-created/updated/removed/executed` → `ws://events/cron`

#### Category H: MCP Service (8 channels)

| IPC Channel                          | HTTP Method | Route                      | Description        |
| ------------------------------------ | ----------- | -------------------------- | ------------------ |
| `mcpService.getAgentMcpConfigs`      | GET         | `/api/mcp/configs`         | Get configs        |
| `mcpService.testMcpConnection`       | POST        | `/api/mcp/test-connection` | Test connection    |
| `mcpService.syncMcpToAgents`         | POST        | `/api/mcp/sync`            | Sync to agents     |
| `mcpService.removeMcpFromAgents`     | POST        | `/api/mcp/remove`          | Remove from agents |
| `mcpService.checkOAuthStatus`        | GET         | `/api/mcp/oauth/status`    | Check OAuth        |
| `mcpService.loginMcpOAuth`           | POST        | `/api/mcp/oauth/login`     | OAuth login        |
| `mcpService.logoutMcpOAuth`          | POST        | `/api/mcp/oauth/logout`    | OAuth logout       |
| `mcpService.getAuthenticatedServers` | GET         | `/api/mcp/oauth/servers`   | Get auth servers   |

### 2.2 WebSocket Event Structure

All real-time events maintain the same JSON structure:

```typescript
interface WebSocketMessage {
  type: string;           // Event type (same as IPC channel name)
  payload: unknown;       // Event data
  timestamp: number;      // Unix timestamp
  conversationId?: string; // Optional: for conversation-scoped events
}

// Example: Chat response streaming
{
  "type": "chat.response.stream",
  "payload": {
    "type": "text_chunk",
    "data": "Hello, how can I help you today?",
    "msg_id": "msg_abc123",
    "conversation_id": "conv_xyz789"
  },
  "timestamp": 1710758400000,
  "conversationId": "conv_xyz789"
}

// Example: File change notification
{
  "type": "file-stream-content-update",
  "payload": {
    "filePath": "/workspace/project/file.ts",
    "content": "// updated content...",
    "relativePath": "file.ts",
    "operation": "write"
  },
  "timestamp": 1710758400000
}
```

### 2.3 Authentication Flow

Reuse existing WebUI authentication (`src/webserver/auth/`):

```
POST /api/auth/login
  Body: { username: string, password: string }
  Response: { token: string, user: User }

POST /api/auth/logout
  Headers: Authorization: Bearer {token}
  Response: { success: boolean }

POST /api/auth/refresh
  Headers: Authorization: Bearer {token}
  Response: { token: string }

GET /api/auth/status
  Response: { authenticated: boolean, user?: User }

POST /api/auth/change-password
  Headers: Authorization: Bearer {token}
  Body: { newPassword: string }
  Response: { success: boolean }
```

JWT Configuration (existing):

- Algorithm: HS256
- Expiry: 24 hours
- Secret: Stored in database (per-user)
- Storage: httpOnly cookie + Authorization header

---

## Phase 3: Backend Server Adaptation

### 3.1 Code Migration Strategy

**Files to Copy (Unchanged):**

```
src/process/database/*           → apps/server/src/database/
src/process/services/*           → apps/server/src/services/
src/process/task/*               → apps/server/src/task/
src/process/WorkerManage.ts      → apps/server/src/WorkerManage.ts
src/agent/*                      → apps/server/src/agent/
src/worker/*                     → apps/server/src/worker/
src/common/*                     → packages/shared/src/
src/types/*                      → packages/shared/src/types/
```

**Files to Adapt (Remove Electron):**

```
src/webserver/*                  → apps/server/src/ (enhance)
src/process/bridge/*.ts          → apps/server/src/routes/*.ts
src/index.ts                     → apps/server/src/index.ts (remove Electron)
```

**Files to Remove (Electron-specific):**

```
src/preload.ts                   → Remove (not needed in web)
src/utils/appMenu.ts             → Remove (native menus)
src/utils/configureChromium.ts   → Remove (Chromium flags)
src/process/bridge/windowControlsBridge.ts → Remove
src/process/bridge/notificationBridge.ts   → Remove
src/process/bridge/updateBridge.ts         → Remove
```

### 3.2 Bridge-to-Route Conversion Pattern

Convert IPC bridge handlers to Express route handlers:

**Before (IPC Bridge):**

```typescript
// src/process/bridge/conversationBridge.ts
ipcBridge.conversation.get.provider(async ({ id }) => {
  const db = getDatabase();
  return db.getConversation(id);
});
```

**After (Express Route):**

```typescript
// apps/server/src/routes/conversations.ts
import { Router } from 'express';
import { getDatabase } from '../database';
import { authenticate } from '../auth/middleware';

const router = Router();

router.get('/:id', authenticate, async (req, res) => {
  const { id } = req.params;
  const db = getDatabase();
  const result = db.getConversation(id);

  if (result.success) {
    res.json(result.data);
  } else {
    res.status(404).json({ error: result.error || 'Conversation not found' });
  }
});

export default router;
```

### 3.3 File Upload Handling

Replace dialog-based file selection with multipart uploads:

```typescript
// apps/server/src/routes/files.ts
import multer from 'multer';
import { Router } from 'express';

const upload = multer({ dest: 'uploads/' });

// Upload files to workspace
router.post('/upload', authenticate, upload.array('files'), async (req, res) => {
  const files = req.files as Express.Multer.File[];
  const { workspace } = req.body;

  for (const file of files) {
    const targetPath = path.join(workspace, file.originalname);
    await fs.rename(file.path, targetPath);
  }

  res.json({ success: true, uploaded: files.length });
});

// Upload directory (zip + extract)
router.post('/upload-directory', authenticate, upload.single('zip'), async (req, res) => {
  const { workspace } = req.body;
  // Extract zip to workspace
  // ...
});
```

### 3.4 WebSocket Integration

Enhance existing WebSocketManager to handle all real-time events:

```typescript
// apps/server/src/websocket/WebSocketManager.ts
import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';

class WebSocketManager extends EventEmitter {
  private wss: WebSocketServer;
  private clients: Map<string, WebSocket> = new Map();

  constructor(server: HttpServer) {
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws, req) => {
      const clientId = this.authenticateConnection(req);
      this.clients.set(clientId, ws);

      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        this.emit('message', { clientId, message });
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
      });
    });
  }

  // Broadcast to all clients or specific conversation subscribers
  broadcast(event: string, payload: unknown, filter?: { conversationId?: string }) {
    const message = JSON.stringify({ type: event, payload, timestamp: Date.now() });

    for (const [clientId, ws] of this.clients) {
      if (filter?.conversationId) {
        // Check if client is subscribed to this conversation
        const subscriptions = this.getSubscriptions(clientId);
        if (!subscriptions.includes(filter.conversationId)) continue;
      }

      ws.send(message);
    }
  }

  // Send to specific client
  sendTo(clientId: string, event: string, payload: unknown) {
    const ws = this.clients.get(clientId);
    if (ws) {
      ws.send(JSON.stringify({ type: event, payload, timestamp: Date.now() }));
    }
  }
}
```

### 3.5 Streaming Response Implementation

Convert IPC emitters to WebSocket streams:

```typescript
// apps/server/src/routes/conversations.ts
// Send message with streaming response
router.post('/:id/messages', authenticate, async (req, res) => {
  const { id } = req.params;
  const { input, files } = req.body;
  const clientId = req.clientId; // From auth middleware

  // Get or create task
  const task = await WorkerManage.getTaskByIdRollbackBuild(id);

  // Set up stream handler
  task.on('response', (chunk) => {
    wsManager.sendTo(clientId, 'chat.response.stream', {
      type: chunk.type,
      data: chunk.data,
      msg_id: chunk.msg_id,
      conversation_id: id,
    });
  });

  // Send message
  await task.sendMessage(input, files);

  res.json({ success: true, msg_id: generateId() });
});
```

---

## Phase 4: Frontend API Client Implementation

### 4.1 Create API Client Module

Create a drop-in replacement for `ipcBridge`:

```typescript
// apps/web/src/services/apiClient.ts
import { getAuthToken } from './auth';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const WS_BASE_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3000';

class ApiClient {
  private ws: WebSocket | null = null;
  private messageHandlers: Map<string, Set<(data: any) => void>> = new Map();

  // HTTP Request wrapper
  private async request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAuthToken()}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  // WebSocket connection
  connect() {
    this.ws = new WebSocket(`${WS_BASE_URL}/events?token=${getAuthToken()}`);

    this.ws.onmessage = (event) => {
      const { type, payload } = JSON.parse(event.data);
      const handlers = this.messageHandlers.get(type);
      handlers?.forEach((handler) => handler(payload));
    };
  }

  // Subscribe to events (replaces ipcBridge.*.on())
  on(event: string, handler: (data: any) => void): () => void {
    if (!this.messageHandlers.has(event)) {
      this.messageHandlers.set(event, new Set());
    }
    this.messageHandlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.messageHandlers.get(event)?.delete(handler);
    };
  }

  // === File Operations ===
  fs = {
    getFilesByDir: (params: { dir: string; root: string }) =>
      this.request('GET', `/api/files/list?dir=${encodeURIComponent(params.dir)}`),

    readFile: (params: { path: string }) =>
      this.request('GET', `/api/files/read?path=${encodeURIComponent(params.path)}`),

    writeFile: (params: { path: string; data: string | Uint8Array }) =>
      this.request('POST', '/api/files/write', params),

    getImageBase64: (params: { path: string }) =>
      this.request('GET', `/api/files/image-base64?path=${encodeURIComponent(params.path)}`),

    copyFilesToWorkspace: (params: { filePaths: string[]; workspace: string }) =>
      this.request('POST', '/api/files/copy-to-workspace', params),

    removeEntry: (params: { path: string }) => this.request('DELETE', '/api/files/delete', params),

    renameEntry: (params: { path: string; newName: string }) => this.request('PUT', '/api/files/rename', params),

    // File upload (multipart)
    uploadFiles: async (files: FileList, workspace: string) => {
      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file);
      }
      formData.append('workspace', workspace);

      const response = await fetch(`${API_BASE_URL}/api/files/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAuthToken()}` },
        body: formData,
      });
      return response.json();
    },
  };

  // === Conversations ===
  conversation = {
    create: (params: ICreateConversationParams) => this.request('POST', '/api/conversations', params),

    get: (params: { id: string }) => this.request('GET', `/api/conversations/${params.id}`),

    remove: (params: { id: string }) => this.request('DELETE', `/api/conversations/${params.id}`),

    update: (params: { id: string; updates: Partial<TChatConversation> }) =>
      this.request('PUT', `/api/conversations/${params.id}`, params),

    sendMessage: (params: ISendMessageParams) =>
      this.request('POST', `/api/conversations/${params.conversation_id}/messages`, params),

    // Event subscriptions
    responseStream: {
      on: (handler: (data: IResponseMessage) => void) => this.on('chat.response.stream', handler),
    },

    confirmation: {
      add: {
        on: (handler: (data: any) => void) => this.on('confirmation.add', handler),
      },
      update: {
        on: (handler: (data: any) => void) => this.on('confirmation.update', handler),
      },
      remove: {
        on: (handler: (data: any) => void) => this.on('confirmation.remove', handler),
      },
      confirm: (params: { conversation_id: string; msg_id: string; data: any; callId: string }) =>
        this.request('POST', `/api/conversations/${params.conversation_id}/confirm`, params),
    },
  };

  // === Database ===
  database = {
    getConversationMessages: (params: { conversation_id: string; page?: number; pageSize?: number }) =>
      this.request('GET', `/api/conversations/${params.conversation_id}/messages?page=${params.page || 0}`),

    getUserConversations: (params?: { page?: number; pageSize?: number }) =>
      this.request('GET', `/api/conversations?page=${params?.page || 0}`),
  };

  // === ACP Conversation ===
  acpConversation = {
    getAvailableAgents: () => this.request('GET', '/api/agents/available'),

    checkAgentHealth: (params: { backend: AcpBackend }) =>
      this.request('GET', `/api/agents/health?backend=${params.backend}`),

    setMode: (params: { conversationId: string; mode: string }) =>
      this.request('PUT', `/api/conversations/${params.conversationId}/mode`, params),

    getModelInfo: (params: { conversationId: string }) =>
      this.request('GET', `/api/conversations/${params.conversationId}/model-info`),
  };

  // === Extensions ===
  extensions = {
    getLoadedExtensions: () => this.request('GET', '/api/extensions'),

    getThemes: () => this.request('GET', '/api/extensions/themes'),

    enable: (params: { name: string }) => this.request('POST', `/api/extensions/${params.name}/enable`),

    disable: (params: { name: string }) => this.request('POST', `/api/extensions/${params.name}/disable`),

    stateChanged: {
      on: (handler: (data: any) => void) => this.on('extensions.stateChanged', handler),
    },
  };

  // === Cron ===
  cron = {
    listJobs: () => this.request('GET', '/api/cron/jobs'),

    addJob: (params: ICreateCronJobParams) => this.request('POST', '/api/cron/jobs', params),

    removeJob: (params: { jobId: string }) => this.request('DELETE', `/api/cron/jobs/${params.jobId}`),

    onJobExecuted: {
      on: (handler: (data: any) => void) => this.on('cron.job-executed', handler),
    },
  };

  // === Application (filtered) ===
  application = {
    systemInfo: () => this.request('GET', '/api/system/info'),

    getPath: (params: { name: string }) => this.request('GET', `/api/system/path?name=${params.name}`),

    logStream: {
      on: (handler: (data: any) => void) => this.on('app.log-stream', handler),
    },
  };

  // === Dialog (replaced with file input) ===
  dialog = {
    // Opens native file picker, returns files via upload
    showOpen: async (options?: { properties?: string[] }) => {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;

        if (options?.properties?.includes('openDirectory')) {
          // Note: Directory selection requires webkitdirectory attribute
          input.setAttribute('webkitdirectory', '');
        }

        input.onchange = () => {
          resolve(Array.from(input.files || []));
        };

        input.click();
      });
    },
  };

  // === Shell (replaced with browser APIs) ===
  shell = {
    openExternal: (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },

    showItemInFolder: (path: string) => {
      // In web version, download the file instead
      console.warn('showItemInFolder not available in web version');
    },

    openFile: (path: string) => {
      // Download and open file
      this.fs.getImageBase64({ path }).then((base64: string) => {
        const link = document.createElement('a');
        link.href = base64;
        link.download = path.split('/').pop() || 'file';
        link.click();
      });
    },
  };
}

// Export singleton instance
export const apiClient = new ApiClient();
```

### 4.2 Drop-in Replacement Pattern

Replace `ipcBridge` imports throughout the codebase:

**Before:**

```typescript
import { ipcBridge } from '@common';

const handleSend = async () => {
  await ipcBridge.conversation.sendMessage.invoke({
    conversation_id: id,
    input: message,
  });
};

// Event listener
useEffect(() => {
  const unsubscribe = ipcBridge.conversation.responseStream.on((data) => {
    setResponse(data);
  });
  return unsubscribe;
}, []);
```

**After:**

```typescript
import { apiClient } from '@renderer/services/apiClient';

const handleSend = async () => {
  await apiClient.conversation.sendMessage({
    conversation_id: id,
    input: message,
  });
};

// Event listener
useEffect(() => {
  const unsubscribe = apiClient.conversation.responseStream.on((data) => {
    setResponse(data);
  });
  return unsubscribe;
}, []);
```

### 4.3 File Upload Component

Replace dialog-based file selection:

```typescript
// apps/web/src/components/FileUploadButton.tsx
import React, { useRef } from 'react';
import { apiClient } from '@renderer/services/apiClient';

interface FileUploadButtonProps {
  workspace: string;
  onUpload: (files: string[]) => void;
  multiple?: boolean;
  directory?: boolean;
}

export const FileUploadButton: React.FC<FileUploadButtonProps> = ({
  workspace,
  onUpload,
  multiple = true,
  directory = false,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const result = await apiClient.fs.uploadFiles(files, workspace);
    onUpload(result.copiedFiles);

    // Reset input
    event.target.value = '';
  };

  return (
    <>
      <button onClick={handleClick}>Upload Files</button>
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        {...(directory ? { webkitdirectory: '' } : {})}
        style={{ display: 'none' }}
        onChange={handleChange}
      />
    </>
  );
};
```

---

## Phase 5: File Handling Web Migration

### 5.1 File Selection Strategy

| Electron Feature                    | Web Equivalent            | Implementation                  |
| ----------------------------------- | ------------------------- | ------------------------------- |
| `dialog.showOpenDialog` (files)     | `<input type="file">`     | FileUploadButton component      |
| `dialog.showOpenDialog` (directory) | `<input webkitdirectory>` | DirectoryUploadButton component |
| Drag-drop with paths                | HTML5 Drag and Drop API   | useDragAndDrop hook             |
| `webUtils.getPathForFile`           | `DataTransfer.files`      | Native browser API              |

### 5.2 Workspace File Browser

The workspace file browser needs server-side API:

```typescript
// apps/server/src/routes/workspace.ts
router.get('/browse', authenticate, async (req, res) => {
  const { path: relativePath, workspace } = req.query;

  // Security: Ensure path is within workspace
  const fullPath = path.resolve(workspace as string, relativePath as string);
  if (!fullPath.startsWith(workspace as string)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  const files = entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    path: path.join(relativePath as string, entry.name),
  }));

  res.json(files);
});
```

### 5.3 Image Display

Keep base64 approach (already works in browser):

```typescript
// apps/web/src/components/ImageViewer.tsx
import { apiClient } from '@renderer/services/apiClient';

export const ImageViewer: React.FC<{ filePath: string }> = ({ filePath }) => {
  const [base64, setBase64] = useState<string | null>(null);

  useEffect(() => {
    apiClient.fs.getImageBase64({ path: filePath }).then(setBase64);
  }, [filePath]);

  if (!base64) return <div>Loading...</div>;

  return <img src={base64} alt={filePath} style={{ maxWidth: '100%' }} />;
};
```

### 5.4 File Watching

Replace Node.js fs.watch with server-side watching + WebSocket:

```typescript
// apps/server/src/services/FileWatcherService.ts
import chokidar from 'chokidar';

class FileWatcherService {
  private watchers: Map<string, chokidar.FSWatcher> = new Map();

  watch(workspace: string, onChange: (event: string, path: string) => void) {
    const watcher = chokidar.watch(workspace, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
    });

    watcher.on('change', (path) => onChange('change', path));
    watcher.on('add', (path) => onChange('add', path));
    watcher.on('unlink', (path) => onChange('delete', path));

    this.watchers.set(workspace, watcher);
    return () => {
      watcher.close();
      this.watchers.delete(workspace);
    };
  }
}
```

---

## Phase 6: Testing & Deployment

### 6.1 Testing Strategy

| Test Type             | Approach            | Coverage               |
| --------------------- | ------------------- | ---------------------- |
| **Unit Tests**        | Vitest (existing)   | 30% threshold          |
| **Integration Tests** | Supertest + Test DB | API endpoints          |
| **E2E Tests**         | Playwright          | Critical user flows    |
| **Load Tests**        | k6 or Artillery     | Concurrent connections |

### 6.2 Docker Deployment

```dockerfile
# Dockerfile.server
FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy built app
COPY apps/server/dist ./dist
COPY apps/server/src/worker ./worker

# Data volume
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

```yaml
# docker-compose.yml
version: '3.8'

services:
  aionui-web:
    build:
      context: .
      dockerfile: docker/Dockerfile.server
    ports:
      - '3000:3000'
    volumes:
      - aionui-data:/app/data
      - aionui-workspace:/app/workspace
    environment:
      - NODE_ENV=production
      - JWT_SECRET=${JWT_SECRET}
      - DATABASE_PATH=/app/data/aionui.db
    restart: unless-stopped

  # Optional: Nginx reverse proxy
  nginx:
    image: nginx:alpine
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - aionui-web

volumes:
  aionui-data:
  aionui-workspace:
```

### 6.3 Environment Configuration

```bash
# .env.production
NODE_ENV=production
PORT=3000
DATABASE_PATH=./data/aionui.db
WORKSPACE_PATH=./workspace
JWT_SECRET=your-secret-key-here
JWT_EXPIRY=24h

# CORS (for separate frontend hosting)
CORS_ORIGIN=https://aionui.example.com

# File upload limits
MAX_FILE_SIZE=100mb
MAX_FILES_PER_UPLOAD=50
```

### 6.4 Migration Checklist

- [ ] **Project Setup**
  - [ ] Create monorepo structure (server + web + shared)
  - [ ] Copy existing code to new structure
  - [ ] Set up build pipeline (Vite for web, tsc for server)

- [ ] **Backend Migration**
  - [ ] Copy database layer (unchanged)
  - [ ] Copy agent implementations (unchanged)
  - [ ] Copy worker management (unchanged)
  - [ ] Convert IPC bridges to Express routes
  - [ ] Implement WebSocket event streaming
  - [ ] Add file upload endpoints (multipart)
  - [ ] Remove Electron dependencies

- [ ] **Frontend Migration**
  - [ ] Copy all React components (unchanged)
  - [ ] Copy hooks and contexts (minor updates)
  - [ ] Replace ipcBridge imports with apiClient
  - [ ] Replace dialog-based file selection with uploads
  - [ ] Remove Electron-specific code (window controls, tray)
  - [ ] Update build config (Vite instead of electron-vite)

- [ ] **Integration**
  - [ ] Connect frontend API client to backend
  - [ ] Test WebSocket streaming
  - [ ] Test file uploads
  - [ ] Verify all IPC channels have HTTP equivalents

- [ ] **Testing**
  - [ ] Run existing unit tests
  - [ ] Add API integration tests
  - [ ] E2E test critical flows
  - [ ] Load test concurrent users

- [ ] **Deployment**
  - [ ] Create Docker images
  - [ ] Set up CI/CD pipeline
  - [ ] Configure reverse proxy (nginx)
  - [ ] SSL certificates
  - [ ] Data backup strategy

---

## Risk Assessment & Mitigation

| Risk                         | Impact | Mitigation                                                          |
| ---------------------------- | ------ | ------------------------------------------------------------------- |
| **File System Access**       | High   | Use File System Access API with graceful fallback to uploads        |
| **Performance**              | Medium | Implement caching, CDN for static assets, connection pooling        |
| **Security**                 | High   | Input validation, path sanitization, rate limiting, CSRF protection |
| **Browser Compatibility**    | Low    | Target modern browsers (Chrome, Firefox, Safari, Edge)              |
| **Offline Support**          | Medium | Service worker for caching, queue actions for reconnect             |
| **Worker Process Stability** | Medium | Implement worker restart logic, health checks                       |

---

## Success Metrics

| Metric             | Target | Measurement                                 |
| ------------------ | ------ | ------------------------------------------- |
| **Code Reuse**     | >95%   | Lines of code migrated vs rewritten         |
| **Feature Parity** | 100%   | All features functional vs Electron version |
| **Performance**    | <2s    | Page load time, API response time           |
| **Test Coverage**  | >30%   | Maintain existing coverage thresholds       |
| **Bundle Size**    | <5MB   | Initial JS bundle (gzipped)                 |

---

## Conclusion

This migration plan leverages AionUi's existing WebUI infrastructure to minimize development effort while achieving a pure web architecture. The key insight is that the WebUI server (`src/webserver/`) already provides 60%+ of the necessary infrastructure - we primarily need to:

1. **Remove Electron-specific code** (~25 files)
2. **Convert IPC bridges to HTTP routes** (100+ endpoints)
3. **Create API client for frontend** (drop-in replacement for ipcBridge)
4. **Adapt file handling** (uploads vs direct filesystem)

**Estimated Timeline**: 4-6 weeks for a team of 2-3 developers
**Estimated Effort**: ~400-600 development hours

The result will be a fully functional web application that can be:

- Self-hosted via Docker
- Deployed to cloud platforms
- Accessed from any modern browser
- Extended with additional web-specific features

All core functionality (AI agents, database, extensions, cron jobs) remains unchanged, ensuring zero feature loss in the migration.
