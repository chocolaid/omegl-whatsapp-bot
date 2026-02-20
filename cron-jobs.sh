#!/bin/bash
# OMEGL Cron Jobs - Triggered from EC2 instead of Vercel
# 
# This script calls the Vercel API endpoints to trigger cron jobs.
# Set APP_URL and CRON_SECRET in your environment or .env file.

# Load environment if .env exists
if [ -f /home/ubuntu/whatsapp-bot/.env ]; then
  export $(grep -v '^#' /home/ubuntu/whatsapp-bot/.env | xargs)
fi

APP_URL="${APP_URL:-https://omegl-eight.vercel.app}"
CRON_SECRET="${CRON_SECRET:-}"

LOG_FILE="/home/ubuntu/whatsapp-bot/logs/cron.log"

# Function to call API endpoint
call_api() {
  local endpoint=$1
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Calling $endpoint" >> "$LOG_FILE"
  
  if [ -n "$CRON_SECRET" ]; then
    response=$(curl -s -X POST "$APP_URL$endpoint" -H "Authorization: Bearer $CRON_SECRET" 2>&1)
  else
    response=$(curl -s -X POST "$APP_URL$endpoint" 2>&1)
  fi
  
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Response: $(echo $response | head -c 200)" >> "$LOG_FILE"
}

case "$1" in
  daily-opening)
    call_api "/api/cron/daily-opening"
    ;;
  pending-reminder)
    call_api "/api/cron/pending-approval-reminder"
    ;;
  daily-closing)
    call_api "/api/cron/daily-closing-reminder"
    ;;
  daily-summary)
    call_api "/api/cron/daily-summary"
    ;;
  whatsapp-reminders)
    call_api "/api/cron/whatsapp-reminders"
    ;;
  *)
    echo "Usage: $0 {daily-opening|pending-reminder|daily-closing|daily-summary|whatsapp-reminders}"
    exit 1
    ;;
esac
