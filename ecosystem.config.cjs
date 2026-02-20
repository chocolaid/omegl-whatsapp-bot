// PM2 Ecosystem File for WhatsApp Bot (CommonJS for PM2 compatibility)
// Use: pm2 start ecosystem.config.cjs

module.exports = {
  apps: [{
    name: "whatsapp-bot",
    script: "npm",
    args: "start",
    cwd: "/home/ubuntu/whatsapp-bot",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "500M",
    env: {
      NODE_ENV: "production",
      PORT: 3001,
      // These should be set in .env file on the server
      // POSTGRES_URL: "",
      // DATABASE_URL: "",
      // REDIS_URL: "",
      // WHATSAPP_GROUP_ID: ""
    },
    error_file: "./logs/error.log",
    out_file: "./logs/out.log",
    log_file: "./logs/combined.log",
    time: true,
  }]
};
