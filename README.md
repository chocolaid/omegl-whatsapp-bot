# WhatsApp Bot Worker

This is a separate worker process that handles WhatsApp notifications using whatsapp-web.js.

## Why Separate Process?

WhatsApp Web.js requires:
- A persistent connection to WhatsApp servers
- Puppeteer/Chromium for headless browser
- Session persistence across restarts

Vercel's serverless functions are stateless and have execution time limits, making them unsuitable for maintaining a persistent WhatsApp connection.

## Architecture

```
┌─────────────────────┐     ┌─────────────────┐     ┌─────────────────────┐
│  Main Vercel App    │────>│   Redis Queue   │────>│  WhatsApp Worker    │
│  (queues jobs)      │     │   (BullMQ)      │     │  (processes jobs)   │
└─────────────────────┘     └─────────────────┘     └─────────────────────┘
```

---

## VPS Deployment (Recommended)

### Prerequisites

- Ubuntu 20.04+ VPS
- Node.js 20+
- Your PostgreSQL and Redis connection strings

### Quick Setup

```bash
# 1. SSH into your VPS
ssh user@your-vps-ip

# 2. Create directory
mkdir -p ~/whatsapp-bot
cd ~/whatsapp-bot

# 3. Copy files from your local machine (run this locally)
scp -r workers/whatsapp-bot/* user@your-vps-ip:~/whatsapp-bot/

# 4. Back on VPS - Install dependencies
sudo apt-get update
sudo apt-get install -y nodejs npm chromium-browser

# 5. Install Chromium dependencies
sudo apt-get install -y gconf-service libasound2 libatk1.0-0 libatk-bridge2.0-0 \
  libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 \
  libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 \
  libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 \
  libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
  libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates \
  fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget

# 6. Configure environment
cp .env.example .env
nano .env  # Add your DATABASE_URL, REDIS_URL

# 7. Install and build
npm install
npx prisma generate
npm run build

# 8. Install PM2
sudo npm install -g pm2

# 9. Start with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # Follow the instructions to enable on boot

# 10. Check logs
pm2 logs whatsapp-bot
```

### Connect WhatsApp

1. Open browser: `http://your-vps-ip:3001/qr-page`
2. Scan QR code with your phone (WhatsApp > Linked Devices)
3. **Configure via WhatsApp commands** (see below)

---

## Bot Commands (via WhatsApp)

The bot accepts commands from the **sudo user** (configured in `.env` as `SUDO_USER_NUMBER`).

Simply send a message to the bot's WhatsApp number:

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/groups` | List all groups/communities the bot is in |
| `/status` | Show current configuration and stats |
| `/set <id>` | Set target group for notifications |
| `/set <id1>,<id2>` | Set multiple target groups (comma-separated) |
| `/clear` | Clear target groups (send to individual phones) |
| `/test` | Send a test message to configured groups |
| `/ping` | Check if bot is alive |

### Example Usage

1. **Find your announcement group:**
   ```
   You: /groups
   Bot: 📋 Groups (3)
        1. OMEGL Team
           120363012345678901@g.us
        2. OMEGL Announcements
           120363098765432109@g.us
        ...
   ```

2. **Set as target:**
   ```
   You: /set 120363098765432109@g.us
   Bot: 🎯 Target Groups Updated
        ✅ OMEGL Announcements
   ```

3. **Send to multiple groups:**
   ```
   You: /set 120363098765432109@g.us,120363012345678901@g.us
   Bot: 🎯 Target Groups Updated
        ✅ OMEGL Announcements
        ✅ OMEGL Team
   ```

4. **Test the configuration:**
   ```
   You: /test
   Bot: ✅ Test message sent to 2 group(s)
   ```

### Sudo User

Only the phone number configured as `SUDO_USER_NUMBER` in `.env` can send commands to the bot. Default: `2348027329153`

---

## Legacy: HTTP Endpoints

You can also manage via HTTP:

### Test Sending

```bash
# Test send to group
curl -X POST http://your-vps-ip:3001/test-send \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from OMEGL Bot!"}'
```

---

## Community/Group Setup

If you want all notifications to go to a WhatsApp community announcement channel:

1. **Add the bot** to your community as admin
2. **Get the group ID**: Visit `http://your-vps-ip:3001/groups`
3. **Find your announcement group** in the list (look for `isReadOnly: true`)
4. **Copy the ID** (format: `123456789@g.us`)
5. **Set environment variable**:
   ```bash
   WHATSAPP_GROUP_ID=123456789@g.us
   ```
6. **Restart the bot**: `pm2 restart whatsapp-bot`

---

## Notification Types

| Type | Trigger | Recipient |
|------|---------|-----------|
| `ORDER_CREATED` | New order placed | Customer |
| `STATUS_UPDATED` | Order status changes | Customer |
| `CREDIT_DUE_REMINDER` | Credit payment overdue | Customer |
| `APPROVAL_REMINDER` | Pending approvals | Managers |

## API Endpoints

### Main App (Vercel)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/whatsapp/scan-qr` | GET | Get QR code or connection status |
| `/api/whatsapp/status` | GET | Detailed status and config |
| `/api/whatsapp/status` | PUT | Update notification config |
| `/api/whatsapp/send` | POST | Queue a notification |
| `/api/cron/whatsapp-reminders` | GET | Trigger daily reminders |

### Worker Process

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/qr` | GET | QR code as JSON |
| `/qr-page` | GET | QR code as HTML page |
| `/status` | GET | Connection and queue status |

## Vercel Cron Configuration

Add to `vercel.json`:

```json
{
  "crons": [{
    "path": "/api/cron/whatsapp-reminders",
    "schedule": "0 9 * * *"
  }]
}
```

This runs daily reminders at 9:00 AM.

## Database Models

The worker uses these Prisma models:

- **WhatsAppSession**: Stores QR code and connection state
- **WhatsAppNotification**: Logs all notifications and their status
- **WhatsAppConfig**: Global notification settings

## Security

- QR code endpoints are protected (managers and CEO only)
- Config updates require CEO role
- Phone numbers are normalized and validated
- Session data is stored securely in the database

## Troubleshooting

### QR Code Not Appearing

1. Check worker logs for Puppeteer errors
2. Ensure Chromium dependencies are installed
3. On Linux: `apt-get install -y chromium`

### Messages Not Sending

1. Check if WhatsApp is connected: `/status`
2. Check Redis connection
3. Verify phone numbers are in Nigerian format (234XXXXXXXXXX)

### Session Lost After Restart

1. Check if `whatsapp-session` directory persists
2. For Railway/Render: Use persistent storage
3. Session is also backed up to database

## Rate Limiting

The worker includes built-in rate limiting:
- Max 10 messages per minute
- 1 second delay between messages
- 3 retry attempts with exponential backoff
