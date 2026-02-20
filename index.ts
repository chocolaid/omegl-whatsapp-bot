/**
 * WhatsApp Bot Worker
 * 
 * This worker runs as a separate process (not on Vercel) and handles:
 * 1. WhatsApp Web.js client with persistent session
 * 2. BullMQ job processing for notifications
 * 3. HTTP server for QR code display and health checks
 * 
 * Deploy this to Railway, Render, or any VPS with persistent storage.
 */
//@ts-nocheck
import 'dotenv/config';
import express from 'express';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import puppeteer from 'puppeteer';
import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import QRCode from 'qrcode';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// Express types - using any since express is installed separately in worker
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Request = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Response = any;

// Types
interface WhatsAppJobData {
  notificationId: string;
  type: string;
  recipientPhone: string;
  recipientName?: string;
  subject?: string;
  message: string;
  orderSheetUrl?: string; // URL to fetch order sheet HTML
  metadata?: Record<string, unknown>;
}

// WhatsApp client type (since whatsapp-web.js doesn't have good TS types)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WhatsAppClient = any;

// Initialize Prisma with pg adapter (required for Prisma 7+)
const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL!;
const pool = new Pool({ connectionString, max: 5 });
const adapter = new PrismaPg(pool);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma = new PrismaClient({ adapter }) as any;
const app = express();
const PORT = process.env.PORT || 3001;

// Redis connection for BullMQ
const redisConnection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// WhatsApp client state
let whatsappClient: WhatsAppClient | null = null;
let currentQrCode: string | null = null;
let isClientReady = false;
let lastError: string | null = null;

// Sudo user - only this number can send commands to the bot
const SUDO_USER = process.env.SUDO_USER_NUMBER || '2348027329153';

/**
 * Get target group IDs from database or environment
 */
async function getTargetGroupIds(): Promise<string[]> {
  // First check database config
  const config = await prisma.whatsAppConfig.findFirst();
  if (config?.targetGroupIds && config.targetGroupIds.length > 0) {
    return config.targetGroupIds;
  }
  
  // Fallback to environment variable
  const envGroupId = process.env.WHATSAPP_GROUP_ID;
  if (envGroupId) {
    return envGroupId.split(',').map((id: string) => id.trim()).filter(Boolean);
  }
  
  return [];
}

/**
 * Set target group IDs in database
 */
async function setTargetGroupIds(groupIds: string[]): Promise<void> {
  // Ensure IDs have proper format
  const formattedIds = groupIds.map(id => 
    id.includes('@') ? id : `${id}@g.us`
  );
  
  // Update or create config
  const existingConfig = await prisma.whatsAppConfig.findFirst();
  if (existingConfig) {
    await prisma.whatsAppConfig.update({
      where: { id: existingConfig.id },
      data: { targetGroupIds: formattedIds },
    });
  } else {
    await prisma.whatsAppConfig.create({
      data: {
        enabled: true,
        targetGroupIds: formattedIds,
      },
    });
  }
}

/**
 * Handle incoming commands from sudo user
 */
async function handleCommand(message: any): Promise<void> {
  const chat = await message.getChat();
  const contact = await message.getContact();
  const senderId = contact.id.user || message.from.replace('@c.us', '');
  const body = message.body.trim();
  
  // Only process commands from sudo user
  if (senderId !== SUDO_USER) {
    console.log(`⚠️ Ignoring message from non-sudo user: ${senderId}`);
    return;
  }
  
  // Only process commands (starting with /)
  if (!body.startsWith('/')) {
    return;
  }
  
  console.log(`📩 Command from sudo user: ${body}`);
  
  const [command, ...args] = body.split(' ');
  const arg = args.join(' ').trim();
  
  try {
    switch (command.toLowerCase()) {
      case '/help':
      case '/h':
        await chat.sendMessage(`🤖 *OMEGL Bot Commands*\n\n` +
          `/help - Show this help message\n` +
          `/groups - List all groups I'm in\n` +
          `/status - Show current configuration\n` +
          `/set <id1,id2,...> - Set target group(s) for notifications\n` +
          `/clear - Clear all target groups (disable group notifications)\n` +
          `/test - Send a test message to current targets\n` +
          `/ping - Check if bot is alive`
        );
        break;
        
      case '/groups':
      case '/g':
        const chats = await whatsappClient.getChats();
        const groups = chats
          .filter((c: any) => c.isGroup)
          .map((c: any, index: number) => ({
            num: index + 1,
            id: c.id._serialized,
            name: c.name,
          }));
        
        if (groups.length === 0) {
          await chat.sendMessage('❌ Bot is not in any groups');
        } else {
          let response = `📋 *Groups (${groups.length})*\n\n`;
          groups.forEach((g: any) => {
            response += `*${g.num}.* ${g.name}\n`;
          });
          response += `\n💡 *To set target group:*\n`;
          response += `/set 1 (by number)\n`;
          response += `/set OMEGL (by name)\n`;
          response += `/set 1,2,3 (multiple)`;
          await chat.sendMessage(response);
        }
        break;
        
      case '/status':
      case '/s':
        const targetIds = await getTargetGroupIds();
        const pendingCount = await prisma.whatsAppNotification.count({
          where: { status: 'PENDING' },
        });
        const sentToday = await prisma.whatsAppNotification.count({
          where: {
            status: 'SENT',
            sentAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          },
        });
        
        let targetNames = 'None (sending to individual phones)';
        if (targetIds.length > 0) {
          const groupChats = await whatsappClient.getChats();
          const targetGroups = targetIds.map((id: string) => {
            const group = groupChats.find((c: any) => c.id._serialized === id);
            return group ? group.name : id;
          });
          targetNames = targetGroups.join(', ');
        }
        
        await chat.sendMessage(
          `📊 *Bot Status*\n\n` +
          `✅ Connected: Yes\n` +
          `📨 Pending: ${pendingCount}\n` +
          `📤 Sent Today: ${sentToday}\n` +
          `⏱️ Uptime: ${Math.floor(process.uptime() / 60)} mins\n\n` +
          `🎯 *Target Groups:*\n${targetNames}\n\n` +
          `🔑 Sudo User: ${SUDO_USER}`
        );
        break;
        
      case '/set':
        if (!arg) {
          await chat.sendMessage('❌ Please provide group name, number, or ID\n\nUsage:\n`/set 1` (by number from /groups)\n`/set OMEGL` (by name)\n`/set 1,2` (multiple)\n\nUse `/groups` to see available groups');
          return;
        }
        
        // Get all groups for matching
        const allChats = await whatsappClient.getChats();
        const allGroups = allChats
          .filter((c: any) => c.isGroup)
          .map((c: any, index: number) => ({
            num: index + 1,
            id: c.id._serialized,
            name: c.name,
            chat: c,
          }));
        
        const inputs = arg.split(',').map((s: string) => s.trim()).filter(Boolean);
        const matchedGroups: any[] = [];
        const notFound: string[] = [];
        
        for (const input of inputs) {
          let matched = false;
          
          // Try matching by number first
          const num = parseInt(input);
          if (!isNaN(num) && num >= 1 && num <= allGroups.length) {
            matchedGroups.push(allGroups[num - 1]);
            matched = true;
          }
          
          // Try matching by ID
          if (!matched) {
            const formattedId = input.includes('@') ? input : `${input}@g.us`;
            const byId = allGroups.find((g: any) => g.id === formattedId);
            if (byId) {
              matchedGroups.push(byId);
              matched = true;
            }
          }
          
          // Try matching by name (case-insensitive partial match)
          if (!matched) {
            const byName = allGroups.find((g: any) => 
              g.name.toLowerCase().includes(input.toLowerCase())
            );
            if (byName) {
              matchedGroups.push(byName);
              matched = true;
            }
          }
          
          if (!matched) {
            notFound.push(input);
          }
        }
        
        if (matchedGroups.length === 0) {
          await chat.sendMessage(`❌ No groups found matching: ${notFound.join(', ')}\n\nUse /groups to see available groups`);
          return;
        }
        
        // Save the matched group IDs
        const newIds = matchedGroups.map((g: any) => g.id);
        await setTargetGroupIds(newIds);
        
        // Build response
        let setResponse = `🎯 *Target Groups Set*\n\n`;
        matchedGroups.forEach((g: any) => {
          setResponse += `✅ ${g.name}\n`;
        });
        if (notFound.length > 0) {
          setResponse += `\n⚠️ Not found: ${notFound.join(', ')}`;
        }
        setResponse += `\n\nSending confirmation to group(s)...`;
        
        await chat.sendMessage(setResponse);
        
        // Send confirmation message to each set group
        const confirmMsg = `✅ *OMEGL Bot Connected*\n\n` +
          `This group has been set as a notification target.\n` +
          `You will receive order updates, reminders, and alerts here.\n\n` +
          `_Configured by sudo user at ${new Date().toLocaleString()}_`;
        
        for (const group of matchedGroups) {
          try {
            await whatsappClient.sendMessage(group.id, confirmMsg);
          } catch (err) {
            console.error(`Failed to send confirmation to ${group.name}:`, err);
          }
        }
        break;
        
      case '/clear':
        await setTargetGroupIds([]);
        await chat.sendMessage('✅ Target groups cleared.\nNotifications will be sent to individual phone numbers.');
        break;
        
      case '/test':
        const targets = await getTargetGroupIds();
        if (targets.length === 0) {
          await chat.sendMessage('❌ No target groups set. Use `/set <id>` first.');
          return;
        }
        
        const testMsg = `🧪 *Test Notification*\n\nThis is a test message from OMEGL Bot.\nTime: ${new Date().toLocaleString()}`;
        
        for (const targetId of targets) {
          try {
            await whatsappClient.sendMessage(targetId, testMsg);
          } catch (err) {
            await chat.sendMessage(`❌ Failed to send to ${targetId}: ${err}`);
          }
        }
        
        await chat.sendMessage(`✅ Test message sent to ${targets.length} group(s)`);
        break;
        
      case '/ping':
        await chat.sendMessage('🏓 Pong! Bot is alive and running.');
        break;
        
      default:
        await chat.sendMessage(`❓ Unknown command: ${command}\n\nType /help for available commands.`);
    }
  } catch (error) {
    console.error('❌ Error handling command:', error);
    await chat.sendMessage(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Initialize WhatsApp client
 */
async function initializeWhatsApp(): Promise<void> {
  console.log('🚀 Initializing WhatsApp client...');

  // Try to restore session from database
  const savedSession = await prisma.whatsAppSession.findFirst({
    orderBy: { updatedAt: 'desc' },
  });

  // Create client with LocalAuth for session persistence
  // Note: In production, you might want to use RemoteAuth with S3/GCS for session storage
  whatsappClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: './whatsapp-session',
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
  });

  // Event handlers
  whatsappClient.on('qr', async (qr: string) => {
    console.log('📱 QR Code received, scan it to connect');
    currentQrCode = qr;
    isClientReady = false;

    // Generate QR as data URL for web display
    const qrDataUrl = await QRCode.toDataURL(qr);

    // Save to database
    await prisma.whatsAppSession.upsert({
      where: { id: 'main' },
      create: {
        id: 'main',
        qrCode: qrDataUrl,
        isConnected: false,
      },
      update: {
        qrCode: qrDataUrl,
        isConnected: false,
      },
    });

    // Also print to terminal for local debugging
    QRCode.toString(qr, { type: 'terminal', small: true }, (err: Error | null, url: string) => {
      if (!err) console.log(url);
    });
  });

  whatsappClient.on('ready', async () => {
    console.log('✅ WhatsApp client is ready!');
    currentQrCode = null;
    isClientReady = true;
    lastError = null;

    // Update database
    await prisma.whatsAppSession.upsert({
      where: { id: 'main' },
      create: {
        id: 'main',
        isConnected: true,
        lastConnected: new Date(),
        qrCode: null,
      },
      update: {
        isConnected: true,
        lastConnected: new Date(),
        qrCode: null,
        lastError: null,
      },
    });
  });

  whatsappClient.on('authenticated', () => {
    console.log('🔐 WhatsApp authenticated');
  });

  whatsappClient.on('auth_failure', async (msg: string) => {
    console.error('❌ WhatsApp authentication failed:', msg);
    lastError = `Auth failed: ${msg}`;
    isClientReady = false;

    await prisma.whatsAppSession.upsert({
      where: { id: 'main' },
      create: {
        id: 'main',
        isConnected: false,
        lastError: lastError,
      },
      update: {
        isConnected: false,
        lastError: lastError,
      },
    });
  });

  whatsappClient.on('disconnected', async (reason: string) => {
    console.log('📴 WhatsApp disconnected:', reason);
    lastError = `Disconnected: ${reason}`;
    isClientReady = false;

    await prisma.whatsAppSession.upsert({
      where: { id: 'main' },
      create: {
        id: 'main',
        isConnected: false,
        lastError: lastError,
      },
      update: {
        isConnected: false,
        lastError: lastError,
      },
    });

    // Attempt to reconnect after delay
    setTimeout(() => {
      console.log('🔄 Attempting to reconnect...');
      whatsappClient?.initialize();
    }, 5000);
  });

  // Listen for incoming messages (for commands from sudo user)
  whatsappClient.on('message', async (message: any) => {
    try {
      await handleCommand(message);
    } catch (error) {
      console.error('❌ Error processing message:', error);
    }
  });

  // Initialize the client
  await whatsappClient.initialize();
}

// Company details for order sheet
const COMPANY_DETAILS = {
  name: 'OASIS MEGA GLOBAL LIMITED',
  phones: ['07026733340', '09048022165'],
  email: 'oasismegagloballtd@gmail.com',
  address: 'Nigeria Railway cooperation Plant Yard compound\nby the New Lagos State Oyingbo Train Station,\nEbute Metta.',
};

/**
 * Generate order sheet HTML from order data
 */
function generateOrderSheetHTML(order: {
  invoiceNumber: string;
  createdAt: Date;
  paymentType: string;
  paymentStatus: string;
  dueDate?: Date | null;
  notes?: string | null;
  customer?: { name: string; phone?: string | null } | null;
  createdBy?: { name: string } | null;
  items: Array<{
    product: { name: string };
    quantity: number;
    unitPrice: number | string;
    totalPrice: number | string;
  }>;
  totalAmount: number | string;
}): string {
  const date = new Date(order.createdAt).toLocaleDateString('en-NG', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Format money properly with Naira symbol (handles negative values)
  const formatMoney = (amount: number | string | null | undefined) => {
    if (amount == null) return '₦0';
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    const isNegative = num < 0;
    const absValue = Math.abs(num || 0);
    const formatted = absValue.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    return isNegative ? `-₦${formatted}` : `₦${formatted}`;
  };

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Arial, sans-serif; background: #fff; color: #111; padding: 40px; max-width: 800px; margin: 0 auto; }
        .header { text-align: center; border-bottom: 2px solid #111; padding-bottom: 20px; margin-bottom: 30px; }
        .company-name { font-size: 24px; font-weight: 700; margin-bottom: 8px; letter-spacing: 1px; }
        .company-contact { font-size: 12px; color: #444; line-height: 1.6; }
        .order-title { font-size: 18px; font-weight: 600; text-align: center; margin-bottom: 20px; text-transform: uppercase; letter-spacing: 2px; }
        .order-code { background: #f5f5f5; padding: 16px; border-radius: 8px; text-align: center; margin-bottom: 24px; }
        .order-code-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
        .order-code-value { font-size: 28px; font-weight: 700; font-family: monospace; }
        .section { margin-bottom: 24px; }
        .section-title { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
        .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .info-item { }
        .info-label { font-size: 11px; color: #888; margin-bottom: 2px; }
        .info-value { font-size: 14px; font-weight: 500; }
        table { width: 100%; border-collapse: collapse; margin-top: 12px; }
        th { background: #f5f5f5; padding: 10px 12px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
        td { padding: 12px; border-bottom: 1px solid #eee; font-size: 13px; }
        .text-right { text-align: right; }
        .total-row td { font-weight: 700; font-size: 15px; border-top: 2px solid #111; border-bottom: none; }
        .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #ddd; text-align: center; font-size: 11px; color: #888; }
        .payment-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
        .payment-cash { background: #d1fae5; color: #065f46; }
        .payment-credit { background: #dbeafe; color: #1e40af; }
        .notes { background: #fffbeb; padding: 12px; border-radius: 8px; font-size: 12px; color: #854d0e; margin-top: 16px; }
      </style>
    </head>
    <body>
      <div class="header">
        <div class="company-name">${COMPANY_DETAILS.name}</div>
        <div class="company-contact">
          Phone: ${COMPANY_DETAILS.phones.join(', ')}<br>
          Email: ${COMPANY_DETAILS.email}<br>
          ${COMPANY_DETAILS.address.replace(/\n/g, '<br>')}
        </div>
      </div>

      <div class="order-title">Order Receipt</div>

      <div class="order-code">
        <div class="order-code-label">Order Code</div>
        <div class="order-code-value">${order.invoiceNumber}</div>
      </div>

      <div class="section">
        <div class="section-title">Order Information</div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Date</div>
            <div class="info-value">${date}</div>
          </div>
          <div class="info-item">
            <div class="info-label">Payment Method</div>
            <div class="info-value">
              <span class="payment-badge ${order.paymentType === 'CASH' ? 'payment-cash' : 'payment-credit'}">
                ${order.paymentType}
              </span>
            </div>
          </div>
          <div class="info-item">
            <div class="info-label">Payment Status</div>
            <div class="info-value">
              <span class="payment-badge ${order.paymentStatus === 'PAID' ? 'payment-cash' : 'payment-credit'}">
                ${order.paymentStatus}
              </span>
            </div>
          </div>
          ${order.dueDate ? `
          <div class="info-item">
            <div class="info-label">Due Date</div>
            <div class="info-value">${new Date(order.dueDate).toLocaleDateString('en-NG')}</div>
          </div>
          ` : ''}
          <div class="info-item">
            <div class="info-label">Order Taken By</div>
            <div class="info-value">${order.createdBy?.name || 'System'}</div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Customer Details</div>
        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">Name</div>
            <div class="info-value">${order.customer?.name || 'Walk-in Customer'}</div>
          </div>
          ${order.customer?.phone ? `
          <div class="info-item">
            <div class="info-label">Phone</div>
            <div class="info-value">${order.customer.phone}</div>
          </div>
          ` : ''}
        </div>
      </div>

      <div class="section">
        <div class="section-title">Order Items</div>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th class="text-right">Qty</th>
              <th class="text-right">Unit Price</th>
              <th class="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            ${order.items.map(item => `
            <tr>
              <td>${item.product.name}</td>
              <td class="text-right">${item.quantity}</td>
              <td class="text-right">${formatMoney(item.unitPrice)}</td>
              <td class="text-right">${formatMoney(item.totalPrice)}</td>
            </tr>
            `).join('')}
            <tr class="total-row">
              <td colspan="3">Total Amount</td>
              <td class="text-right">${formatMoney(order.totalAmount)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      ${order.notes ? `
      <div class="notes">
        <strong>Notes:</strong> ${order.notes}
      </div>
      ` : ''}

      <div class="footer">
        Thank you for your business!<br>
        ${COMPANY_DETAILS.name}
      </div>
    </body>
    </html>
  `;
}

/**
 * Extract order ID from order sheet URL
 * URL format: https://domain.com/api/orders/{orderId}/sheet
 */
function extractOrderIdFromUrl(url: string): string | null {
  const match = url.match(/\/api\/orders\/([^/]+)\/sheet/);
  return match ? match[1] : null;
}

/**
 * Generate order sheet image from order ID
 * Uses database to fetch order data and Puppeteer to render HTML
 */
async function generateOrderSheetImage(orderSheetUrl: string): Promise<Buffer | null> {
  let browser = null;
  
  try {
    // Extract order ID from URL
    const orderId = extractOrderIdFromUrl(orderSheetUrl);
    if (!orderId) {
      console.error('❌ Could not extract order ID from URL:', orderSheetUrl);
      return null;
    }
    
    console.log(`📸 Generating order sheet for order: ${orderId}`);
    
    // Fetch order from database
    const order = await prisma.salesInvoice.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { name: true, phone: true } },
        createdBy: { select: { name: true } },
        items: {
          include: {
            product: { select: { name: true } },
          },
        },
      },
    });
    
    if (!order) {
      console.error('❌ Order not found:', orderId);
      return null;
    }
    
    console.log(`📦 Found order: ${order.invoiceNumber} with ${order.items.length} items`);
    
    // Generate HTML
    const html = generateOrderSheetHTML({
      invoiceNumber: order.invoiceNumber,
      createdAt: order.createdAt,
      paymentType: order.paymentType,
      paymentStatus: order.paymentStatus,
      dueDate: order.dueDate,
      notes: order.notes,
      customer: order.customer,
      createdBy: order.createdBy,
      items: order.items.map(item => ({
        product: item.product,
        quantity: Number(item.quantity),
        unitPrice: item.unitPrice,
        totalPrice: item.totalAmount, // Field is totalAmount in schema
      })),
      totalAmount: order.totalAmount,
    });
    
    console.log(`📄 Generated HTML (${html.length} chars), rendering image...`);
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
    
    const page = await browser.newPage();
    
    // Set viewport for a nice receipt size with high DPI for quality
    await page.setViewport({ width: 600, height: 800, deviceScaleFactor: 2 });
    
    // Load HTML directly
    await page.setContent(html, {
      waitUntil: 'networkidle0',
    });
    
    // Wait for content to render
    await page.waitForSelector('body', { timeout: 5000 });
    
    // Get the actual content height
    const bodyHandle = await page.$('body');
    const boundingBox = await bodyHandle?.boundingBox();
    
    if (boundingBox) {
      // Resize viewport to fit content
      await page.setViewport({ 
        width: 600, 
        height: Math.ceil(boundingBox.height) + 40,
        deviceScaleFactor: 2, // 2x resolution for crisp images
      });
    }
    
    // Take screenshot
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: true,
    });
    
    console.log('✅ Order sheet image generated successfully');
    return screenshot as Buffer;
    
  } catch (error) {
    console.error('❌ Error generating order sheet image:', error);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Send WhatsApp message to individual or group(s)
 * 
 * Chat ID formats:
 * - Individual: 234XXXXXXXXXX@c.us
 * - Group: XXXXXXXXXX@g.us  
 * - Community announcement: XXXXXXXXXX@g.us (same as group)
 * 
 * @param recipient - Phone number or group ID
 * @param message - Text message to send
 * @param mediaBuffer - Optional image buffer to send with message
 */
async function sendWhatsAppMessage(
  recipient: string, 
  message: string,
  mediaBuffer?: Buffer
): Promise<boolean> {
  if (!whatsappClient || !isClientReady) {
    throw new Error('WhatsApp client not ready');
  }

  // Prepare media if provided
  let media = null;
  if (mediaBuffer) {
    const base64 = mediaBuffer.toString('base64');
    media = new MessageMedia('image/png', base64, 'order-sheet.png');
    console.log('📎 Media attachment prepared');
  }

  // Get target group IDs from database or environment
  const targetGroupIds = await getTargetGroupIds();
  
  if (targetGroupIds.length > 0) {
    // Send to all configured groups
    console.log(`📢 Sending to ${targetGroupIds.length} group(s)`);
    
    let successCount = 0;
    for (const groupId of targetGroupIds) {
      try {
        if (media) {
          // Send image with caption
          const result = await whatsappClient.sendMessage(groupId, media, { caption: message });
          console.log(`✉️ Message with image sent to ${groupId}`, result?.id?._serialized || '');
        } else {
          const result = await whatsappClient.sendMessage(groupId, message);
          console.log(`✉️ Message sent to ${groupId}`, result?.id?._serialized || '');
        }
        successCount++;
      } catch (error) {
        console.error(`❌ Failed to send to ${groupId}:`, error);
      }
    }
    
    if (successCount === 0) {
      throw new Error('Failed to send to any target group');
    }
    
    return true;
  } else {
    // Send to individual phone number
    const chatId = `${recipient}@c.us`;
    
    try {
      // Check if number is registered on WhatsApp
      const isRegistered = await whatsappClient.isRegisteredUser(chatId);
      if (!isRegistered) {
        throw new Error(`Phone number ${recipient} is not registered on WhatsApp`);
      }
    } catch (regError) {
      console.warn(`⚠️ Could not verify registration for ${recipient}, attempting anyway...`);
    }

    try {
      // Send message
      if (media) {
        const result = await whatsappClient.sendMessage(chatId, media, { caption: message });
        console.log(`✉️ Message with image sent to ${chatId}`, result?.id?._serialized || '');
      } else {
        const result = await whatsappClient.sendMessage(chatId, message);
        console.log(`✉️ Message sent to ${chatId}`, result?.id?._serialized || '');
      }
      return true;
    } catch (error) {
      console.error(`❌ Failed to send message to ${chatId}:`, error);
      throw error;
    }
  }
}

/**
 * Initialize BullMQ worker
 */
function initializeWorker(): void {
  console.log('👷 Initializing BullMQ worker...');

  const worker = new Worker<WhatsAppJobData>(
    'whatsapp',
    async (job: Job<WhatsAppJobData>) => {
      console.log(`📨 Processing job ${job.id}: ${job.data.type}`);
      console.log(`📋 Job data: orderSheetUrl=${job.data.orderSheetUrl ? 'YES' : 'NO'}`);

      const { notificationId, recipientPhone, message, orderSheetUrl } = job.data;

      try {
        // Update notification status to processing
        await prisma.whatsAppNotification.update({
          where: { id: notificationId },
          data: {
            attempts: { increment: 1 },
          },
        });

        // Generate order sheet image if URL is provided
        let mediaBuffer: Buffer | undefined;
        if (orderSheetUrl) {
          console.log('📄 Order sheet URL provided, generating image...');
          const imageBuffer = await generateOrderSheetImage(orderSheetUrl);
          if (imageBuffer) {
            mediaBuffer = imageBuffer;
          } else {
            console.warn('⚠️ Failed to generate order sheet image, sending text only');
          }
        }

        // Send the message (with or without media)
        await sendWhatsAppMessage(recipientPhone, message, mediaBuffer);

        // Update notification as sent
        await prisma.whatsAppNotification.update({
          where: { id: notificationId },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            error: null,
          },
        });

        console.log(`✅ Job ${job.id} completed successfully`);
        return { success: true };

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`❌ Job ${job.id} failed:`, errorMessage);

        // Update notification with error
        await prisma.whatsAppNotification.update({
          where: { id: notificationId },
          data: {
            status: job.attemptsMade >= (job.opts.attempts || 3) ? 'FAILED' : 'PENDING',
            error: errorMessage,
          },
        });

        throw error; // Re-throw to trigger retry
      }
    },
    {
      connection: redisConnection,
      concurrency: 1, // Process one message at a time to avoid rate limiting
      limiter: {
        max: 10, // Max 10 jobs per duration
        duration: 60000, // 1 minute
      },
    }
  );

  worker.on('completed', (job) => {
    console.log(`✅ Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`❌ Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('Worker error:', err);
  });

  console.log('👷 BullMQ worker initialized');
}

/**
 * HTTP Server for QR code and health checks
 */
function initializeHttpServer(): void {
  app.use(express.json());

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      whatsapp: {
        ready: isClientReady,
        hasQr: !!currentQrCode,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // QR code endpoint (returns image)
  app.get('/qr', async (_req: Request, res: Response) => {
    if (isClientReady) {
      res.json({
        status: 'connected',
        message: 'BOT ALIVE - WhatsApp is connected',
      });
      return;
    }

    if (!currentQrCode) {
      res.json({
        status: 'waiting',
        message: 'Waiting for QR code generation...',
      });
      return;
    }

    // Return QR as data URL
    const qrDataUrl = await QRCode.toDataURL(currentQrCode);
    res.json({
      status: 'awaiting_scan',
      qrCode: qrDataUrl,
      message: 'Scan this QR code with WhatsApp',
    });
  });

  // QR code page (HTML)
  app.get('/qr-page', async (_req: Request, res: Response) => {
    if (isClientReady) {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>WhatsApp Bot Status</title>
          <meta http-equiv="refresh" content="5">
          <style>
            body { font-family: system-ui; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #075e54; }
            .card { background: white; padding: 40px; border-radius: 16px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.3); }
            .status { color: #25d366; font-size: 24px; font-weight: bold; }
            .icon { font-size: 64px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">✅</div>
            <div class="status">BOT ALIVE</div>
            <p>WhatsApp is connected and ready to send messages</p>
          </div>
        </body>
        </html>
      `);
      return;
    }

    if (!currentQrCode) {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>WhatsApp Bot Status</title>
          <meta http-equiv="refresh" content="3">
          <style>
            body { font-family: system-ui; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #075e54; }
            .card { background: white; padding: 40px; border-radius: 16px; text-align: center; }
            .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #25d366; border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin: 0 auto 20px; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="spinner"></div>
            <p>Generating QR code...</p>
          </div>
        </body>
        </html>
      `);
      return;
    }

    const qrDataUrl = await QRCode.toDataURL(currentQrCode, { width: 300 });
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Scan WhatsApp QR Code</title>
        <meta http-equiv="refresh" content="10">
        <style>
          body { font-family: system-ui; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #075e54; }
          .card { background: white; padding: 40px; border-radius: 16px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.3); }
          .qr { margin: 20px 0; }
          .qr img { border-radius: 8px; }
          h1 { color: #075e54; margin-bottom: 10px; }
          p { color: #666; }
          .instructions { background: #f5f5f5; padding: 15px; border-radius: 8px; margin-top: 20px; text-align: left; }
          .instructions li { margin: 8px 0; color: #333; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>📱 WhatsApp Bot</h1>
          <p>Scan this QR code to connect</p>
          <div class="qr">
            <img src="${qrDataUrl}" alt="WhatsApp QR Code" />
          </div>
          <div class="instructions">
            <strong>Instructions:</strong>
            <ol>
              <li>Open WhatsApp on your phone</li>
              <li>Tap Menu ⋮ or Settings</li>
              <li>Tap Linked Devices</li>
              <li>Tap Link a Device</li>
              <li>Point your phone at this screen</li>
            </ol>
          </div>
        </div>
      </body>
      </html>
    `);
  });

  // Status endpoint
  app.get('/status', async (_req: Request, res: Response) => {
    const pendingCount = await prisma.whatsAppNotification.count({
      where: { status: 'PENDING' },
    });

    const sentToday = await prisma.whatsAppNotification.count({
      where: {
        status: 'SENT',
        sentAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
    });

    res.json({
      whatsapp: {
        connected: isClientReady,
        hasQrCode: !!currentQrCode,
        lastError,
        groupId: process.env.WHATSAPP_GROUP_ID || null,
      },
      queue: {
        pending: pendingCount,
        sentToday,
      },
      uptime: process.uptime(),
    });
  });

  // List all groups/chats the bot is in (useful for finding group ID)
  app.get('/groups', async (_req: Request, res: Response) => {
    if (!whatsappClient || !isClientReady) {
      res.status(503).json({ error: 'WhatsApp not connected' });
      return;
    }

    try {
      const chats = await whatsappClient.getChats();
      const groups = chats
        .filter((chat: any) => chat.isGroup)
        .map((chat: any) => ({
          id: chat.id._serialized,
          name: chat.name,
          isReadOnly: chat.isReadOnly,
          participants: chat.participants?.length || 0,
        }));

      res.json({
        count: groups.length,
        groups,
        hint: 'Copy the "id" of your announcement group and set it as WHATSAPP_GROUP_ID env variable',
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch groups', details: String(error) });
    }
  });

  // Test sending a message (with optional order sheet image)
  app.post('/test-send', express.json(), async (req: Request, res: Response) => {
    if (!whatsappClient || !isClientReady) {
      res.status(503).json({ error: 'WhatsApp not connected' });
      return;
    }

    const { message, groupId, orderId } = req.body;
    const testMessage = message || '🧪 Test message from OMEGL WhatsApp Bot';
    const targetGroup = groupId || process.env.WHATSAPP_GROUP_ID;

    if (!targetGroup) {
      res.status(400).json({ 
        error: 'No group ID provided. Use /groups endpoint to find your group ID.',
        hint: 'Either pass groupId in body or set WHATSAPP_GROUP_ID env variable'
      });
      return;
    }

    try {
      const chatId = targetGroup.includes('@') ? targetGroup : `${targetGroup}@g.us`;
      
      // If orderId provided, generate order sheet image
      let media = null;
      if (orderId) {
        console.log(`📸 Generating order sheet for test: ${orderId}`);
        const orderSheetUrl = `/api/orders/${orderId}/sheet`;
        const imageBuffer = await generateOrderSheetImage(orderSheetUrl);
        if (imageBuffer) {
          const base64 = imageBuffer.toString('base64');
          media = new MessageMedia('image/png', base64, 'order-sheet.png');
          console.log('📎 Order sheet image prepared');
        }
      }
      
      if (media) {
        await whatsappClient.sendMessage(chatId, media, { caption: testMessage });
      } else {
        await whatsappClient.sendMessage(chatId, testMessage);
      }
      
      res.json({ 
        success: true, 
        message: 'Test message sent!',
        sentTo: chatId,
        withImage: !!media
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to send message', details: String(error) });
    }
  });

  app.listen(PORT, () => {
    console.log(`🌐 HTTP server running on port ${PORT}`);
    console.log(`   - Health: http://localhost:${PORT}/health`);
    console.log(`   - QR Page: http://localhost:${PORT}/qr-page`);
    console.log(`   - Status: http://localhost:${PORT}/status`);
    console.log(`   - Groups: http://localhost:${PORT}/groups`);
    console.log(`   - Test:   POST http://localhost:${PORT}/test-send`);
  });
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('='.repeat(50));
  console.log('  OMEGL WhatsApp Bot Worker');
  console.log('='.repeat(50));

  // Validate environment
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is required');
    process.exit(1);
  }

  if (!process.env.REDIS_URL) {
    console.warn('⚠️ REDIS_URL not set, using localhost');
  }

  try {
    // Test database connection
    await prisma.$connect();
    console.log('✅ Database connected');

    // Initialize components
    initializeHttpServer();
    await initializeWhatsApp();
    initializeWorker();

    console.log('');
    console.log('🚀 WhatsApp Bot Worker is running!');
    console.log('   Open http://localhost:' + PORT + '/qr-page to scan QR code');

  } catch (error) {
    console.error('❌ Failed to start worker:', error);
    process.exit(1);
  }
}

// Handle shutdown
process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  if (whatsappClient) {
    await whatsappClient.destroy();
  }
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n👋 Shutting down...');
  if (whatsappClient) {
    await whatsappClient.destroy();
  }
  await prisma.$disconnect();
  process.exit(0);
});

// Start
main();
