// PM2 Ecosystem File for WhatsApp Bot
// Use: pm2 start ecosystem.config.js

module.exports = {
  apps: [{
    name: 'whatsapp-bot',
    script: 'dist/index.js',
    cwd: '/home/ubuntu/whatsapp-bot', // Change to your bot directory
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
  }],
};
