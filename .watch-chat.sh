#!/usr/bin/env bash
LOG_DIR="$HOME/.openclaw/agent-chats/logs"
TODAY=$(date +%Y-%m-%d)
while true; do
    clear
    echo -e "\033[1m\033[36m"
    echo "  ╔══════════════════════════════════════════════════════╗"
    echo "  ║        🦞 OpenClaw — Agent Chat Monitor             ║"
    echo "  ║        $(date +%Y-%m-%d' '%H:%M:%S)                            ║"
    echo "  ╚══════════════════════════════════════════════════════╝"
    echo -e "\033[0m"
    echo ""
    for f in "$LOG_DIR"/${TODAY}-*.md; do
        [[ -f "$f" ]] && cat "$f" && echo ""
    done
    sleep 2
done
