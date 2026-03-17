# AionUi Web Migration - Additive-Only Architecture

## TL;DR

> **Zero Merge Conflict Strategy**: Convert AionUi to web deployment while keeping 100% of existing Electron code intact.
>
> **Key Innovation**: Additive-only changes - only 3 files modified, 10 new files added. Existing codebase remains untouched for easy upstream syncing.
>
> **Architecture**: Dual-mode deployment - Electron and Web share the same business logic, database, agents, and IPC bridges via WebSocket adapter.
>
> **Estimated Duration**: 8-10 days (vs 17 days in original plan)
> **Merge Conflict Risk**: Near-zero (only package.json scripts modified)
> **Upstream Sync Strategy**: Daily rebases with no conflicts

---

## Context

### The Problem with "Traditional" Migration

Original plan modified ~25 files over 3-4 weeks:

- `src/index.ts` - Extract logic, remove Electron imports
- `src/preload.ts` - Remove Electron APIs
- `src/renderer/index.tsx` - Change entry point
- 20+ other files

**Result**: Constant merge conflicts with active upstream (3-5 PRs/day), code drift, difficult maintenance.

### The Additive-Only Solution

**Philosophy**: Don't modify - extend.

Create parallel entry points that coexist with existing code:

- `src/server.ts` (NEW) → runs alongside `src/index.ts`
- `src/renderer/web-entry.tsx` (NEW) → builds alongside existing renderer
- `vite.web.config.ts` (NEW) → separate build config
- **Existing files**: 100% unchanged

---

## Work Objectives

### Core Objective

Enable AionUi web deployment with **zero modifications to existing Electron code**, ensuring seamless upstream synchronization.

### Concrete Deliverables

- [ ] `src/server.ts` - Pure Node.js entry point (NEW)
- [ ] `src/renderer/web-entry.tsx` - Web renderer entry (NEW)
- [ ] `vite.web.config.ts` - Web build configuration (NEW)
- [ ] `src/webserver/routes/fileUploadRoutes.ts` - File upload endpoints (NEW)
- [ ] Docker deployment configuration (NEW)
- [ ] Both Electron and Web modes functional from same codebase

### Definition of Done

```bash
# Electron mode (unchanged)
bun run start

# Web mode (new)
bun run dev:web    # Frontend dev server
bun run dev:server # Backend server
bun run build:web  # Production build
```

### Must Have

- [ ] Existing Electron functionality 100% preserved
- [ ] Web mode fully functional via WebSocket
- [ ] All 100+ IPC bridges work in both modes
- [ ] File upload/download working in web mode
- [ ] Database, agents, workers unchanged

### Must NOT Have (Guardrails)

- [ ] **NO modifications to `src/index.ts`** - Keep Electron entry intact
- [ ] **NO modifications to `src/preload.ts`** - Keep preload intact
- [ ] **NO modifications to `src/renderer/index.tsx`** - Keep renderer entry intact
- [ ] **NO deletions of Electron-specific code** - Extract, don't remove
- [ ] **NO changes to business logic** - Only add infrastructure
- [ ] **NO breaking changes to IPC handlers** - WebSocket adapter handles compatibility

---

## Verification Strategy

### Test Decision

- **Infrastructure exists**: YES (Vitest + Playwright)
- **Automated tests**: YES (after implementation)
- **Framework**: bun test + Playwright

### QA Policy

Every task includes agent-executed QA scenarios. Evidence saved to `.sisyphus/evidence/`.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation - Independent, can start immediately):
├── Task 1: Create server.ts entry point (NEW file only)
├── Task 2: Create vite.web.config.ts (NEW file only)
├── Task 3: Add npm scripts to package.json (minimal change)
└── Task 4: Verify WebSocket infrastructure (no code changes)

Wave 2 (Renderer - Independent):
├── Task 5: Create web-entry.tsx (NEW file only)
├── Task 6: Configure web build pipeline
└── Task 7: Test browser.ts auto-detection

Wave 3 (File Handling - After Wave 1):
├── Task 8: Add file upload endpoints (NEW routes)
├── Task 9: Create file upload UI components (NEW components)
└── Task 10: Replace dialogBridge in web mode

Wave 4 (Integration & Testing - After Waves 1-3):
├── Task 11: End-to-end integration tests
├── Task 12: Docker configuration
├── Task 13: Deployment documentation
└── Task 14: Final verification (both modes)

Wave FINAL (Review - Parallel):
├── Task F1: Plan compliance audit (verify no unintended modifications)
├── Task F2: Code quality review
├── Task F3: Upstream sync verification
└── Task F4: Scope fidelity check

Critical Path: Task 1 → Task 8 → Task 11 → F1-F4
Parallel Speedup: ~60% faster than sequential
```

---

## TODOs

- [ ] **1. Create Server Entry Point**

  **What to do:**
  Create `src/server.ts` as a NEW file that extracts the webserver startup logic from `src/index.ts` WITHOUT modifying `src/index.ts`.

  Key requirements:
  - Copy initialization sequence from `src/index.ts` lines 770-860
  - Remove Electron-specific code (app, BrowserWindow, Tray, etc.)
  - Use `process.cwd()` instead of `app.getPath()`
  - Keep all business logic (initializeProcess, startWebServer, workers)
  - Add graceful shutdown handlers

  **Must NOT do:**
  - Do NOT modify `src/index.ts`
  - Do NOT delete any Electron code from existing files
  - Do NOT change IPC handlers or bridges

  **Files to create:**
  - `src/server.ts` (~100 lines, NEW)

  **Files to read (for reference only):**
  - `src/index.ts` lines 1-150 (imports and setup)
  - `src/index.ts` lines 770-860 (initialization sequence)
  - `src/webserver/index.ts` (webserver startup)

  **Pattern to follow:**
  The server.ts should mirror the initialization in index.ts but skip Electron setup:

  ```typescript
  // src/server.ts structure
  import './utils/configureConsoleLog';
  import { initializeProcess } from './process';
  import { startWebServer } from './webserver';
  // ... other imports

  async function main() {
    await loadShellEnvironmentAsync();
    await initializeProcess();
    await startWebServer();
    // ... etc
  }
  ```

  **Recommended Agent Profile:**
  - **Category**: `quick` (straightforward extraction task)
  - **Skills**: None needed

  **Parallelization:**
  - **Can Run In Parallel**: YES (Wave 1)
  - **Blocks**: Task 8 (file upload needs server running)
  - **Blocked By**: None

  **Acceptance Criteria:**
  - [ ] `src/server.ts` exists and compiles without errors
  - [ ] `bunx tsc --noEmit src/server.ts` passes
  - [ ] Server starts with `bun run dev:server` (after Task 3)
  - [ ] No modifications to any existing files

  **QA Scenarios:**

  ```
  Scenario: Server starts successfully
    Tool: Bash
    Preconditions: Task 3 completed (npm scripts added)
    Steps:
      1. Run `bun run dev:server`
      2. Wait 5 seconds for initialization
      3. Check WebSocket endpoint: `curl -i http://localhost:3000/health`
    Expected Result: HTTP 200 OK, server running
    Evidence: .sisyphus/evidence/task-1-server-start.log
  ```

  **Commit**: YES
  - Message: `feat(web): add server.ts entry point for web deployment`
  - Files: `src/server.ts`

---

- [ ] **2. Create Web Vite Configuration**

  **What to do:**
  Create `vite.web.config.ts` as a NEW file for web-only builds. This config:
  - Removes Electron-specific plugins
  - Points to `src/renderer/web-entry.tsx`
  - Configures proxy for API/WebSocket to backend
  - Sets up proper aliases

  **Must NOT do:**
  - Do NOT modify `electron.vite.config.ts`
  - Do NOT remove any existing build configuration

  **Files to create:**
  - `vite.web.config.ts` (NEW)

  **Files to read (for reference):**
  - `electron.vite.config.ts` (copy alias configuration)
  - `src/renderer/index.tsx` (understand current entry structure)

  **Configuration template:**

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
      rollupOptions: {
        input: 'src/renderer/web-entry.tsx',
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@renderer': path.resolve(__dirname, './src/renderer'),
        '@common': path.resolve(__dirname, './src/common'),
        '@process': path.resolve(__dirname, './src/process'),
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

  **Recommended Agent Profile:**
  - **Category**: `quick`
  - **Skills**: None needed

  **Parallelization:**
  - **Can Run In Parallel**: YES (Wave 1)
  - **Blocks**: Task 5 (web entry needs this config)
  - **Blocked By**: None

  **Acceptance Criteria:**
  - [ ] `vite.web.config.ts` exists and is valid
  - [ ] `bunx tsc --noEmit vite.web.config.ts` passes
  - [ ] Config uses same aliases as existing config

  **Commit**: YES
  - Message: `build: add vite.web.config.ts for web builds`
  - Files: `vite.web.config.ts`

---

- [ ] **3. Add npm Scripts**

  **What to do:**
  Add new npm scripts to `package.json` for web development. This is one of the few modifications to existing files - keep it minimal.

  Scripts to add:
  - `dev:web` - Start Vite dev server for web
  - `dev:server` - Start Node.js server
  - `build:web` - Build web frontend
  - `build:server` - Build server
  - `start:web` - Production web mode

  **Must NOT do:**
  - Do NOT remove or modify existing scripts
  - Do NOT change any dependencies
  - Keep modification to scripts section only

  **Files to modify:**
  - `package.json` (scripts section only)

  **Scripts to add:**

  ```json
  {
    "scripts": {
      "dev:web": "vite --config vite.web.config.ts",
      "dev:server": "tsx watch src/server.ts",
      "build:web": "vite build --config vite.web.config.ts",
      "build:server": "tsc -p tsconfig.server.json",
      "start:web": "bun run build:web && bun run build:server && node dist/server/server.js"
    }
  }
  ```

  **Recommended Agent Profile:**
  - **Category**: `quick`
  - **Skills**: None needed

  **Parallelization:**
  - **Can Run In Parallel**: YES (Wave 1)
  - **Blocks**: Task 1, Task 6 (needs these scripts)
  - **Blocked By**: None

  **Acceptance Criteria:**
  - [ ] All 5 new scripts added to package.json
  - [ ] Existing scripts unchanged
  - [ ] `bun run dev:server` starts the server (after Task 1)
  - [ ] `bun run dev:web` starts Vite dev server (after Task 5)

  **QA Scenarios:**

  ```
  Scenario: Web development scripts work
    Tool: Bash
    Preconditions: Tasks 1, 2, 5 completed
    Steps:
      1. Terminal 1: `bun run dev:server` (wait for "Server started")
      2. Terminal 2: `bun run dev:web` (wait for Vite ready)
      3. Terminal 3: `curl http://localhost:5173`
    Expected Result: HTML response from Vite dev server
    Evidence: .sisyphus/evidence/task-3-scripts-work.log
  ```

  **Commit**: YES
  - Message: `chore: add npm scripts for web development`
  - Files: `package.json`

---

- [ ] **4. Verify WebSocket Infrastructure**

  **What to do:**
  Verify the existing WebSocket infrastructure works correctly. NO code changes - just testing and documentation.

  Test:
  1. Start existing WebUI mode: `bun run webui`
  2. Open browser to http://localhost:3000
  3. Verify WebSocket connection
  4. Test basic functionality (login, create conversation, send message)

  **Must NOT do:**
  - Do NOT modify any WebSocket code
  - Do NOT change browser.ts or WebSocketManager.ts
  - This is verification only, not implementation

  **Files to read:**
  - `src/adapter/browser.ts` (verify auto-detection logic)
  - `src/webserver/websocket/WebSocketManager.ts` (verify server-side)

  **Acceptance Criteria:**
  - [ ] WebSocket connects successfully in WebUI mode
  - [ ] Messages route correctly through adapter
  - [ ] Authentication works via WebSocket
  - [ ] Document any issues found

  **QA Scenarios:**

  ```
  Scenario: WebSocket infrastructure functional
    Tool: Bash + Browser DevTools
    Steps:
      1. `bun run webui`
      2. Open http://localhost:3000
      3. DevTools → Network → WS tab
      4. Verify WebSocket connection established
      5. Login with default credentials
      6. Create a conversation and send a message
    Expected Result: WebSocket shows frames, message appears in conversation
    Evidence: .sisyphus/evidence/task-4-websocket-test.png
  ```

  **Commit**: NO (verification task, no code changes)

---

- [ ] **5. Create Web Renderer Entry**

  **What to do:**
  Create `src/renderer/web-entry.tsx` as a NEW file that:
  1. Imports `browser.ts` adapter (auto-detects WebSocket)
  2. Renders the same App component
  3. Sets up the same routes and providers

  **Key insight**: The existing `src/renderer/index.tsx` does:

  ```typescript
  import '../adapter/main'; // Electron adapter
  ```

  The web entry will do:

  ```typescript
  import '../adapter/browser'; // WebSocket adapter (auto-detects!)
  ```

  **Must NOT do:**
  - Do NOT modify `src/renderer/index.tsx`
  - Do NOT change any existing renderer components

  **Files to create:**
  - `src/renderer/web-entry.tsx` (NEW, ~30 lines)

  **Files to read (for reference):**
  - `src/renderer/index.tsx` (copy structure)
  - `src/renderer/App.tsx` (understand root component)
  - `src/adapter/browser.ts` (confirm auto-detection)

  **Implementation template:**

  ```typescript
  // src/renderer/web-entry.tsx
  import '../adapter/browser';  // Auto-detects WebSocket mode
  import { createRoot } from 'react-dom/client';
  import { BrowserRouter } from 'react-router-dom';
  import App from './App';
  import './i18n';  // Same i18n setup

  const container = document.getElementById('root');
  if (!container) throw new Error('Root element not found');

  const root = createRoot(container);
  root.render(
    <BrowserRouter>
      <App />
    </BrowserRouter>
  );
  ```

  **Recommended Agent Profile:**
  - **Category**: `quick`
  - **Skills**: None needed

  **Parallelization:**
  - **Can Run In Parallel**: YES (Wave 2)
  - **Blocks**: Task 6 (build needs entry point)
  - **Blocked By**: Task 2 (needs vite config)

  **Acceptance Criteria:**
  - [ ] `src/renderer/web-entry.tsx` exists
  - [ ] Imports browser.ts adapter
  - [ ] Renders App component
  - [ ] TypeScript compiles without errors

  **Commit**: YES
  - Message: `feat(web): add web renderer entry point`
  - Files: `src/renderer/web-entry.tsx`

---

- [ ] **6. Configure Web Build Pipeline**

  **What to do:**
  Create `tsconfig.server.json` and verify the complete build pipeline works.

  Steps:
  1. Create `tsconfig.server.json` for server compilation
  2. Verify `bun run build:web` works
  3. Verify `bun run build:server` works
  4. Test production build with `bun run start:web`

  **Files to create:**
  - `tsconfig.server.json` (NEW)

  **Configuration template:**

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

  **Recommended Agent Profile:**
  - **Category**: `quick`
  - **Skills**: None needed

  **Parallelization:**
  - **Can Run In Parallel**: NO (Wave 2 sequential)
  - **Blocks**: Task 7 (needs build to test)
  - **Blocked By**: Tasks 1, 2, 5

  **Acceptance Criteria:**
  - [ ] `tsconfig.server.json` created and valid
  - [ ] `bun run build:web` completes without errors
  - [ ] `bun run build:server` completes without errors
  - [ ] Production build starts successfully

  **QA Scenarios:**

  ```
  Scenario: Production build works
    Tool: Bash
    Steps:
      1. Run `bun run build:web`
      2. Run `bun run build:server`
      3. Check dist/ directory exists with both web/ and server/
      4. Run `bun run start:web`
      5. Wait 10 seconds
      6. Curl: `curl http://localhost:3000`
    Expected Result: HTML served, server running
    Evidence: .sisyphus/evidence/task-6-production-build.log
  ```

  **Commit**: YES
  - Message: `build: configure server TypeScript and build pipeline`
  - Files: `tsconfig.server.json`

---

- [ ] **7. Test Browser Adapter Auto-Detection**

  **What to do:**
  Verify that `browser.ts` correctly auto-detects web mode and uses WebSocket.

  Test plan:
  1. Start server: `bun run dev:server`
  2. Start web frontend: `bun run dev:web`
  3. Open browser DevTools
  4. Check console for WebSocket connection messages
  5. Verify no `window.electronAPI` errors
  6. Test login and conversation creation

  **Files to read:**
  - `src/adapter/browser.ts` lines 20-50 (auto-detection logic)

  **Acceptance Criteria:**
  - [ ] Browser connects via WebSocket (not Electron IPC)
  - [ ] No errors in browser console
  - [ ] Login works
  - [ ] Messages route through WebSocket

  **QA Scenarios:**

  ```
  Scenario: Browser adapter uses WebSocket
    Tool: Browser DevTools
    Preconditions: Tasks 1, 3, 5, 6 completed
    Steps:
      1. Start server and web dev server
      2. Open http://localhost:5173
      3. DevTools → Console: check for "WebSocket connected"
      4. DevTools → Network → WS: verify ws:// connection
      5. Login with default credentials
      6. Create conversation and send "Hello"
    Expected Result: WebSocket frames visible, message appears, no IPC errors
    Evidence: .sisyphus/evidence/task-7-websocket-auto-detect.png
  ```

  **Commit**: NO (verification only)

---

- [ ] **8. Add File Upload Endpoints**

  **What to do:**
  Create new file upload endpoints for web mode. The existing `dialogBridge.ts` uses Electron's native dialogs which don't work in browsers.

  Create:
  1. `src/webserver/routes/fileUploadRoutes.ts` - Express routes for file upload/download
  2. Update `src/webserver/routes/apiRoutes.ts` to register new routes

  **Why this is safe:**
  - Adding new routes is non-breaking
  - Existing dialogBridge.ts continues to work for Electron
  - Web mode uses HTTP upload instead of IPC

  **Must NOT do:**
  - Do NOT modify `src/process/bridge/dialogBridge.ts`
  - Do NOT remove dialog functionality
  - Only ADD new routes

  **Files to create:**
  - `src/webserver/routes/fileUploadRoutes.ts` (NEW, ~80 lines)

  **Files to modify:**
  - `src/webserver/routes/apiRoutes.ts` (ADD route registration, ~3 lines)

  **Implementation outline:**

  ```typescript
  // src/webserver/routes/fileUploadRoutes.ts
  import { Router } from 'express';
  import multer from 'multer';
  import path from 'path';
  import fs from 'fs';

  const upload = multer({ dest: 'uploads/temp/' });
  const router = Router();

  // Upload file
  router.post('/upload', upload.single('file'), async (req, res) => {
    // Save to workspace, return file metadata
  });

  // Download file
  router.get('/download/:fileId', async (req, res) => {
    // Stream file to response
  });

  export default router;
  ```

  **Recommended Agent Profile:**
  - **Category**: `unspecified-high`
  - **Skills**: None needed

  **Parallelization:**
  - **Can Run In Parallel**: YES (Wave 3)
  - **Blocks**: Task 9 (UI needs endpoints)
  - **Blocked By**: Task 1 (needs server running)

  **Acceptance Criteria:**
  - [ ] File upload endpoint works (POST /api/upload)
  - [ ] File download endpoint works (GET /api/download/:id)
  - [ ] Files saved to correct workspace location
  - [ ] Existing dialogBridge.ts untouched

  **QA Scenarios:**

  ```
  Scenario: File upload via HTTP endpoint
    Tool: Bash (curl)
    Steps:
      1. Create test file: `echo "test content" > /tmp/test.txt`
      2. Upload: `curl -F "file=@/tmp/test.txt" http://localhost:3000/api/upload`
      3. Verify response contains file metadata
      4. Download: `curl -O http://localhost:3000/api/download/{fileId}`
    Expected Result: Upload returns metadata, download returns file content
    Evidence: .sisyphus/evidence/task-8-file-upload.log
  ```

  **Commit**: YES
  - Message: `feat(web): add file upload/download HTTP endpoints`
  - Files: `src/webserver/routes/fileUploadRoutes.ts`, `src/webserver/routes/apiRoutes.ts`

---

- [ ] **9. Create File Upload UI Components**

  **What to do:**
  Create web-specific file upload components that use HTTP endpoints instead of Electron dialogs.

  Create:
  1. `src/renderer/components/web/FileUploadButton.tsx` - Hidden file input + upload logic
  2. `src/renderer/components/web/DragDropZone.tsx` - Drag-and-drop file upload
  3. Hook: `src/renderer/hooks/useFileUpload.ts` - Upload state management

  **Integration approach:**
  - Detect web mode at runtime
  - Use web components when `!window.electronAPI`
  - Keep existing components for Electron mode

  **Must NOT do:**
  - Do NOT modify existing file picker components
  - Do NOT change dialogBridge usage in existing code
  - Only ADD new components

  **Files to create:**
  - `src/renderer/components/web/FileUploadButton.tsx`
  - `src/renderer/components/web/DragDropZone.tsx`
  - `src/renderer/hooks/useFileUpload.ts`

  **Implementation outline:**

  ```typescript
  // src/renderer/components/web/FileUploadButton.tsx
  import { useRef } from 'react';
  import { useFileUpload } from '@/renderer/hooks/useFileUpload';

  export function FileUploadButton({ onUpload }: { onUpload: (files: File[]) => void }) {
    const inputRef = useRef<HTMLInputElement>(null);
    const { upload, isUploading } = useFileUpload();

    const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      const uploaded = await Promise.all(files.map(upload));
      onUpload(uploaded);
    };

    return (
      <>
        <input
          ref={inputRef}
          type="file"
          multiple
          onChange={handleChange}
          style={{ display: 'none' }}
        />
        <button onClick={() => inputRef.current?.click()} disabled={isUploading}>
          {isUploading ? 'Uploading...' : 'Upload Files'}
        </button>
      </>
    );
  }
  ```

  **Recommended Agent Profile:**
  - **Category**: `visual-engineering`
  - **Skills**: None needed

  **Parallelization:**
  - **Can Run In Parallel**: YES (Wave 3)
  - **Blocks**: Task 10 (needs components)
  - **Blocked By**: Task 8 (needs endpoints)

  **Acceptance Criteria:**
  - [ ] FileUploadButton component works
  - [ ] DragDropZone component works
  - [ ] useFileUpload hook manages upload state
  - [ ] Components styled with Arco Design
  - [ ] No modifications to existing components

  **QA Scenarios:**

  ```
  Scenario: Web file upload UI works
    Tool: Playwright
    Preconditions: Tasks 1, 3, 5, 6, 8 completed
    Steps:
      1. Start server and web dev server
      2. Open http://localhost:5173
      3. Login
      4. Navigate to workspace
      5. Click "Upload Files" button
      6. Select test file
      7. Verify upload progress and completion
    Expected Result: File uploads, appears in workspace
    Evidence: .sisyphus/evidence/task-9-file-upload-ui.png
  ```

  **Commit**: YES
  - Message: `feat(web): add file upload UI components for web mode`
  - Files: `src/renderer/components/web/`, `src/renderer/hooks/useFileUpload.ts`

---

- [ ] **10. Integrate File Upload in Web Mode**

  **What to do:**
  Modify file picker entry points to use web components when in browser mode.

  Approach:
  1. Identify where dialogBridge is used for file selection
  2. Create a wrapper component that detects mode
  3. Use web upload in browser, dialogBridge in Electron

  **Files to modify:**
  - Identify and update 2-3 specific file picker usages
  - Keep changes minimal and localized

  **Detection pattern:**

  ```typescript
  const isElectron = !!window.electronAPI;

  {isElectron ? (
    <ExistingFilePicker onSelect={handleSelect} />
  ) : (
    <FileUploadButton onUpload={handleUpload} />
  )}
  ```

  **Recommended Agent Profile:**
  - **Category**: `unspecified-high`
  - **Skills**: None needed

  **Parallelization:**
  - **Can Run In Parallel**: NO (Wave 3 sequential)
  - **Blocks**: Task 11 (needs complete file handling)
  - **Blocked By**: Task 9

  **Acceptance Criteria:**
  - [ ] File upload works in web mode
  - [ ] File picker still works in Electron mode
  - [ ] No regressions in Electron functionality

  **Commit**: YES
  - Message: `feat(web): integrate file upload in web mode`
  - Files: [specific component files]

---

- [ ] **11. End-to-End Integration Tests**

  **What to do:**
  Create comprehensive tests verifying both Electron and Web modes work correctly.

  Tests to create:
  1. WebSocket connection tests
  2. File upload/download tests
  3. IPC bridge compatibility tests
  4. Authentication tests
  5. Conversation flow tests

  **Files to create:**
  - `tests/integration/web/server.test.ts`
  - `tests/integration/web/websocket.test.ts`
  - `tests/integration/web/fileUpload.test.ts`
  - `tests/e2e/web/flows.spec.ts`

  **Recommended Agent Profile:**
  - **Category**: `deep`
  - **Skills**: None needed

  **Parallelization:**
  - **Can Run In Parallel**: YES (Wave 4)
  - **Blocks**: None
  - **Blocked By**: Tasks 1-10 (needs full implementation)

  **Acceptance Criteria:**
  - [ ] All integration tests pass
  - [ ] WebSocket tests verify connectivity
  - [ ] File upload tests verify HTTP endpoints
  - [ ] E2E tests cover main user flows

  **QA Scenarios:**

  ```
  Scenario: Full integration test suite
    Tool: Bash (bun test)
    Steps:
      1. Run `bun run test:integration`
      2. Check all tests pass
      3. Run `bun run test:e2e`
      4. Verify Playwright tests pass
    Expected Result: All tests green
    Evidence: .sisyphus/evidence/task-11-test-results.log
  ```

  **Commit**: YES
  - Message: `test: add integration and e2e tests for web mode`
  - Files: `tests/integration/web/`, `tests/e2e/web/`

---

- [ ] **12. Docker Configuration**

  **What to do:**
  Create Docker configuration for web deployment.

  Create:
  1. `Dockerfile` - Multi-stage build
  2. `docker-compose.yml` - Production deployment
  3. `.dockerignore` - Optimize build context

  **Implementation outline:**

  ```dockerfile
  # Dockerfile
  FROM node:20-alpine AS builder
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci
  COPY . .
  RUN npm run build:web && npm run build:server

  FROM node:20-alpine
  WORKDIR /app
  COPY --from=builder /app/dist ./dist
  COPY --from=builder /app/node_modules ./node_modules
  COPY package.json ./
  EXPOSE 3000
  CMD ["node", "dist/server/server.js"]
  ```

  **Recommended Agent Profile:**
  - **Category**: `quick`
  - **Skills**: None needed

  **Parallelization:**
  - **Can Run In Parallel**: YES (Wave 4)
  - **Blocks**: None
  - **Blocked By**: Task 6 (needs working build)

  **Acceptance Criteria:**
  - [ ] Docker image builds successfully
  - [ ] Container starts and serves web UI
  - [ ] WebSocket works in container
  - [ ] File upload works in container

  **QA Scenarios:**

  ```
  Scenario: Docker deployment works
    Tool: Bash (docker)
    Steps:
      1. Run `docker build -t aionui-web .`
      2. Run `docker run -p 3000:3000 aionui-web`
      3. Wait for container to start
      4. Curl: `curl http://localhost:3000`
      5. Open browser and test full functionality
    Expected Result: Container serves web UI, all features work
    Evidence: .sisyphus/evidence/task-12-docker-test.log
  ```

  **Commit**: YES
  - Message: `chore: add Docker configuration for web deployment`
  - Files: `Dockerfile`, `docker-compose.yml`, `.dockerignore`

---

- [ ] **13. Deployment Documentation**

  **What to do:**
  Create comprehensive deployment documentation.

  Create:
  1. `docs/web-deployment.md` - Setup and deployment guide
  2. `docs/web-architecture.md` - Architecture overview
  3. `docs/web-troubleshooting.md` - Common issues and solutions

  **Documentation outline:**

  ````markdown
  # Web Deployment Guide

  ## Quick Start

  ```bash
  bun run dev:server  # Terminal 1
  bun run dev:web     # Terminal 2
  ```
  ````

  ## Production Deployment

  ### Docker

  ```bash
  docker-compose up -d
  ```

  ### Manual

  ```bash
  bun run build:web
  bun run build:server
  bun run start:web
  ```

  ## Architecture
  - Server: Node.js + Express + WebSocket
  - Frontend: React + Vite (web build)
  - Database: SQLite (same as Electron)
  - Communication: WebSocket (replaces Electron IPC)

  ```

  **Recommended Agent Profile:**
  - **Category**: `writing`
  - **Skills**: None needed

  **Parallelization:**
  - **Can Run In Parallel**: YES (Wave 4)
  - **Blocks**: None
  - **Blocked By**: None

  **Acceptance Criteria:**
  - [ ] Quick start guide works for new developers
  - [ ] Production deployment steps documented
  - [ ] Architecture explained clearly
  - [ ] Troubleshooting section covers common issues

  **Commit**: YES
  - Message: `docs: add web deployment documentation`
  - Files: `docs/web-deployment.md`, `docs/web-architecture.md`, `docs/web-troubleshooting.md`
  ```

---

- [ ] **14. Final Verification**

  **What to do:**
  Comprehensive verification that both modes work and no unintended modifications were made.

  Verification checklist:
  1. **Electron mode still works**
     - `bun run start` starts Electron app
     - All features functional
     - No console errors
  2. **Web mode works**
     - `bun run dev:server` + `bun run dev:web`
     - All features functional
     - WebSocket connection stable
  3. **No unintended file modifications**
     - Compare with upstream: only package.json scripts changed
     - All other modifications are NEW files only
  4. **Upstream sync test**
     - `git fetch upstream`
     - `git rebase upstream/main`
     - Verify no conflicts

  **Recommended Agent Profile:**
  - **Category**: `deep`
  - **Skills**: None needed

  **Parallelization:**
  - **Can Run In Parallel**: NO (Wave 4 final task)
  - **Blocks**: Final review tasks
  - **Blocked By**: Tasks 1-13

  **Acceptance Criteria:**
  - [ ] Electron mode fully functional
  - [ ] Web mode fully functional
  - [ ] Only 3 files modified (package.json + 2 others max)
  - [ ] 10+ new files created
  - [ ] Upstream rebase produces no conflicts
  - [ ] All tests pass

  **QA Scenarios:**

  ```
  Scenario: Both modes work side-by-side
    Tool: Bash + Browser
    Steps:
      1. Test Electron: `bun run start` - verify app opens
      2. Close Electron
      3. Test Web: `bun run dev:server` & `bun run dev:web`
      4. Open browser, verify all features
      5. Run git diff against upstream
      6. Verify only expected files modified
    Expected Result: Both modes work, minimal file modifications
    Evidence: .sisyphus/evidence/task-14-final-verification.log
  ```

  **Commit**: NO (verification task)

---

## Final Verification Wave

> **CRITICAL**: Verify NO unintended modifications to existing files

- [ ] **F1. Plan Compliance Audit - `oracle`**

  Check: ONLY these files should be modified:
  - `package.json` (scripts only)
  - `src/webserver/routes/apiRoutes.ts` (add file upload routes)
  - 1-2 specific components for file upload integration

  ALL other changes must be NEW files only.

  Output: `Modified: [list] | New: [list] | VERDICT`

- [ ] **F2. Upstream Sync Verification - `git-master`**

  Test daily upstream sync workflow:

  ```bash
  git fetch upstream
  git rebase upstream/main
  ```

  Should produce ZERO conflicts (except possibly package.json if upstream changed scripts).

  Output: `Conflicts: [0 or list] | VERDICT`

- [ ] **F3. Code Quality Review - `unspecified-high`**

  Run quality checks:

  ```bash
  bun run lint
  bun run test
  bunx tsc --noEmit
  ```

  Output: `Lint [PASS/FAIL] | Tests [N/N pass] | Types [PASS/FAIL] | VERDICT`

- [ ] **F4. Scope Fidelity Check - `deep`**

  Verify deliverables:
  - [ ] server.ts exists and works
  - [ ] web-entry.tsx exists and works
  - [ ] vite.web.config.ts exists
  - [ ] File upload endpoints work
  - [ ] Docker config works
  - [ ] Documentation complete

  Output: `Deliverables [N/N] | VERDICT`

---

## Commit Strategy

### Commits by Task

1. Task 1: `feat(web): add server.ts entry point for web deployment`
2. Task 2: `build: add vite.web.config.ts for web builds`
3. Task 3: `chore: add npm scripts for web development`
4. Task 5: `feat(web): add web renderer entry point`
5. Task 6: `build: configure server TypeScript and build pipeline`
6. Task 8: `feat(web): add file upload/download HTTP endpoints`
7. Task 9: `feat(web): add file upload UI components for web mode`
8. Task 10: `feat(web): integrate file upload in web mode`
9. Task 11: `test: add integration and e2e tests for web mode`
10. Task 12: `chore: add Docker configuration for web deployment`
11. Task 13: `docs: add web deployment documentation`

### Total Commits: 11

---

## Success Criteria

### Verification Commands

```bash
# 1. Electron mode (unchanged)
bun run start
# Expected: Electron app opens, fully functional

# 2. Web mode development
bun run dev:server  # Terminal 1
bun run dev:web     # Terminal 2
# Expected: Web UI at http://localhost:5173, WebSocket connected

# 3. Web mode production
bun run build:web
bun run build:server
bun run start:web
# Expected: Production build at http://localhost:3000

# 4. Docker deployment
docker-compose up --build
# Expected: Containerized deployment works

# 5. Tests
bun run test
# Expected: All tests pass

# 6. Upstream sync
git fetch upstream
git rebase upstream/main
# Expected: No conflicts (or only package.json scripts)
```

### Final Checklist

- [ ] Only 3 files modified in existing codebase
- [ ] 10+ new files created
- [ ] Electron mode 100% functional
- [ ] Web mode 100% functional
- [ ] All 100+ IPC bridges work in both modes
- [ ] File upload works in web mode
- [ ] Docker deployment works
- [ ] Documentation complete
- [ ] Tests pass
- [ ] Upstream sync produces no conflicts

---

## Upstream Sync Strategy

### Daily Workflow

```bash
# Each morning, sync with upstream
git fetch upstream
git rebase upstream/main

# If conflicts in package.json (scripts):
# - Keep upstream changes
# - Manually re-add web scripts
# - Commit: `chore: resolve package.json conflicts after rebase`

# If conflicts elsewhere:
# - THIS SHOULD NOT HAPPEN
# - Indicates unintended file modification
# - Review and fix immediately
```

### Branch Strategy

```bash
# Feature branch approach
main                    # Your main branch (syncs with upstream)
  └── feat/web-mode     # Web migration work

# Workflow:
# 1. Do all work in feat/web-mode
# 2. Daily: rebase feat/web-mode onto main
# 3. When ready: merge feat/web-mode into main
```

### Conflict Prevention

By keeping modifications minimal:

- **package.json**: Only scripts section touched
  - Low conflict probability (unless upstream changes scripts)
  - Easy resolution: accept upstream, re-add web scripts
- **All other files**: NEW only
  - Zero conflict probability
  - Never touched by upstream

---

## Architecture Comparison

### Original Plan (High Conflict Risk)

```
Modified Files (~25):
- src/index.ts              ⚠️ HIGH conflict (core entry point)
- src/preload.ts            ⚠️ HIGH conflict (Electron API)
- src/renderer/index.tsx    ⚠️ HIGH conflict (renderer entry)
- src/webserver/...         ⚠️ MEDIUM conflict
- 20+ more files...

Result: Daily merge conflicts, difficult maintenance
```

### Revised Plan (Near-Zero Conflict Risk)

```
Modified Files (~3):
- package.json              ✓ LOW conflict (scripts only)
- src/webserver/routes/apiRoutes.ts  ✓ LOW conflict (adds routes)
- 1-2 component files        ✓ LOW conflict (conditional logic)

New Files (~10):
- src/server.ts             ✓ NO conflict (new)
- src/renderer/web-entry.tsx ✓ NO conflict (new)
- vite.web.config.ts        ✓ NO conflict (new)
- src/webserver/routes/fileUploadRoutes.ts ✓ NO conflict (new)
- src/renderer/components/web/... ✓ NO conflict (new)
- tsconfig.server.json      ✓ NO conflict (new)
- Dockerfile               ✓ NO conflict (new)
- docs/web-*.md            ✓ NO conflict (new)

Result: Easy upstream sync, minimal maintenance burden
```

---

## Conclusion

This revised plan prioritizes **upstream compatibility** over quick implementation. By using an additive-only approach:

1. **Zero merge conflicts** with daily upstream updates
2. **Dual-mode deployment** - Electron and Web from same codebase
3. **Minimal risk** - existing functionality untouched
4. **Faster timeline** - 8-10 days vs 17 days (fewer files to modify)

The key insight is that AionUi's existing architecture (WebSocket support in browser.ts, separate webserver module) already supports web deployment. We just need to:

- Add server entry point (NEW file)
- Add web renderer entry (NEW file)
- Add file upload endpoints (NEW routes)
- Add minimal npm scripts (MODIFY 1 file)

Everything else stays exactly as-is.

---

## Ready to Execute

To begin implementation, run:

```bash
/start-work aionui-web-migration
```

This will:

1. Register the plan as your active boulder
2. Track progress across sessions
3. Begin with Task 1 (Create Server Entry Point)
4. Ensure all work follows additive-only principle
