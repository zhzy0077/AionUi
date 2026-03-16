#!/bin/bash
set -e

# AionUi Docker Entrypoint Script
# Handles headless mode detection and startup

# Configuration
AIONUI_BIN="/usr/bin/AionUi"
XVFB_ARGS="-screen 0 1920x1080x24"
DEFAULT_PORT="${AIONUI_PORT:-25808}"

# Function to check if Xvfb is needed
detect_display() {
    if [ -z "$DISPLAY" ]; then
        return 1  # No display, need Xvfb
    else
        return 0  # Display available
    fi
}

# Function to check CLI tools
check_agents() {
    echo "Checking installed AI Agents..."
    
    agents=("claude" "opencode" "gh")
    
    for agent in "${agents[@]}"; do
        if command -v "$agent" &> /dev/null; then
            version=$($agent --version 2>/dev/null | head -1 || echo "version unknown")
            echo "  ✓ $agent: $version"
        else
            echo "  ✗ $agent: not found"
        fi
    done
    
    # Check for Kimi
    if command -v kimi &> /dev/null; then
        echo "  ✓ kimi: installed"
    else
        echo "  ✗ kimi: not found (may need manual install)"
    fi
}

# Function to setup config directory
setup_config() {
    CONFIG_DIR="${AIONUI_CONFIG_DIR:-/config}"
    
    # Create config directory structure
    mkdir -p "$CONFIG_DIR"
    
    # Set environment for AionUi to use this config
    export HOME="$CONFIG_DIR"
    
    echo "Config directory: $CONFIG_DIR"
}

# Main startup logic
main() {
    echo "========================================"
    echo "AionUi WebUI Container"
    echo "========================================"
    
    # Setup config
    setup_config
    
    # Check installed agents
    check_agents
    
    # Detect display environment
    if detect_display; then
        echo "Display detected: $DISPLAY"
        USE_XVFB=false
    else
        echo "No display detected, using Xvfb virtual display"
        USE_XVFB=true
    fi
    
    echo ""
    echo "Starting AionUi WebUI..."
    echo "Port: $DEFAULT_PORT"
    echo "Remote access: enabled"
    echo "========================================"
    
    # Build command
    if [ "$USE_XVFB" = true ]; then
        echo "Launching with Xvfb..."
        exec xvfb-run --auto-servernum --server-args="$XVFB_ARGS" \
            "$AIONUI_BIN" "$@"
    else
        echo "Launching directly..."
        exec "$AIONUI_BIN" "$@"
    fi
}

# Handle signals gracefully
trap 'echo "Received signal, shutting down..."; exit 0' SIGTERM SIGINT

# Run main function
main "$@"
