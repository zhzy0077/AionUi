# AionUi WebUI with AI Agents
# Pre-installed: Claude Code, Opencode, Kimi CLI, Copilot

FROM debian:trixie

# Prevent interactive prompts during apt
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# Install system dependencies
# - Xvfb for virtual display (Electron needs display server)
# - Audio libraries for Electron
# - Node.js dependencies
# - curl/wget for downloading
RUN apt-get update && apt-get install -y \
    # X11 and display
    xvfb \
    libxkbcommon-x11-0 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxrandr2 \
    libxi6 \
    libxtst6 \
    # Audio
    libasound2 \
    # GPU/Graphics
    libgbm1 \
    libdrm2 \
    libegl1 \
    libgl1-mesa-glx \
    # NSS/SSL for Chromium
    libnss3 \
    libxss1 \
    # GTK for Electron
    libgtk-3-0 \
    # Utilities
    curl \
    wget \
    ca-certificates \
    git \
    sqlite3 ripgrep gh \
    # Node.js will be installed separately
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Verify Node.js installation
RUN node --version && npm --version

# Configure npm global directory for root user
ENV NPM_CONFIG_PREFIX=/usr/local
ENV PATH=$NPM_CONFIG_PREFIX/bin:$PATH

# Install AI Agent CLI tools globally
# Note: Some tools may require authentication during first use

# 1. Claude Code (Anthropic)
RUN npm install -g @anthropic-ai/claude-code

# 2. Opencode (OpenCode)
RUN npm install -g opencode-ai

# 3. Kimi CLI (Moonshot)
RUN curl -LsSf https://code.kimi.com/install.sh | bash

# 4. GitHub Copilot CLI
RUN npm install -g @github/copilot-cli

# Install AionUi
# Download latest release
RUN wget -q --show-progress \
    https://github.com/iOfficeAI/AionUi/releases/latest/download/AionUi-linux-amd64.deb \
    -O /tmp/AionUi-linux-amd64.deb \
    && dpkg -i /tmp/AionUi-linux-amd64.deb || apt-get install -f -y \
    && rm /tmp/AionUi-linux-amd64.deb

# Create workspace directory
RUN mkdir -p /workspace && chmod 777 /workspace

# Set working directory
WORKDIR /workspace

# Environment variables for AionUi
ENV AIONUI_PORT=25808
ENV AIONUI_ALLOW_REMOTE=true

# Expose the WebUI port
EXPOSE 25808

# Create startup script
RUN cat > /usr/local/bin/start-aionui.sh << 'EOF'
#!/bin/bash
set -e

# Check if running in headless environment
if [ -z "$DISPLAY" ]; then
    echo "Starting AionUi in headless mode with Xvfb..."
    exec xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
        /usr/bin/AionUi --webui --remote --no-sandbox "$@"
else
    echo "Starting AionUi with display..."
    exec /usr/bin/AionUi --webui --remote --no-sandbox "$@"
fi
EOF

RUN chmod +x /usr/local/bin/start-aionui.sh

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:25808/health || exit 1

# Default command
CMD ["/usr/local/bin/start-aionui.sh"]
