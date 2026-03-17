# AionUi WebSocket-Only Migration Plan

## Pure Web Conversion with Maximum Code Reuse

**Version**: 1.0  
**Approach**: WebSocket-Only (No REST API)  
**Estimated Duration**: 3-4 weeks  
**Code Reuse Target**: 97%  
**Risk Level**: Low (existing infrastructure)

---

## Executive Summary

This plan details the migration of AionUi from Electron to a pure web application using the **existing WebSocket infrastructure**. Unlike a hybrid REST+WebSocket approach that requires building 120+ HTTP endpoints, this plan leverages the production-ready WebSocket system already in use by AionUi's WebUI mode.

### Key Metrics

| Metric                | Value                         |
| --------------------- | ----------------------------- |
| **Estimated Effort**  | 132 hours (3-4 weeks)         |
| **Code Reuse**        | 97% (~58,000 lines unchanged) |
| **Files Modified**    | ~25 files (~370 lines)        |
| **Files Removed**     | ~5 Electron-specific files    |
| **New Files Created** | ~8 files                      |
| **Risk Level**        | Low                           |
| **Cost Estimate**     | $10,000-15,000                |

### Why This Approach Works

1. **Infrastructure Exists**: `src/adapter/browser.ts` is production-ready WebSocket client
2. **Same Message Format**: Electron IPC and WebSocket use identical JSON format
3. **Bridge Compatibility**: All 100+ IPC handlers work without modification
4. **Tested in Production**: WebSocket mode already powers WebUI
5. **No API Mapping**: Eliminates 120+ route creation tasks

---

## Phase Overview

```
Week 1: Foundation & Electron Removal
├── Phase 0: Setup & Project Structure
└── Phase 1: Remove Electron Dependencies

Week 2: Core Migration
├── Phase 2: Create Pure Web Entry Point
└── Phase 3: Adapt Frontend for Web Mode

Week 3: File Handling & Testing
├── Phase 4: File Handling Web Migration
└── Phase 5: Testing & Quality Assurance

Week 4: Deployment
└── Phase 6: Deployment & Documentation
```

---

## Phase 0: Setup & Foundation

### Objective

Prepare the project structure and verify the existing WebSocket infrastructure works correctly.

### Duration

**2-3 days** (16 hours)

### Deliverables

- [ ] Branch created for migration
- [ ] Dependencies audited
- [ ] Build pipeline configured
- [ ] WebSocket infrastructure verified
- [ ] Development environment documented

### TODOs

#### Task 0.1: Create Migration Branch

**What to do:**

- Create feature branch `feat/pure-web-migration`
- Set up branch protection rules
- Document branch strategy

**Files to modify:**

- `.github/workflows/` - Add branch to CI triggers

**Verification:**

```bash
git branch -a | grep pure-web
# Should show: remotes/origin/feat/pure-web-migration
```

**Commit:** `chore: create pure-web-migration branch`

---

#### Task 0.2: Audit Dependencies

**What to do:**

- Identify all Electron-specific dependencies
- Mark dependencies for removal
- Identify missing web dependencies
- Document dependency changes

**Files to read:**

- `package.json` - Main dependencies
- `electron.vite.config.ts` - Build dependencies

**Analysis checklist:**

- [ ] List all packages with "electron" in name
- [ ] Identify build-time vs runtime dependencies
- [ ] Check which dependencies are used in main vs renderer
- [ ] Document native modules (better-sqlite3, etc.)

**Output:** `docs/migration/dependency-audit.md`

**Commit:** `docs: audit dependencies for web migration`

---

#### Task 0.3: Verify WebSocket Infrastructure

**What to do:**

- Test existing WebSocket implementation
- Verify browser.ts adapter connects correctly
- Test message routing through adapter
- Document any issues found

**Test steps:**

```bash
# 1. Start WebUI mode (existing functionality)
bun run webui

# 2. Open browser to http://localhost:3000

# 3. Verify WebSocket connection in DevTools
# - Check Network tab for WebSocket connection
# - Verify no errors in console

# 4. Test basic functionality
# - Login
# - Create conversation
# - Send message
# - Verify real-time streaming works
```

**Files to examine:**

- `src/adapter/browser.ts` - WebSocket client
- `src/webserver/websocket/WebSocketManager.ts` - Server-side
- `src/webserver/adapter.ts` - Integration

**Expected results:**

- WebSocket connects successfully
- Messages route correctly
- Authentication works
- Streaming responses functional

**Verification command:**

```bash
# Automated check
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Host: localhost:3000" \
  -H "Origin: http://localhost:3000" \
  http://localhost:3000

# Should return: HTTP/1.1 101 Switching Protocols
```

**Commit:** `test: verify WebSocket infrastructure functionality`

---

#### Task 0.4: Configure Build Pipeline

**What to do:**

- Set up separate build configs for server and web
- Configure Vite for frontend (remove Electron plugin)
- Configure TypeScript for Node.js server
- Set up development scripts

**Files to create/modify:**

**New: `vite.web.config.ts`**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@renderer': path.resolve(__dirname, './src/renderer'),
      '@common': path.resolve(__dirname, './src/common'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
});
```

**Modify: `package.json` scripts**

```json
{
  "scripts": {
    "dev:web": "vite --config vite.web.config.ts",
    "dev:server": "tsx watch src/server.ts",
    "build:web": "vite build --config vite.web.config.ts",
    "build:server": "tsc -p tsconfig.server.json",
    "start:web": "npm run build:web && npm run build:server && node dist/server/index.js"
  }
}
```

**New: `tsconfig.server.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist/server",
    "module": "commonjs",
    "target": "ES2020",
    "lib": ["ES2020"],
    "jsx": "preserve"
  },
  "include": [
    "src/server.ts",
    "src/webserver/**/*",
    "src/process/**/*",
    "src/agent/**/*",
    "src/worker/**/*",
    "src/common/**/*",
    "src/types/**/*"
  ],
  "exclude": ["src/renderer/**/*"]
}
```

**Verification:**

```bash
npm run build:web
npm run build:server
# Both should complete without errors
```

**Commit:** `build: configure separate build pipeline for web and server`

---

## Phase 1: Remove Electron Dependencies

### Objective

Remove all Electron-specific code from the main process while preserving business logic.

### Duration

**3-4 days** (24-32 hours)

### Deliverables

- [ ] Electron imports removed from main process
- [ ] Window/Tray/Menu code extracted or removed
- [ ] Native dialogs replaced with stubs
- [ ] Electron-specific bridges removed
- [ ] Main entry point cleaned up

### TODOs

#### Task 1.1: Analyze Electron Usage in index.ts

**What to do:**

- Read `src/index.ts` completely
- Identify all Electron API usage
- Categorize by: Keep, Remove, Adapt
- Document each usage with line numbers

**Files to read:**

- `src/index.ts` (1,062 lines)

**Analysis categories:**

**KEEP (move to server.ts):**

- App initialization logic (lines 770-810)
- Webserver startup (lines 837-845)
- Worker initialization (line 860)
- Process initialization (line 813)
- Deep link handling (optional - adapt for web)

**REMOVE:**

- BrowserWindow creation (lines 563-728)
- Tray management (lines 342-541)
- Menu setup (lines 730, 636)
- Window event handlers (lines 699-727)
- DevTools management (lines 706-718)
- Protocol registration (lines 182-196)
- Single instance lock (lines 101-146)
- Auto-updater (lines 644-666)

**ADAPT:**

- Path resolution (use process.cwd() instead of app.getPath())
- Environment detection (use NODE_ENV instead of app.isPackaged)

**Output:** `docs/migration/index.ts-analysis.md`

**Commit:** `docs: analyze Electron usage in main entry point`

---

#### Task 1.2: Create Server Entry Point

**What to do:**

- Create new `src/server.ts` file
- Extract webserver startup logic from index.ts
- Add initialization sequence
- Configure graceful shutdown

**New file: `src/server.ts`**

```typescript
/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import './utils/configureConsoleLog';
import { initializeProcess } from './process';
import { startWebServer } from './webserver';
import { setWebServerInstance } from './process/bridge/webuiBridge';
import { ProcessConfig } from './process/initStorage';
import { SERVER_CONFIG } from './webserver/config/constants';
import { loadShellEnvironmentAsync, logEnvironmentDiagnostics } from './process/utils/shellEnv';
import { initializeAcpDetector } from './process/bridge';
import WorkerManage from './process/WorkerManage';
import * as path from 'path';
import * as fs from 'fs';

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('[Server] Uncaught exception:', error);
  if (process.env.NODE_ENV !== 'development') {
    // TODO: Add error reporting
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled rejection:', reason);
});

// Configuration
const WEBUI_CONFIG_FILE = 'webui.config.json';
const DESKTOP_WEBUI_PORT_KEY = 'webui.desktop.port';

interface WebUIUserConfig {
  port?: number | string;
  allowRemote?: boolean;
}

const loadUserWebUIConfig = (): { config: WebUIUserConfig; path: string | null } => {
  try {
    const userDataPath = process.env.AIONUI_DATA_DIR || path.join(process.cwd(), 'data');
    const configPath = path.join(userDataPath, WEBUI_CONFIG_FILE);
    if (!fs.existsSync(configPath)) {
      return { config: {}, path: configPath };
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return { config: parsed as WebUIUserConfig, path: configPath };
  } catch (error) {
    return { config: {}, path: null };
  }
};

const parsePortValue = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const portNumber = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(portNumber) || portNumber < 1 || portNumber > 65535) {
    return null;
  }
  return portNumber;
};

const resolveWebUIPort = (config: WebUIUserConfig): number => {
  const envPort = parsePortValue(process.env.AIONUI_PORT || process.env.PORT);
  if (envPort) return envPort;
  const configPort = parsePortValue(config.port);
  if (configPort) return configPort;
  return SERVER_CONFIG.DEFAULT_PORT;
};

const resolveRemoteAccess = (config: WebUIUserConfig): boolean => {
  const envRemote = process.env.AIONUI_ALLOW_REMOTE === 'true' || process.env.AIONUI_REMOTE === 'true';
  const configRemote = config.allowRemote === true;
  return envRemote || configRemote;
};

/**
 * Main server initialization
 */
const main = async (): Promise<void> => {
  console.log('[AionUi Server] Starting...');
  console.log(`[Server] Node version: ${process.version}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);

  // Log environment diagnostics
  logEnvironmentDiagnostics();

  // Initialize process (database, storage, etc.)
  try {
    await initializeProcess();
    console.log('[Server] Process initialized');
  } catch (error) {
    console.error('[Server] Failed to initialize process:', error);
    process.exit(1);
  }

  // Load configuration
  const { config: userConfig } = loadUserWebUIConfig();
  const port = resolveWebUIPort(userConfig);
  const allowRemote = resolveRemoteAccess(userConfig);

  console.log(`[Server] Configuration: port=${port}, allowRemote=${allowRemote}`);

  // Initialize ACP detector
  try {
    await initializeAcpDetector();
    console.log('[Server] ACP detector initialized');
  } catch (error) {
    console.error('[Server] Failed to initialize ACP detector:', error);
  }

  // Preload shell environment
  loadShellEnvironmentAsync()
    .then((shellEnv) => {
      if (shellEnv.PATH) {
        process.env.PATH = shellEnv.PATH;
      }
      Object.entries(shellEnv).forEach(([key, value]) => {
        if (key !== 'PATH' && !process.env[key]) {
          process.env[key] = value;
        }
      });
    })
    .catch((error) => {
      console.warn('[Server] Failed to load shell environment:', error);
    });

  // Start WebServer
  try {
    const serverInstance = await startWebServer(port, allowRemote);
    setWebServerInstance(serverInstance);
    console.log(`[Server] WebServer started on port ${port}`);
    console.log(`[Server] Local URL: http://localhost:${port}`);
    if (allowRemote) {
      console.log(`[Server] Remote access enabled`);
    }
  } catch (error) {
    console.error('[Server] Failed to start WebServer:', error);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[Server] Received ${signal}, shutting down gracefully...`);

    // Stop all workers
    WorkerManage.clear();
    console.log('[Server] Workers stopped');

    // Shutdown channel manager
    try {
      const { getChannelManager } = await import('@/channels');
      await getChannelManager().shutdown();
      console.log('[Server] Channel manager shut down');
    } catch (error) {
      console.error('[Server] Error shutting down channel manager:', error);
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log('[AionUi Server] Ready!');
};

// Start server
main().catch((error) => {
  console.error('[Server] Fatal error:', error);
  process.exit(1);
});
```

**Verification:**

```bash
# Test server startup
npm run build:server
node dist/server.js

# Expected output:
# [AionUi Server] Starting...
# [Server] Process initialized
# [Server] WebServer started on port 3000
# [Server] Ready!
```

**Commit:** `feat: create pure web server entry point`

---

#### Task 1.3: Remove Electron-Specific Bridges

**What to do:**

- Remove or adapt bridges that depend on Electron APIs
- Update bridge index exports
- Document removed functionality

**Files to modify:**

**1. Remove: `src/process/bridge/windowControlsBridge.ts`**

```bash
# This file is Electron-only
git rm src/process/bridge/windowControlsBridge.ts
```

**2. Remove: `src/process/bridge/notificationBridge.ts`** (or adapt to use Web Notifications API)

**3. Modify: `src/process/bridge/index.ts`**
Remove exports for removed bridges:

```typescript
// BEFORE:
export * from './windowControlsBridge';
export * from './notificationBridge';

// AFTER:
// (remove these lines)
```

**4. Adapt: `src/process/bridge/dialogBridge.ts`**
Change to return error or stub:

```typescript
// In dialogBridge.ts
ipcBridge.dialog.showOpen.provider(() => {
  // Web version doesn't support native dialogs
  // Frontend should use <input type="file"> instead
  throw new Error('Native dialogs not supported in web mode. Use file input element.');
});
```

**Verification:**

```bash
# Build should succeed
npm run build:server

# Check for any remaining Electron imports
grep -r "from 'electron'" src/ --include="*.ts" | grep -v ".d.ts"
# Should return nothing (or only in files marked for removal)
```

**Commit:** `refactor: remove Electron-specific bridge handlers`

---

#### Task 1.4: Update Process Initialization

**What to do:**

- Remove Electron app references from process initialization
- Replace `app.getPath()` with environment variables or config
- Update path resolution logic

**Files to modify:**

**`src/process/index.ts`**

```typescript
// BEFORE:
import { app } from 'electron';
const isPackaged = app.isPackaged;

// AFTER:
const isPackaged = process.env.NODE_ENV === 'production';
```

**`src/process/initStorage.ts`**

```typescript
// BEFORE:
import { app } from 'electron';
const userDataPath = app.getPath('userData');

// AFTER:
const userDataPath = process.env.AIONUI_DATA_DIR || path.join(process.cwd(), 'data');
```

**`src/process/utils.ts`**

```typescript
// BEFORE:
import { app } from 'electron';
return app.getAppPath();

// AFTER:
return process.cwd();
```

**Verification:**

```bash
# Test process initialization
npm run build:server
node -e "require('./dist/server/index.js')"

# Should start without Electron errors
```

**Commit:** `refactor: remove Electron app references from process layer`

---

## Phase 2: Frontend Web Mode Adaptation

### Objective

Configure frontend to work in pure web mode using the existing browser adapter.

### Duration

**3-4 days** (24-32 hours)

### Deliverables

- [ ] Frontend builds without Electron dependencies
- [ ] WebSocket connection established automatically
- [ ] Authentication flow works in browser
- [ ] Runtime patches removed or adapted
- [ ] Environment detection updated

### TODOs

#### Task 2.1: Update Frontend Entry Point

**What to do:**

- Modify `src/renderer/index.ts` to remove Electron assumptions
- Ensure browser adapter loads correctly
- Test WebSocket auto-detection

**Files to modify:**

**`src/renderer/index.ts`**

```typescript
// BEFORE:
import './bootstrap/runtimePatches'; // May contain Electron-specific code

// AFTER:
// Remove or conditionally load runtime patches
// Check if patches are needed for web mode
```

**Check: `src/renderer/bootstrap/runtimePatches.ts`**

```typescript
// Review this file for Electron-specific code
// If it contains Electron APIs, either:
// 1. Remove it entirely
// 2. Conditionally load based on environment
// 3. Create web-safe version
```

**Verification:**

```bash
# Build frontend
npm run build:web

# Should complete without errors
# Check dist/web/index.html exists
```

**Commit:** `refactor: update frontend entry for web mode`

---

#### Task 2.2: Verify Browser Adapter Integration

**What to do:**

- Ensure `src/adapter/browser.ts` loads correctly
- Test WebSocket connection
- Verify message routing

**Test steps:**

```bash
# 1. Start server
npm run dev:server

# 2. In another terminal, start frontend dev server
npm run dev:web

# 3. Open browser to http://localhost:5173

# 4. Check DevTools console:
# Should see: "[browser] WebSocket connecting to ws://localhost:3000"
# Should see: "[browser] WebSocket connected"

# 5. Test login
# Should authenticate via WebSocket

# 6. Test conversation creation
# Should work via WebSocket messages
```

**Files to verify:**

- `src/adapter/browser.ts` - Loads automatically (no changes needed)
- WebSocket connects to correct URL
- Messages route through bridge correctly

**Debug checklist:**

- [ ] WebSocket connects without errors
- [ ] Authentication message sent/received
- [ ] Response streaming works
- [ ] No CORS errors
- [ ] Messages formatted correctly

**Commit:** `test: verify browser adapter WebSocket integration`

---

#### Task 2.3: Update HTML Entry Point

**What to do:**

- Modify `src/renderer/index.html` for web mode
- Remove Electron-specific meta tags if any
- Ensure correct script loading

**Files to modify:**

**`src/renderer/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="AionUi - AI Agent Interface" />
    <!-- Remove any Electron-specific meta tags -->
    <title>AionUi Web</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./index.tsx"></script>
  </body>
</html>
```

**Verification:**

```bash
# Build and check output
cat dist/web/index.html

# Should contain correct paths
```

**Commit:** `chore: update HTML entry for web mode`

---

#### Task 2.4: Remove window.electronAPI References

**What to do:**

- Search for all `window.electronAPI` usage
- Remove or replace with bridge calls
- Update type definitions

**Search command:**

```bash
grep -r "window.electronAPI" src/renderer --include="*.ts" --include="*.tsx"
```

**Expected results:** Should be minimal or none, since renderer should use `ipcBridge`

**If found, replace:**

```typescript
// BEFORE:
window.electronAPI.webuiResetPassword();

// AFTER:
// Use the bridge adapter instead
// The bridge automatically routes through WebSocket
```

**Verification:**

```bash
# Should return no results
grep -r "window.electronAPI" src/renderer --include="*.ts" --include="*.tsx"
```

**Commit:** `refactor: remove window.electronAPI references`

---

## Phase 3: File Handling Web Migration

### Objective

Replace Electron's native file dialogs with web-compatible file handling.

### Duration

**2-3 days** (16-24 hours)

### Deliverables

- [ ] File upload component created
- [ ] Directory upload supported (where browser allows)
- [ ] File download functionality works
- [ ] Drag-and-drop adapted for web
- [ ] Workspace file operations tested

### TODOs

#### Task 3.1: Create FileUpload Component

**What to do:**

- Create reusable file upload component
- Support single/multiple files
- Support directory selection (webkitdirectory)
- Integrate with existing upload logic

**New file: `src/renderer/components/FileUpload/index.tsx`**

```typescript
import React, { useRef, useCallback } from 'react';
import { apiClient } from '../../services/apiClient';

interface FileUploadProps {
  workspace: string;
  onUploadComplete?: (filePaths: string[]) => void;
  onUploadProgress?: (progress: number) => void;
  multiple?: boolean;
  directory?: boolean;
  accept?: string;
  children?: React.ReactNode;
}

export const FileUpload: React.FC<FileUploadProps> = ({
  workspace,
  onUploadComplete,
  onUploadProgress,
  multiple = true,
  directory = false,
  accept,
  children,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFileSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    try {
      // Upload files via HTTP (multipart)
      const formData = new FormData();
      Array.from(files).forEach((file) => {
        formData.append('files', file);
      });
      formData.append('workspace', workspace);

      const response = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
        headers: {
          'Authorization': `Bearer ${apiClient.getToken()}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const result = await response.json();
      onUploadComplete?.(result.filePaths);
    } catch (error) {
      console.error('Upload error:', error);
      // Show error notification
    }

    // Reset input
    event.target.value = '';
  }, [workspace, onUploadComplete]);

  return (
    <>
      <div onClick={handleClick} style={{ cursor: 'pointer' }}>
        {children || <button>Select Files</button>}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        {...(directory ? { webkitdirectory: '' } : {})}
        accept={accept}
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />
    </>
  );
};
```

**Verification:**

```typescript
// Test component renders
import { FileUpload } from './components/FileUpload';

// In a component:
<FileUpload
  workspace="/path/to/workspace"
  onUploadComplete={(paths) => console.log('Uploaded:', paths)}
>
  <button>Upload Files</button>
</FileUpload>
```

**Commit:** `feat: create FileUpload component for web mode`

---

#### Task 3.2: Create HTTP File Upload Endpoint

**What to do:**

- Add Express route for file uploads
- Handle multipart/form-data
- Save files to workspace
- Return file paths

**Modify: `src/webserver/routes/apiRoutes.ts`**

```typescript
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';

const upload = multer({ storage: multer.memoryStorage() });

// File upload endpoint
router.post('/files/upload', authenticate, upload.array('files'), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    const { workspace } = req.body;

    if (!workspace || !fs.existsSync(workspace)) {
      return res.status(400).json({ error: 'Invalid workspace' });
    }

    const uploadedPaths: string[] = [];

    for (const file of files) {
      const filePath = path.join(workspace, file.originalname);
      await fs.writeFile(filePath, file.buffer);
      uploadedPaths.push(filePath);
    }

    res.json({ success: true, filePaths: uploadedPaths });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});
```

**Verification:**

```bash
# Test upload endpoint
curl -X POST http://localhost:3000/api/files/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@test.txt" \
  -F "workspace=/path/to/workspace"

# Should return: {"success":true,"filePaths":[...]}
```

**Commit:** `feat: add HTTP file upload endpoint`

---

#### Task 3.3: Adapt Workspace Drag-and-Drop

**What to do:**

- Modify drag-drop handlers to work without Electron paths
- Use File API for dropped files
- Upload files via HTTP

**Modify: `src/renderer/pages/conversation/workspace/hooks/useWorkspaceDragImport.ts`**

```typescript
// BEFORE (Electron):
const filePath = window.electronAPI?.getPathForFile(file);

// AFTER (Web):
const handleDrop = useCallback(
  async (event: DragEvent) => {
    event.preventDefault();

    const items = event.dataTransfer?.items;
    if (!items) return;

    const files: File[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    // Upload files via HTTP
    if (files.length > 0) {
      const formData = new FormData();
      files.forEach((file) => formData.append('files', file));
      formData.append('workspace', workspace);

      const response = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
        headers: { Authorization: `Bearer ${getToken()}` },
      });

      const result = await response.json();
      // Handle uploaded files
    }
  },
  [workspace]
);
```

**Verification:**

- Drag files from desktop to workspace
- Files should upload successfully
- Appear in workspace file list

**Commit:** `refactor: adapt drag-drop for web file handling`

---

#### Task 3.4: Implement File Download

**What to do:**

- Create download function for workspace files
- Use fetch + Blob for browser download

**New: `src/renderer/utils/download.ts`**

```typescript
export async function downloadFile(filePath: string, fileName?: string): Promise<void> {
  try {
    // Get file via WebSocket or HTTP
    const response = await fetch(`/api/files/download?path=${encodeURIComponent(filePath)}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });

    if (!response.ok) {
      throw new Error('Download failed');
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = url;
    link.download = fileName || filePath.split('/').pop() || 'download';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    window.URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Download error:', error);
    throw error;
  }
}
```

**Add endpoint:**

```typescript
// src/webserver/routes/apiRoutes.ts
router.get('/files/download', authenticate, async (req, res) => {
  const { path: filePath } = req.query;

  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'Path required' });
  }

  // Security: ensure path is within allowed directories
  // ... validation logic ...

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath);
});
```

**Commit:** `feat: implement file download for web mode`

---

## Phase 4: Testing & Quality Assurance

### Objective

Comprehensive testing of all functionality in web mode.

### Duration

**4-5 days** (32-40 hours)

### Deliverables

- [ ] All IPC channels tested via WebSocket
- [ ] Authentication flow verified
- [ ] File operations tested
- [ ] AI agents tested (Gemini, ACP, Codex)
- [ ] Extensions system tested
- [ ] Cron jobs tested
- [ ] Performance benchmarks

### TODOs

#### Task 4.1: Create WebSocket Test Suite

**What to do:**

- Create automated tests for WebSocket communication
- Test all IPC channel categories
- Verify message format integrity

**New file: `tests/integration/websocket-channels.test.ts`**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { startTestServer } from './test-server';

describe('WebSocket IPC Channels', () => {
  let server: any;
  let ws: WebSocket;
  let authToken: string;

  beforeAll(async () => {
    server = await startTestServer();
    authToken = await server.getAuthToken();

    ws = new WebSocket(`ws://localhost:${server.port}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });

    await new Promise((resolve) => ws.once('open', resolve));
  });

  afterAll(async () => {
    ws.close();
    await server.stop();
  });

  describe('Conversation Channels', () => {
    it('should create conversation', async () => {
      const message = {
        name: 'create-conversation',
        data: {
          type: 'gemini',
          name: 'Test Conversation',
          model: {
            /* ... */
          },
          extra: { workspace: '/tmp/test' },
        },
      };

      const response = await sendAndWait(ws, message);
      expect(response.data).toHaveProperty('id');
      expect(response.data.name).toBe('Test Conversation');
    });

    it('should send message and receive stream', async () => {
      const messages: any[] = [];

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.name === 'chat.response.stream') {
          messages.push(msg.data);
        }
      });

      ws.send(
        JSON.stringify({
          name: 'chat.send.message',
          data: {
            conversation_id: 'test-conv-id',
            input: 'Hello!',
            msg_id: 'test-msg-1',
          },
        })
      );

      // Wait for streaming to complete
      await new Promise((resolve) => setTimeout(resolve, 5000));

      expect(messages.length).toBeGreaterThan(0);
      expect(messages[messages.length - 1].type).toBe('finish');
    });
  });

  describe('File System Channels', () => {
    it('should read file', async () => {
      const response = await sendAndWait(ws, {
        name: 'get-file-by-dir',
        data: { dir: '/tmp', root: '/tmp' },
      });

      expect(Array.isArray(response.data)).toBe(true);
    });
  });

  // ... more tests for each channel category
});

function sendAndWait(ws: WebSocket, message: any): Promise<any> {
  return new Promise((resolve) => {
    const handler = (data: any) => {
      const response = JSON.parse(data.toString());
      if (response.name === message.name) {
        ws.off('message', handler);
        resolve(response);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(message));
  });
}
```

**Verification:**

```bash
npm run test:integration
# All WebSocket channel tests should pass
```

**Commit:** `test: add WebSocket IPC channel test suite`

---

#### Task 4.2: Test All Agent Types

**What to do:**

- Test Gemini agent via WebSocket
- Test ACP agent via WebSocket
- Test Codex agent via WebSocket
- Verify streaming works for each

**Test checklist:**

- [ ] Create Gemini conversation
- [ ] Send message to Gemini
- [ ] Receive streaming response
- [ ] Test file upload with Gemini
- [ ] Create ACP conversation
- [ ] Send message to ACP
- [ ] Test Codex agent
- [ ] Test agent health checks

**Manual test script:**

```bash
# Start server
npm run dev:server

# Open browser
# 1. Login
# 2. Create Gemini conversation
# 3. Send test message
# 4. Verify streaming response appears
# 5. Upload file to workspace
# 6. Test file reference in message
# 7. Create ACP conversation
# 8. Repeat tests
```

**Commit:** `test: verify all AI agents work via WebSocket`

---

#### Task 4.3: Test File Operations End-to-End

**What to do:**

- Test file upload via HTTP
- Test file download
- Test workspace file operations
- Test drag-and-drop

**Test scenarios:**

1. Upload single file
2. Upload multiple files
3. Upload directory (if supported)
4. Download file
5. Delete file
6. Rename file
7. Drag files from desktop

**Verification:**

- All operations complete without errors
- Files appear in workspace correctly
- File content preserved
- Permissions correct

**Commit:** `test: verify file operations in web mode`

---

#### Task 4.4: Performance Testing

**What to do:**

- Measure WebSocket connection latency
- Test concurrent connections
- Measure message throughput
- Test large file uploads

**New file: `tests/performance/websocket.perf.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';

describe('WebSocket Performance', () => {
  it('should handle 100 concurrent connections', async () => {
    const connections: WebSocket[] = [];

    for (let i = 0; i < 100; i++) {
      const ws = new WebSocket('ws://localhost:3000');
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      connections.push(ws);
    }

    expect(connections.length).toBe(100);
    connections.forEach((ws) => ws.close());
  });

  it('should have <50ms latency for messages', async () => {
    const ws = new WebSocket('ws://localhost:3000');
    await new Promise((resolve) => ws.once('open', resolve));

    const start = Date.now();

    ws.send(
      JSON.stringify({
        name: 'system.info',
        data: {},
      })
    );

    const response = await new Promise((resolve) => {
      ws.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });

    const latency = Date.now() - start;
    expect(latency).toBeLessThan(50);

    ws.close();
  });
});
```

**Commit:** `test: add WebSocket performance benchmarks`

---

## Phase 5: Deployment & Documentation

### Objective

Prepare production deployment configuration and documentation.

### Duration

**2-3 days** (16-24 hours)

### Deliverables

- [ ] Docker configuration created
- [ ] Docker Compose setup
- [ ] Environment documentation
- [ ] Deployment guide
- [ ] Migration guide from Electron

### TODOs

#### Task 5.1: Create Docker Configuration

**What to do:**

- Create Dockerfile for server
- Create Dockerfile for web (static files)
- Configure multi-stage builds
- Optimize image size

**New file: `docker/Dockerfile.server`**

```dockerfile
# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Build
RUN npm run build:server

# Production stage
FROM node:22-alpine

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --production && npm cache clean --force

# Copy built files
COPY --from=builder /app/dist ./dist

# Copy worker files
COPY --from=builder /app/src/worker ./worker

# Create data directory
RUN mkdir -p /app/data /app/workspace

# Environment
ENV NODE_ENV=production
ENV AIONUI_DATA_DIR=/app/data
ENV PORT=3000

EXPOSE 3000

VOLUME ["/app/data", "/app/workspace"]

HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "dist/server/index.js"]
```

**New file: `docker/Dockerfile.web`**

```dockerfile
# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:web

# Serve with nginx
FROM nginx:alpine

COPY --from=builder /app/dist/web /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

**New file: `docker/nginx.conf`**

```nginx
server {
    listen 80;
    server_name localhost;
    root /usr/share/nginx/html;
    index index.html;

    # SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api {
        proxy_pass http://server:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # WebSocket proxy
    location /ws {
        proxy_pass http://server:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

**Commit:** `docker: add production Docker configuration`

---

#### Task 5.2: Create Docker Compose Setup

**What to do:**

- Create docker-compose.yml
- Configure services (server, web, reverse proxy)
- Set up volumes for persistence
- Configure environment variables

**New file: `docker-compose.yml`**

```yaml
version: '3.8'

services:
  aionui-server:
    build:
      context: .
      dockerfile: docker/Dockerfile.server
    container_name: aionui-server
    restart: unless-stopped
    ports:
      - '3000:3000'
    volumes:
      - aionui-data:/app/data
      - aionui-workspace:/app/workspace
    environment:
      - NODE_ENV=production
      - AIONUI_DATA_DIR=/app/data
      - JWT_SECRET=${JWT_SECRET:-change-me-in-production}
      - PORT=3000
    healthcheck:
      test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:3000/api/health']
      interval: 30s
      timeout: 10s
      retries: 3

  aionui-web:
    build:
      context: .
      dockerfile: docker/Dockerfile.web
    container_name: aionui-web
    restart: unless-stopped
    ports:
      - '80:80'
    depends_on:
      - aionui-server
    environment:
      - API_URL=http://aionui-server:3000

  # Optional: Nginx reverse proxy with SSL
  nginx:
    image: nginx:alpine
    container_name: aionui-nginx
    restart: unless-stopped
    ports:
      - '443:443'
    volumes:
      - ./docker/nginx-ssl.conf:/etc/nginx/conf.d/default.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - aionui-server
      - aionui-web
    profiles:
      - ssl

volumes:
  aionui-data:
    driver: local
  aionui-workspace:
    driver: local
```

**New file: `.env.example`**

```bash
# AionUi Web Configuration
NODE_ENV=production
PORT=3000

# Security
JWT_SECRET=your-secret-key-here-min-32-characters
JWT_EXPIRY=24h

# Data directories
AIONUI_DATA_DIR=./data
AIONUI_WORKSPACE_DIR=./workspace

# Features
ALLOW_REMOTE=false
ENABLE_CORS=true

# Optional: External services
# OPENAI_API_KEY=
# GEMINI_API_KEY=
```

**Commit:** `docker: add docker-compose configuration`

---

#### Task 5.3: Write Deployment Documentation

**What to do:**

- Create deployment guide
- Document environment variables
- Provide Docker deployment instructions
- Provide bare metal deployment instructions

**New file: `docs/deployment/README.md`**

````markdown
# AionUi Web Deployment Guide

## Quick Start (Docker)

```bash
# 1. Clone repository
git clone https://github.com/aionui/aionui.git
cd aionui

# 2. Configure environment
cp .env.example .env
# Edit .env with your settings

# 3. Start services
docker-compose up -d

# 4. Access application
# Web UI: http://localhost
# API: http://localhost:3000
```
````

## Configuration

### Environment Variables

| Variable          | Description              | Default    |
| ----------------- | ------------------------ | ---------- |
| `JWT_SECRET`      | Secret for JWT tokens    | (required) |
| `PORT`            | Server port              | 3000       |
| `ALLOW_REMOTE`    | Allow remote connections | false      |
| `AIONUI_DATA_DIR` | Data storage path        | ./data     |

### Volumes

- `aionui-data`: Database and configuration
- `aionui-workspace`: User workspace files

## Production Deployment

### With SSL (Let's Encrypt)

```bash
docker-compose --profile ssl up -d
```

### Bare Metal

```bash
# 1. Install Node.js 22
# 2. Install dependencies
npm ci --production

# 3. Build
npm run build:server
npm run build:web

# 4. Start server
NODE_ENV=production node dist/server/index.js

# 5. Serve static files (with nginx or similar)
```

## Health Checks

- API: `GET /api/health`
- WebSocket: Connect to `ws://localhost:3000`

## Troubleshooting

### WebSocket Connection Issues

Check firewall rules for port 3000.

### Database Permissions

Ensure data directory is writable:

```bash
chmod 755 ./data
```

````

**Commit:** `docs: add deployment documentation`

---

#### Task 5.4: Create Migration Guide
**What to do:**
- Document migration from Electron to Web
- Provide data migration instructions
- Document breaking changes
- Provide rollback instructions

**New file: `docs/migration/From-Electron-to-Web.md`**
```markdown
# Migrating from Electron to Web

## Overview

This guide helps you migrate from AionUi Electron to AionUi Web.

## Pre-Migration Checklist

- [ ] Backup your data directory
- [ ] Note your current workspace paths
- [ ] Export any custom settings

## Migration Steps

### 1. Backup Data

```bash
# Electron data location:
# macOS: ~/Library/Application Support/AionUi/
# Windows: %APPDATA%/AionUi/
# Linux: ~/.config/AionUi/

cp -r ~/Library/Application\ Support/AionUi/data ./aionui-backup
````

### 2. Install Web Version

Follow the [Deployment Guide](../deployment/README.md).

### 3. Migrate Data

```bash
# Copy database
cp ./aionui-backup/config/aionui.db ./data/

# Copy workspace
cp -r ./aionui-backup/workspace/* ./workspace/
```

### 4. Update Configuration

Convert Electron config to web format:

```bash
# Old location: config.json
# New location: webui.config.json

# Convert format (manual step - see examples)
```

### 5. Verify Migration

- [ ] Login works
- [ ] Conversations appear
- [ ] Files accessible
- [ ] Agents functional

## Breaking Changes

### File Selection

- **Before:** Native file dialogs
- **After:** Browser file input

### Window Management

- **Before:** System tray, minimize to tray
- **After:** Browser tabs

### Auto-Update

- **Before:** Electron auto-updater
- **After:** Manual Docker updates or watchtower

## Rollback

If you need to rollback:

1. Stop web server: `docker-compose down`
2. Restore Electron data from backup
3. Launch Electron app

## Support

For issues, please file a GitHub issue.

```

**Commit:** `docs: add migration guide from Electron`

---

## Summary & Timeline

### Week-by-Week Breakdown

**Week 1: Foundation & Removal**
- Day 1-2: Phase 0 (Setup)
- Day 3-5: Phase 1 (Remove Electron)

**Week 2: Core Migration**
- Day 1-2: Phase 2 (Web Entry)
- Day 3-5: Phase 3 (Frontend)

**Week 3: Features & Testing**
- Day 1-2: Phase 4 (File Handling)
- Day 3-5: Phase 5 (Testing)

**Week 4: Deployment**
- Day 1-3: Phase 6 (Deployment)
- Day 4-5: Documentation & Polish

### Resource Requirements

- **Developers**: 1-2 engineers
- **Timeline**: 3-4 weeks
- **Effort**: 132 hours
- **Cost**: $10,000-15,000

### Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| WebSocket compatibility | Test thoroughly in Week 3 |
| File handling issues | Implement fallback upload methods |
| Performance concerns | Load testing in Week 3 |
| Data migration | Comprehensive backup strategy |

---

## Next Steps

1. **Review this plan** with stakeholders
2. **Create feature branch** for migration
3. **Begin Phase 0** (Setup)
4. **Track progress** using GitHub issues or project board

---

## Appendix: Files Changed Summary

### Modified Files (~20 files)
- `src/index.ts` - Remove Electron, adapt for web
- `src/process/index.ts` - Remove app references
- `src/process/initStorage.ts` - Update path resolution
- `src/process/utils.ts` - Remove Electron utils
- `src/process/bridge/index.ts` - Remove Electron bridges
- `src/renderer/index.ts` - Update entry
- `src/renderer/index.html` - Update HTML
- `src/renderer/bootstrap/runtimePatches.ts` - Adapt for web
- `src/webserver/routes/apiRoutes.ts` - Add upload endpoints
- `package.json` - Update scripts and dependencies
- `vite.web.config.ts` - New build config
- `tsconfig.server.json` - New TS config

### Removed Files (~5 files)
- `src/preload.ts` - Not needed
- `src/process/bridge/windowControlsBridge.ts` - Electron only
- `src/process/bridge/notificationBridge.ts` - Electron only
- `src/utils/appMenu.ts` - Electron only
- `src/utils/configureChromium.ts` - Electron only

### New Files (~8 files)
- `src/server.ts` - Web entry point
- `vite.web.config.ts` - Web build config
- `tsconfig.server.json` - Server TS config
- `src/renderer/components/FileUpload/` - Upload component
- `docker/Dockerfile.server` - Docker config
- `docker/Dockerfile.web` - Docker config
- `docker/nginx.conf` - Nginx config
- `docker-compose.yml` - Compose setup

**Total: ~370 lines changed out of 60,000+ codebase = 0.6%**
```
