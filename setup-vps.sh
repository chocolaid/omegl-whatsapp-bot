#!/bin/bash
# VPS Setup Script for WhatsApp Bot
# Run this on your VPS server

set -e

echo "=========================================="
echo "  OMEGL WhatsApp Bot - VPS Setup"
echo "=========================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo ./setup-vps.sh)"
  exit 1
fi

# Get the username for the service
read -p "Enter the username to run the bot (e.g., ubuntu, root): " BOT_USER
read -p "Enter the full path to the bot directory (e.g., /home/ubuntu/whatsapp-bot): " BOT_DIR

# Update system
echo "📦 Updating system packages..."
apt-get update
apt-get upgrade -y

# Install Node.js 20
echo "📦 Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install Chromium dependencies for Puppeteer
echo "📦 Installing Chromium dependencies..."
apt-get install -y \
  gconf-service \
  libasound2 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libc6 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libexpat1 \
  libfontconfig1 \
  libgcc1 \
  libgconf-2-4 \
  libgdk-pixbuf2.0-0 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libstdc++6 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxss1 \
  libxtst6 \
  ca-certificates \
  fonts-liberation \
  libappindicator1 \
  libnss3 \
  lsb-release \
  xdg-utils \
  wget \
  chromium-browser

# Install PM2 globally
echo "📦 Installing PM2..."
npm install -g pm2

# Create systemd service
echo "📝 Creating systemd service..."
cat > /etc/systemd/system/whatsapp-bot.service << EOF
[Unit]
Description=OMEGL WhatsApp Bot
After=network.target

[Service]
Type=simple
User=${BOT_USER}
WorkingDirectory=${BOT_DIR}
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=whatsapp-bot
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd
systemctl daemon-reload

echo ""
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Copy the bot files to: ${BOT_DIR}"
echo "   scp -r workers/whatsapp-bot/* ${BOT_USER}@your-vps:${BOT_DIR}/"
echo ""
echo "2. SSH into your VPS and run:"
echo "   cd ${BOT_DIR}"
echo "   cp .env.example .env"
echo "   # Edit .env with your credentials"
echo "   nano .env"
echo ""
echo "3. Install dependencies and build:"
echo "   npm install"
echo "   npx prisma generate"
echo "   npm run build"
echo ""
echo "4. Start the service:"
echo "   sudo systemctl enable whatsapp-bot"
echo "   sudo systemctl start whatsapp-bot"
echo ""
echo "5. Check status:"
echo "   sudo systemctl status whatsapp-bot"
echo "   sudo journalctl -u whatsapp-bot -f"
echo ""
echo "6. Open in browser to scan QR:"
echo "   http://your-vps-ip:3001/qr-page"
echo ""
echo "7. Find your group ID:"
echo "   http://your-vps-ip:3001/groups"
echo ""
