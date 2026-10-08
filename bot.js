const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const dns = require('dns').promises;
const setting = require('./setting.js');
const chalk = require('chalk');
const figlet = require('figlet');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const { Client: SSHClient } = require('ssh2');

if (!setting.BOT_TOKEN || !setting.OWNER_ID) {
  console.error('❌ BOT_TOKEN dan OWNER_ID wajib diisi di .env');
  process.exit(1);
}

const bot = new TelegramBot(setting.BOT_TOKEN, { polling: true });

// ================= ANTI-SPAM CONSOLE =================
// Tanpa handler ini, node-telegram-bot-api mencetak "error: [polling_error]" SETIAP kali polling
// gagal (jaringan putus / 409 konflik / rate limit) -> console penuh. Sekarang error yang sama
// dicatat 1x per 60 detik beserta jumlah kemunculannya.
const _errSeen = new Map();
function logOnce(tag, err) {
  const msg = String((err && (err.message || err.code)) || err).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>').slice(0, 220);
  const key = `${tag}:${msg}`;
  const now = Date.now();
  const rec = _errSeen.get(key) || { t: 0, n: 0 };
  rec.n++;
  if (now - rec.t >= 60000) {
    console.error(`⚠️ [${tag}] ${msg}${rec.n > 1 ? ` (x${rec.n} dalam ≤60 dtk)` : ''}`);
    rec.t = now; rec.n = 0;
  }
  _errSeen.set(key, rec);
  if (_errSeen.size > 200) _errSeen.clear();
}
bot.on('polling_error', (e) => logOnce('polling_error', e));
bot.on('error', (e) => logOnce('bot_error', e));
process.on('unhandledRejection', (e) => logOnce('unhandledRejection', e));
const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';
const TEMPLATE_REPO = 'parham7991/railway-ubuntu-ssh-claude';
const TOKEN_FILE = path.join(__dirname, 'railway-token.json');
const CREATE_ERROR_LOG = path.join(__dirname, 'create-errors.log');
const BACKUP_DIR = path.join(os.tmpdir(), 'cvps-backups');
let backupRunning = false;

// ================= MAINTENANCE MODE =================
const MAINTENANCE_FILE = path.join(__dirname, 'maintenance.json');
// Registry user bersama untuk broadcast /bcall dari bot utama.
const USERS_FILE = path.join(__dirname, 'bcall-users.json');
const UPDATES_FILE = path.join(__dirname, 'updates.json');
let registeredUsers = {};

const DEFAULT_UPDATES = [
  { title: 'Create VPS', detail: 'Create VPS sekarang bisa digunakan dari PV/DM dan grup.', date: '2026-09-06' },
  { title: '/addgrup', detail: 'Command /add diganti menjadi /addgrup.', date: '2026-09-06' },
  { title: 'Keamanan Grup', detail: 'Detail login VPS yang dibuat dari grup dikirim ke DM pembuat VPS.', date: '2026-09-06' },
  { title: 'Tampilan Stok', detail: 'Informasi VPS STATUS memakai label VPS AKTIF dan STOK VPS.', date: '2026-09-06' },
  { title: 'CVPS NAT', detail: 'Informasi dan tampilan bot diperbarui ke CVPS NAT.', date: '2026-09-06' }
];

function loadUpdates() {
  try {
    if (fs.existsSync(UPDATES_FILE)) {
      const data = JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8'));
      if (Array.isArray(data) && data.length) return data;
    }
  } catch (_) {}
  try { fs.writeFileSync(UPDATES_FILE, JSON.stringify(DEFAULT_UPDATES, null, 2), { mode: 0o600 }); } catch (_) {}
  return DEFAULT_UPDATES;
}

function getUpdatesText() {
  const updates = loadUpdates();
  if (!updates.length) return '📭 Belum ada update.';
  return updates.slice(0, 15).map((u, i) =>
    `${i + 1}. <b>${esc(u.title || 'Update')}</b>
   📌 ${esc(u.detail || '')}${u.date ? `
   📅 ${esc(u.date)}` : ''}`
  ).join('\n\n');
}

async function sendStartupUpdate() {
  loadRegisteredUsers();
  const targets = Object.values(registeredUsers).filter(u => u?.chatId && u.botScope === 'main');
  if (!targets.length) return;
  const text = `🔄 <b>UPDATE CVPS NAT</b>\n\nBot baru saja restart. Berikut list update terbaru:\n\n${getUpdatesText()}`;
  for (const target of targets) {
    try { await bot.sendMessage(String(target.chatId), text, { parse_mode: 'HTML' }); } catch (_) {}
    await new Promise(r => setTimeout(r, 50));
  }
}


function loadRegisteredUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      registeredUsers = data && typeof data === 'object' ? data : {};
    }
  } catch (_) { registeredUsers = {}; }
}

function saveRegisteredUsers() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(registeredUsers, null, 2), { mode: 0o600 });
  } catch (e) { console.error('❌ Gagal menyimpan registry /bcall:', e.message); }
}

function registerBcallUser(msg) {
  const chatType = msg.chat?.type;
  if (!['private'].includes(chatType)) return;
  const chatId = String(msg.chat.id);
  const userId = String(msg.from?.id || msg.chat.id);
  const botScope = 'main';
  const key = `${botScope}:${chatId}`;
  registeredUsers[key] = {
    chatId,
    userId,
    botScope,
    username: msg.from?.username || '',
    firstName: msg.from?.first_name || '',
    lastName: msg.from?.last_name || '',
    updatedAt: new Date().toISOString()
  };
  // Tidak menulis file setiap pesan bila data belum berubah secara berarti.
  saveRegisteredUsers();
}

loadRegisteredUsers();
let maintenanceEnabled = false;

function loadMaintenance() {
  try {
    if (fs.existsSync(MAINTENANCE_FILE)) {
      const data = JSON.parse(fs.readFileSync(MAINTENANCE_FILE, 'utf8'));
      maintenanceEnabled = Boolean(data?.enabled);
    }
  } catch (_) {
    maintenanceEnabled = false;
  }
}

function saveMaintenance() {
  fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify({
    enabled: maintenanceEnabled,
    updatedAt: new Date().toISOString()
  }, null, 2), { mode: 0o600 });
}

function isMaintenanceBlocked(userId) {
  // Selalu baca status terbaru dari file agar perubahan /mt langsung berlaku.
  loadMaintenance();
  // Owner selalu bisa masuk untuk mematikan maintenance.
  return maintenanceEnabled && !isOwner(userId);
}

loadMaintenance();

// ================= APPROVAL /ADDGRUP =================
// Semua /addgrup dari user non-Owner harus disetujui Owner terlebih dahulu.
const ADD_APPROVAL_FILE = path.join(__dirname, 'add-approvals.json');
let addApprovals = {};
function loadAddApprovals() {
  try {
    if (fs.existsSync(ADD_APPROVAL_FILE)) {
      const data = JSON.parse(fs.readFileSync(ADD_APPROVAL_FILE, 'utf8'));
      addApprovals = data && typeof data === 'object' ? data : {};
    }
  } catch (_) { addApprovals = {}; }
}
function saveAddApprovals() {
  try { fs.writeFileSync(ADD_APPROVAL_FILE, JSON.stringify(addApprovals, null, 2), { mode: 0o600 }); } catch (_) {}
}
loadAddApprovals();

// Backup = SEMUA file di folder bot (termasuk .env, data json, semua file .js) agar bisa dipindah/restore utuh.
// Dilewati: folder (node_modules, .git, dll), arsip backup lama, dan file sementara.
const BACKUP_SKIP_RE = /(\.(zip|tar|gz|tgz)$|\.tmp(-\d+)?$|^nohup\.out$|^\.DS_Store$|^npm-debug\.log$)/i;
function backupSourceFiles() {
  let names = [];
  try {
    names = fs.readdirSync(__dirname, { withFileTypes: true })
      .filter(e => e.isFile() && !e.isSymbolicLink())
      .map(e => e.name);
  } catch (_) {}
  return names.filter(n => !BACKUP_SKIP_RE.test(n)).sort();
}

async function createBackupArchive() {
  if (backupRunning) throw new Error('Backup sedang berjalan');
  backupRunning = true;
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipPath = path.join(BACKUP_DIR, `cvps-backup-${stamp}.zip`);
  const tarPath = path.join(BACKUP_DIR, `cvps-backup-${stamp}.tar.gz`);
  const files = backupSourceFiles();
  try {
    try {
      await execFileAsync('zip', ['-q', zipPath, ...files], { cwd: __dirname, timeout: 120000 });
      if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0) return zipPath;
    } catch (_) {}
    await execFileAsync('tar', ['-czf', tarPath, ...files], { cwd: __dirname, timeout: 120000 });
    if (!fs.existsSync(tarPath) || fs.statSync(tarPath).size === 0) throw new Error('Gagal membuat arsip backup');
    return tarPath;
  } finally {
    backupRunning = false;
  }
}

async function sendAutoBackup(reason = 'AUTO') {
  let archive = null;
  try {
    archive = await createBackupArchive();
    await bot.sendDocument(String(setting.OWNER_ID), archive, {
      caption: `💾 <b>BACKUP CVPS</b>\n\n📌 Tipe: <code>${reason}</code>\n📄 ${backupSourceFiles().length} file (termasuk <code>.env</code>)\n🕐 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n\n⚠️ <i>Berisi secret — jangan di-forward.</i>`,
      parse_mode: 'HTML'
    });
    return true;
  } catch (e) {
    console.error('❌ BACKUP FAILED:', e.message);
    try {
      await bot.sendMessage(String(setting.OWNER_ID), `❌ <b>BACKUP GAGAL</b>\n\nError: <code>${esc(e.message)}</code>`, { parse_mode: 'HTML' });
    } catch (_) {}
    return false;
  } finally {
    if (archive) {
      try { fs.unlinkSync(archive); } catch (_) {}
    }
  }
}


// Setiap token memiliki maxSlots CREATE VPS aktif (default 2).
// Format tersimpan: { "tokens": { "token_xxx": { token: "...", used: 0 } } }
let railwayTokens = {};
const tokenBusy = new Set();
const activeCreates = new Map();
function cancelCreate(jobId) { const job = activeCreates.get(String(jobId)); if (!job) return false; job.cancelled = true; return true; }
function ensureCreateNotCancelled(jobId) { if (activeCreates.get(String(jobId))?.cancelled) { const e = new Error('CREATE dihentikan oleh Owner.'); e.code = 'CREATE_CANCELLED'; throw e; } }

function tokenAlias(token) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 10);
}

function logCreateError({ userId, chatId, chatType, name, alias, stage, error }) {
  const time = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  const line = `[${time}] CREATE_FAILED | user=${userId} | chat=${chatId} | type=${chatType} | name=${name} | token=${alias} | stage=${stage} | error=${message.replace(/\s+/g, ' ')}\n`;
  try { fs.appendFileSync(CREATE_ERROR_LOG, line, { mode: 0o600 }); } catch (_) {}
  console.error(line.trim());
  return line.trim();
}

function loadRailwayTokens() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) { railwayTokens = {}; return; }
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (data.tokens && typeof data.tokens === 'object') {
      railwayTokens = data.tokens;
    } else if (data.token) {
      // Migrasi format lama satu token -> pool token.
      const token = String(data.token).trim();
      if (token) railwayTokens = { [tokenAlias(token)]: { token, used: 0, pending: 0, maxSlots: 2 } };
      saveRailwayTokens();
    } else railwayTokens = {};
  } catch (_) { railwayTokens = {}; }
}

function saveRailwayTokens() {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ tokens: railwayTokens }, null, 2), { mode: 0o600 });
}

async function addRailwayToken(token, workspaceId = '') {
  token = String(token).trim();
  workspaceId = String(workspaceId || '').trim();
  const alias = tokenAlias(token);
  const existing = railwayTokens[alias] || {};

  // Jangan melakukan query workspace saat token baru ditambahkan.
  // Workspace dideteksi saat CREATE menggunakan token yang dipilih otomatis.
  // Ini mencegah bot crash ketika token adalah workspace token, karena
  // token jenis itu memang tidak bisa memakai query me.workspaces.
  railwayTokens[alias] = {
    ...existing,
    token,
    ...(workspaceId ? { workspaceId } : {}),
    used: Number(existing.used || 0),
    pending: Number(existing.pending || 0),
    maxSlots: 2
  };
  saveRailwayTokens();
  return alias;
}

function getAvailableToken() {
  for (const [alias, item] of Object.entries(railwayTokens)) {
    if (item && item.token) return { alias, token: item.token, used: Number(item.used || 0), maxSlots: Math.max(1, Number(item.maxSlots || 2)) };
  }
  return null;
}

function consumeToken(alias) {
  const item = railwayTokens[alias];
  if (!item || !item.token) return { used: 0, remaining: 0, hidden: false };

  // Token TIDAK dihapus setelah CREATE ke-2.
  // Hanya disembunyikan dari menu CREATE sampai ada VPS yang dihapus.
  const before = Math.max(0, Number(item.used || 0));
  // pending dikurangi di blok finally CREATE, supaya satu proses CREATE
  // tidak mengurangi pending dua kali dan slot 2 tetap akurat saat concurrent.
  const maxSlots = Math.max(1, Number(item.maxSlots || 2));
  const after = Math.min(maxSlots, before + 1);
  item.used = after;
  saveRailwayTokens();
  return { used: after, remaining: Math.max(0, maxSlots - after), hidden: after >= maxSlots, maxSlots };
}

function restoreToken(alias) {
  const item = railwayTokens[alias];
  if (!item || !item.token) return null;
  item.used = Math.max(0, Number(item.used || 0) - 1);
  saveRailwayTokens();
  const maxSlots = Math.max(1, Number(item.maxSlots || 2));
  return { used: item.used, remaining: Math.max(0, maxSlots - item.used), maxSlots };
}

function getAnyToken(preferredAlias) {
  if (preferredAlias && railwayTokens[preferredAlias]?.token) {
    return { alias: preferredAlias, token: railwayTokens[preferredAlias].token, used: Number(railwayTokens[preferredAlias].used || 0) };
  }
  for (const [alias, item] of Object.entries(railwayTokens)) {
    if (item && item.token) return { alias, token: item.token, used: Number(item.used || 0), maxSlots: Math.max(1, Number(item.maxSlots || 2)) };
  }
  return null;
}

loadRailwayTokens();
if (setting.RAILWAY_API_TOKEN) {
  addRailwayToken(setting.RAILWAY_API_TOKEN).catch((e) => {
    console.error(`⚠️ RAILWAY_API_TOKEN tidak dapat diproses: ${e.message}`);
  });
}

console.clear();
console.log(chalk.cyanBright(figlet.textSync('Adrian CVPS', { horizontalLayout: 'default' })));
console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
console.log(`${chalk.yellow('🚀 Bot')}       : ${chalk.white('Adrian CVPS Bot - Railway')}`);
console.log(`${chalk.yellow('📦 Status')}    : ${chalk.greenBright('Bot berjalan...')}`);
console.log(`${chalk.yellow('☁️ Provider')}  : ${chalk.white('Railway')}`);
console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));

const BANNER_URL = 'https://files.catbox.moe/7eo5da.jpg';
const sessions = new Map();
const vpsStore = new Map();
const ROLE_FILE = path.join(__dirname, 'roles.json');
const VPS_FILE = path.join(__dirname, 'vps-store.json');
const VPS_SETTINGS_FILE = path.join(__dirname, 'vps-settings.json');
const EXTRA_SLOTS_FILE = path.join(__dirname, 'extra-slots.json');
const DEFAULT_VPS_SETTINGS = {
  limits: { RESS: 1, PREM: 3, ADMIN: 0, OWNER: 0 },
  durationDays: { RESS: 30, PREM: 30, ADMIN: 30, OWNER: 30 }
};
let vpsSettings = loadJson(VPS_SETTINGS_FILE, DEFAULT_VPS_SETTINGS);
let extraSlots = loadJson(EXTRA_SLOTS_FILE, {});
function saveVpsSettings() { saveJson(VPS_SETTINGS_FILE, vpsSettings); }
function saveExtraSlots() { saveJson(EXTRA_SLOTS_FILE, extraSlots); }
function normalizeVpsSettings() {
  vpsSettings = vpsSettings && typeof vpsSettings === 'object' ? vpsSettings : {};
  const oldLimit = vpsSettings.limits?.BUYER;
  const oldDays = vpsSettings.durationDays?.BUYER;
  vpsSettings.limits = { ...DEFAULT_VPS_SETTINGS.limits, ...(vpsSettings.limits || {}) };
  vpsSettings.durationDays = { ...DEFAULT_VPS_SETTINGS.durationDays, ...(vpsSettings.durationDays || {}) };
  if (oldLimit !== undefined && vpsSettings.limits.RESS === DEFAULT_VPS_SETTINGS.limits.RESS) vpsSettings.limits.RESS = oldLimit;
  if (oldDays !== undefined && vpsSettings.durationDays.RESS === DEFAULT_VPS_SETTINGS.durationDays.RESS) vpsSettings.durationDays.RESS = oldDays;
  delete vpsSettings.limits.BUYER;
  delete vpsSettings.durationDays.RESS;
  saveVpsSettings();
}
function getUserRole(userId) {
  if (isOwner(userId)) return 'OWNER';
  if (isAdmin(userId)) return 'ADMIN';
  if (isPrem(userId)) return 'PREM';
  if (isBuyer(userId)) return 'RESS';
  return 'NONE';
}
function getBaseVpsLimit(userId) {
  const role = getUserRole(userId);
  if (role === 'NONE') return 0;
  const limit = Number(vpsSettings.limits?.[role]);
  return limit > 0 ? limit : Infinity;
}
function getExtraSlots(userId) { return Math.max(0, Number(extraSlots[String(userId)] || 0)); }
function getVpsLimit(userId) {
  const base = getBaseVpsLimit(userId);
  if (base === Infinity) return Infinity;
  return base + getExtraSlots(userId);
}
function getVpsDurationDays(userId) {
  const role = getUserRole(userId);
  const days = Number(vpsSettings.durationDays?.[role]);
  return days > 0 ? days : 30;
}
function countUserVps(userId) {
  return [...vpsStore.values()].filter(v => String(v?.ownerId) === String(userId)).length;
}
function vpsLimitText(userId) {
  const limit = getVpsLimit(userId);
  return limit === Infinity ? 'UNLIMITED' : String(limit);
}
function slotSummaryText(userId) {
  const role = getUserRole(userId);
  const base = getBaseVpsLimit(userId);
  const used = countUserVps(userId);
  const extra = getExtraSlots(userId);
  const total = getVpsLimit(userId);
  return [
    `🖥️ <b>VPS Saya:</b> ${used}/${total === Infinity ? '∞' : total}`,
    `➕ <b>Extra Slot:</b> ${extra}`,
    `📦 <b>Total Slot:</b> ${total === Infinity ? 'UNLIMITED' : total}`,
    `👤 <b>Role:</b> ${role}`,
    `🎯 <b>Slot Dasar:</b> ${base === Infinity ? 'UNLIMITED' : base}`
  ].join('\n');
}
function remainingVpsTime(expiresAt) {
  if (!expiresAt) return 'TIDAK DIATUR';
  const ms = Number(expiresAt) - Date.now();
  if (ms <= 0) return 'EXPIRED';
  const totalHours = Math.ceil(ms / 3600000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days > 0 ? `${days}h ${hours}j` : `${hours}j`;
}
const buyers = new Set();
const prems = new Set();
const admins = new Set();
const assistants = new Set();

function actorIdFromMessage(msg) { return String(msg.from?.id ?? msg.chat.id); }
function actorIdFromCallback(query) { return String(query.from?.id ?? query.message.chat.id); }
function sessionKey(chatId, userId) { return `${chatId}:${userId}`; }

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return fallback;
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function loadRoles() {
  const data = loadJson(ROLE_FILE, { buyers: [], prems: [], admins: [], assistants: [] });
  for (const id of (Array.isArray(data.buyers) ? data.buyers : [])) buyers.add(String(id));
  for (const id of (Array.isArray(data.prems) ? data.prems : [])) prems.add(String(id));
  for (const id of (Array.isArray(data.admins) ? data.admins : [])) admins.add(String(id));
  for (const id of (Array.isArray(data.assistants) ? data.assistants : [])) assistants.add(String(id));
}

function saveRoles() {
  saveJson(ROLE_FILE, { buyers: [...buyers], prems: [...prems], admins: [...admins], assistants: [...assistants] });
}

function loadVpsStore() {
  const data = loadJson(VPS_FILE, {});
  for (const [serviceId, value] of Object.entries(data)) vpsStore.set(serviceId, value);
}

function saveVpsStore() {
  saveJson(VPS_FILE, Object.fromEntries(vpsStore.entries()));
}

function isOwner(userId) {
  const ownerId = process.env.DEPLOY_OWNER_ID || setting.OWNER_ID;
  return String(userId) === String(ownerId);
}
function isBuyer(userId) { return buyers.has(String(userId)); }
function isPrem(userId) { return prems.has(String(userId)); }
function isAdmin(userId) { return admins.has(String(userId)); }
function isAssistant(userId) { return assistants.has(String(userId)); }
function canManageBuyer(userId) { return isOwner(userId) || isPrem(userId) || isAdmin(userId); }
function hasAccess(userId) { return isOwner(userId) || isAdmin(userId) || isPrem(userId) || isBuyer(userId) || isAssistant(userId); }

function isGroupChat(chat) {
  return chat && (chat.type === 'group' || chat.type === 'supergroup');
}

loadRoles();
loadVpsStore();
normalizeVpsSettings();

function generatePassword(length = 16) {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== PAYMENT MANUAL 500P =====
const PAYMENT_PRICE = 500;
const PAYMENT_QRIS_URL = 'https://files.catbox.moe/ctgenu.jpeg';
const PAYMENT_CONFIG_FILE = path.join(__dirname, 'payment-config.json');
const PAYMENT_ORDERS_FILE = path.join(__dirname, 'payment-orders.json');
function paymentLoad(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch (_) { return fallback; }
}
const paymentConfig = paymentLoad(PAYMENT_CONFIG_FILE, {
  price: PAYMENT_PRICE,
  instructions: 'Hubungi Owner untuk metode pembayaran manual. Setelah membayar 500P, kirim bukti pembayaran.',
  photoFileId: ''
});
const paymentOrders = paymentLoad(PAYMENT_ORDERS_FILE, {});
function savePaymentData() {
  try { fs.writeFileSync(PAYMENT_CONFIG_FILE, JSON.stringify(paymentConfig, null, 2)); } catch (_) {}
  try { fs.writeFileSync(PAYMENT_ORDERS_FILE, JSON.stringify(paymentOrders, null, 2)); } catch (_) {}
}
function hasPendingPayment(uid) {
  return Object.values(paymentOrders).some(o => o && String(o.userId) === String(uid) && o.status === 'pending');
}
function paymentText() {
  return `💳 <b>PEMBELIAN AKSES VPS</b>\n\n💰 Harga akses: <b>${PAYMENT_PRICE}P</b>\n\n${esc(paymentConfig.instructions || 'Hubungi Owner untuk detail pembayaran manual.')}\n\nSetelah membayar, klik <b>📤 Kirim Bukti Pembayaran</b> dan kirim screenshot/foto bukti.`;
}
async function sendPaymentMenu(chatId) {
  const markup = { inline_keyboard: [
    [{ text: '📤 Kirim Bukti Pembayaran', callback_data: 'payment_proof' }],
    [{ text: '🔄 Cek Status', callback_data: 'payment_status' }],
    [{ text: '📞 Contact Owner', url: 'https://t.me/adriancloud01' }]
  ]};
  const qrisSource = paymentConfig.qrisUrl || PAYMENT_QRIS_URL || paymentConfig.photoFileId;
  if (qrisSource) {
    return bot.sendPhoto(chatId, qrisSource, { caption: paymentText(), parse_mode: 'HTML', reply_markup: markup });
  }
  return bot.sendMessage(chatId, paymentText(), { parse_mode: 'HTML', reply_markup: markup });
}
// ===== END PAYMENT MANUAL 500P =====


async function railway(query, variables = {}, token = null) {
  const res = await fetch(RAILWAY_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token || getAvailableToken()?.token || ''}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (!res.ok || json.errors?.length) {
    throw new Error(json.errors?.map(e => e.message).join('; ') || `HTTP ${res.status}`);
  }
  return json.data;
}

async function getWorkspaceForToken(token, workspaceId = '') {
  // Account token: Railway mengizinkan query me.workspaces.
  if (!workspaceId) {
    try {
      const data = await railway(`query { me { workspaces { id name } } }`, {}, token);
      const workspaces = data?.me?.workspaces || [];
      if (workspaces.length) {
        return { id: workspaces[0].id, name: workspaces[0].name || '' };
      }
      throw new Error('Account token tidak memiliki workspace yang dapat digunakan.');
    } catch (e) {
      const msg = String(e?.message || e);
      if (/Not Authorized|not authorized|Unauthorized|UNAUTHENTICATED/i.test(msg)) {
        throw new Error('Token ini bukan Account Token atau tidak punya izin membaca workspace. Jika ini Workspace Token, masukkan Workspace ID bersama token. Project Token tidak bisa membuat project baru.');
      }
      throw e;
    }
  }

  // Workspace token: validasi workspace secara langsung.
  const data = await railway(
    `query($workspaceId: String!) { workspace(workspaceId: $workspaceId) { id name } }`,
    { workspaceId: String(workspaceId).trim() },
    token
  );
  if (!data?.workspace?.id) throw new Error('Workspace ID tidak ditemukan atau token tidak memiliki akses ke workspace tersebut.');
  return { id: data.workspace.id, name: data.workspace.name || '' };
}

async function createProject(name, token, tokenInfo = null) {
  let workspaceId = tokenInfo?.workspaceId || null;
  const workspace = await getWorkspaceForToken(token, workspaceId);
  workspaceId = workspace.id;
  if (tokenInfo?.alias && railwayTokens[tokenInfo.alias]) {
    railwayTokens[tokenInfo.alias].workspaceId = workspace.id;
    railwayTokens[tokenInfo.alias].workspaceName = workspace.name || '';
    saveRailwayTokens();
  }
  const data = await railway(
    `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { id environments(first: 1) { edges { node { id } } } } }`,
    { input: { name, workspaceId } }, token
  );
  const project = data.projectCreate;
  return { projectId: project.id, environmentId: project.environments.edges[0].node.id };
}

async function createService(projectId, name, token) {
  const data = await railway(
    `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`,
    { input: { projectId, name, source: { repo: TEMPLATE_REPO } } }, token
  );
  return data.serviceCreate.id;
}

async function setVariables(projectId, environmentId, serviceId, password, token) {
  await railway(
    `mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }`,
    { input: { projectId, environmentId, serviceId, variables: { SSH_USERNAME: 'root', ROOT_PASSWORD: password } } }, token
  );
}

async function createTcpProxy(environmentId, serviceId, token, applicationPort = 22) {
  const data = await railway(
    `mutation($input: TCPProxyCreateInput!) { tcpProxyCreate(input: $input) { domain proxyPort } }`,
    { input: { environmentId, serviceId, applicationPort } }, token
  );
  return data.tcpProxyCreate;
}

// Membuat domain publik bawaan Railway (*.up.railway.app) secara otomatis.
// Domain ini dibuat melalui Public GraphQL API Railway dan diarahkan ke port Panel (80).
async function createRailwayServiceDomain(environmentId, serviceId, token, targetPort = 80) {
  const data = await railway(
    `mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { id domain targetPort } }`,
    { input: { environmentId, serviceId, targetPort } }, token
  );
  if (!data?.serviceDomainCreate?.domain) throw new Error('Railway tidak mengembalikan domain publik.');
  return data.serviceDomainCreate;
}



// ===== PTERODACTYL PANEL INSTALLER VIA SSH =====
function buildPanelInstallScript(details, panelHost, panelPort, requestedDomain) {
  const cfg = {
    email: details.email, username: details.username,
    first: details.first, last: details.last, password: details.password,
    host: panelHost, port: Number(panelPort),
    domain: requestedDomain && requestedDomain.toLowerCase() !== 'auto' ? requestedDomain : panelHost
  };
  const payload = Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64');
  const port = Number(panelPort);

  return `#!/usr/bin/env bash
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
LOG=/var/log/pterodactyl-auto-install.log
exec > >(tee -a "$LOG") 2>&1
fail(){ echo "INSTALL_FAILED: $1"; exit 1; }
trap 'fail "line $LINENO"' ERR

echo "== CVPS PTERODACTYL AUTO INSTALL =="
echo "Stage: preflight"
[ "$(id -u)" = "0" ] || fail "SSH user bukan root"
command -v apt-get >/dev/null || fail "apt-get tidak tersedia"
. /etc/os-release
[ "\${ID:-}" = "ubuntu" ] || fail "OS harus Ubuntu"
case "\${VERSION_ID:-}" in 22.04|24.04) ;; *) fail "Ubuntu 22.04/24.04 diperlukan" ;; esac

echo "Stage: packages"
apt-get update -y
apt-get install -y curl ca-certificates gnupg lsb-release software-properties-common \
  apt-transport-https git unzip tar openssl python3 cron nginx mariadb-server redis-server supervisor
if [ "\${VERSION_ID}" = "22.04" ]; then
  add-apt-repository -y ppa:ondrej/php
  apt-get update -y
fi
apt-get install -y php8.3 php8.3-cli php8.3-common php8.3-gd php8.3-mysql php8.3-mbstring \
  php8.3-bcmath php8.3-xml php8.3-fpm php8.3-curl php8.3-zip php8.3-intl

echo "Stage: services"
mkdir -p /run/mysqld /run/redis /run/php
chown mysql:mysql /run/mysqld 2>/dev/null || true
chown redis:redis /run/redis 2>/dev/null || true
if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  systemctl enable --now mariadb redis-server php8.3-fpm nginx supervisor || true
else
  pgrep -x mariadbd >/dev/null 2>&1 || (mysqld_safe --datadir=/var/lib/mysql --user=mysql >/var/log/mariadb-safe.log 2>&1 &)
  for i in $(seq 1 60); do mysqladmin ping --silent >/dev/null 2>&1 && break; sleep 1; done
  pgrep -x redis-server >/dev/null 2>&1 || redis-server --daemonize yes --dir /var/lib/redis
  php-fpm8.3 -D || true
  pgrep -x supervisord >/dev/null 2>&1 || supervisord -c /etc/supervisor/supervisord.conf >/var/log/supervisord.log 2>&1 &
  pgrep -x cron >/dev/null 2>&1 || cron
fi

echo "Stage: composer"
if ! command -v composer >/dev/null 2>&1; then
  curl -fsSL https://getcomposer.org/installer -o /tmp/composer.php
  php /tmp/composer.php --install-dir=/usr/local/bin --filename=composer
  rm -f /tmp/composer.php
fi

echo "Stage: database"
mysqladmin ping --silent >/dev/null 2>&1 || fail "MariaDB gagal hidup"
DB_PASS=$(openssl rand -hex 24)
mysql -uroot <<SQL
CREATE DATABASE IF NOT EXISTS panel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'pterodactyl'@'127.0.0.1' IDENTIFIED BY '\${DB_PASS}';
ALTER USER 'pterodactyl'@'127.0.0.1' IDENTIFIED BY '\${DB_PASS}';
GRANT ALL PRIVILEGES ON panel.* TO 'pterodactyl'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

echo "Stage: panel files"
rm -rf /var/www/pterodactyl
mkdir -p /var/www/pterodactyl
cd /var/www/pterodactyl
curl -fL https://github.com/pterodactyl/panel/releases/latest/download/panel.tar.gz -o /tmp/panel.tar.gz
tar -xzf /tmp/panel.tar.gz -C /var/www/pterodactyl
rm -f /tmp/panel.tar.gz
cp .env.example .env
composer install --no-dev --optimize-autoloader --no-interaction
php artisan key:generate --force

echo '${payload}' | base64 -d > /tmp/cvps-panel.json
export PTERO_DB_PASS="$DB_PASS"

php -r '
$j=json_decode(file_get_contents("/tmp/cvps-panel.json"), true);
$p="/var/www/pterodactyl/.env"; $s=file_get_contents($p);
$set=function($k,$v)use(&$s){$q=preg_quote($k,"/");$line=$k."=".$v;if(preg_match("/^".$q."=.*/m",$s))$s=preg_replace("/^".$q."=.*/m",$line,$s);else$s.="\\n".$line;};
$set("APP_ENV","production");$set("APP_DEBUG","false");
$set("APP_URL","http://".$j["host"].":".$j["port"]);
$set("APP_TIMEZONE","Asia/Jakarta");
$set("DB_CONNECTION","mysql");$set("DB_HOST","127.0.0.1");$set("DB_PORT","3306");
$set("DB_DATABASE","panel");$set("DB_USERNAME","pterodactyl");$set("DB_PASSWORD",getenv("PTERO_DB_PASS"));
$set("CACHE_DRIVER","redis");$set("CACHE_STORE","redis");$set("SESSION_DRIVER","redis");$set("QUEUE_CONNECTION","redis");
$set("REDIS_HOST","127.0.0.1");$set("REDIS_PORT","6379");$set("TRUSTED_PROXIES","*");
file_put_contents($p,$s);
'

echo "Stage: migrate"
php artisan migrate --seed --force

echo "Stage: permissions"
chown -R www-data:www-data /var/www/pterodactyl
chmod -R 755 /var/www/pterodactyl/storage /var/www/pterodactyl/bootstrap/cache

[ -S /run/php/php8.3-fpm.sock ] || fail "PHP-FPM socket tidak tersedia"

echo "Stage: nginx"
DOMAIN=$(python3 -c 'import json; print(json.load(open("/tmp/cvps-panel.json"))["domain"])')
rm -f /etc/nginx/sites-enabled/default
cat > /etc/nginx/sites-available/pterodactyl.conf <<NGINX
server {
    listen 80;
    server_name \${DOMAIN};
    root /var/www/pterodactyl/public;
    index index.php;
    client_max_body_size 100m;
    client_body_timeout 120s;
    sendfile off;
    location / { try_files \$uri \$uri/ /index.php?\$query_string; }
    location ~ \\.php\$ {
        fastcgi_split_path_info ^(.+\\.php)(/.+)\$;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;
        fastcgi_index index.php;
        include fastcgi_params;
        fastcgi_param PHP_VALUE "upload_max_filesize = 100M \\n post_max_size=100M";
        fastcgi_param SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        fastcgi_param HTTP_PROXY "";
        fastcgi_intercept_errors off;
        fastcgi_buffer_size 16k;
        fastcgi_buffers 4 16k;
        fastcgi_connect_timeout 300;
        fastcgi_send_timeout 300;
        fastcgi_read_timeout 300;
    }
    location ~ /\\.ht { deny all; }
}
NGINX
ln -sf /etc/nginx/sites-available/pterodactyl.conf /etc/nginx/sites-enabled/pterodactyl.conf
nginx -t

echo "Stage: queue + cron"
cat > /etc/supervisor/conf.d/pterodactyl-queue.conf <<'SUP'
[program:pterodactyl-queue]
command=/usr/bin/php /var/www/pterodactyl/artisan queue:work --queue=high,standard,low --sleep=3 --tries=3
directory=/var/www/pterodactyl
user=www-data
autostart=true
autorestart=true
startsecs=5
stopasgroup=true
killasgroup=true
stdout_logfile=/var/log/pterodactyl-queue.log
stderr_logfile=/var/log/pterodactyl-queue-error.log
SUP
( crontab -u www-data -l 2>/dev/null | grep -v '/var/www/pterodactyl/artisan schedule:run' || true; echo '* * * * * php /var/www/pterodactyl/artisan schedule:run >> /dev/null 2>&1' ) | crontab -u www-data -

if command -v supervisorctl >/dev/null 2>&1; then
  supervisorctl reread || true
  supervisorctl update || true
  supervisorctl restart pterodactyl-queue || true
fi

if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  systemctl restart php8.3-fpm nginx
else
  pkill -x nginx || true
  pkill -x php-fpm8.3 || true
  php-fpm8.3 -D || true
  pgrep -x supervisord >/dev/null 2>&1 || supervisord -c /etc/supervisor/supervisord.conf >/var/log/supervisord.log 2>&1 &
  pgrep -x cron >/dev/null 2>&1 || cron
  nginx
fi

echo "Stage: admin"
ADMIN_EMAIL=$(python3 -c 'import json; print(json.load(open("/tmp/cvps-panel.json"))["email"])')
ADMIN_USER=$(python3 -c 'import json; print(json.load(open("/tmp/cvps-panel.json"))["username"])')
ADMIN_FIRST=$(python3 -c 'import json; print(json.load(open("/tmp/cvps-panel.json"))["first"])')
ADMIN_LAST=$(python3 -c 'import json; print(json.load(open("/tmp/cvps-panel.json"))["last"])')
ADMIN_PASS=$(python3 -c 'import json; print(json.load(open("/tmp/cvps-panel.json"))["password"])')

php artisan p:user:make --email="$ADMIN_EMAIL" --username="$ADMIN_USER" \
  --name-first="$ADMIN_FIRST" --name-last="$ADMIN_LAST" \
  --password="$ADMIN_PASS" --admin=1 --no-interaction || \
php artisan p:user:make --email="$ADMIN_EMAIL" --username="$ADMIN_USER" \
  --name-first="$ADMIN_FIRST" --name-last="$ADMIN_LAST" \
  --password="$ADMIN_PASS" --admin=1

echo "Stage: healthcheck"
php artisan config:clear
php artisan cache:clear || true
php artisan route:clear || true
nginx -t
code=$(curl -sS -o /tmp/ptero-health.html -w "%{http_code}" http://127.0.0.1/ || true)
case "$code" in 200|301|302) ;; *) echo "HTTP_HEALTHCHECK_FAILED:$code"; tail -n 100 /var/log/nginx/pterodactyl.app-error.log 2>/dev/null || true; exit 1;; esac

echo "INSTALL_SUCCESS"
echo "PANEL_URL=http://\${DOMAIN}:\${port}"
echo "ADMIN_USERNAME=$ADMIN_USER"
echo "ADMIN_EMAIL=$ADMIN_EMAIL"
echo "INSTALL_LOG=$LOG"
rm -f /tmp/cvps-panel.json
`;
}

async function installPterodactylOverSsh(vps, details, progress, requestedDomain) {
  if (!vps?.host || !vps?.port || !vps?.password) {
    throw new Error('Data SSH VPS tidak lengkap (host/port/password).');
  }
  await bot.editMessageText(
    progress.header + '\n\n🔐 <b>Menghubungkan ke VPS melalui SSH...</b>',
    { chat_id: progress.chatId, message_id: progress.messageId, parse_mode: 'HTML' }
  ).catch(() => {});

  const script = buildPanelInstallScript(details, vps.host, vps.port, requestedDomain) +
    '\nrc=$?\necho "$rc" > /tmp/cvps-install-panel.exit\n';
  const encoded = Buffer.from(script, 'utf8').toString('base64');

  // Railway SSH+Claude can reset a long-lived SSH exec session while apt/composer
  // is running. Upload and detach the installer, then poll it over short SSH
  // connections instead of keeping one SSH channel open for the whole install.
  const uploadCmd = `echo '${encoded}' | base64 -d > /tmp/cvps-install-panel.sh && chmod 700 /tmp/cvps-install-panel.sh && rm -f /tmp/cvps-install-panel.exit /tmp/cvps-install-panel.log && nohup bash /tmp/cvps-install-panel.sh > /tmp/cvps-install-panel.log 2>&1 < /dev/null & echo STARTED`;
  await execSshCommand(vps, uploadCmd, 60 * 1000);

  const startedAt = Date.now();
  let lastStage = '';
  let lastLogSize = 0;
  while (Date.now() - startedAt < 55 * 60 * 1000) {
    let status;
    try {
      status = await execSshCommand(
        vps,
        `printf 'EXIT='; cat /tmp/cvps-install-panel.exit 2>/dev/null || true; printf '\nLOGSIZE='; wc -c < /tmp/cvps-install-panel.log 2>/dev/null || echo 0; printf '\nTAIL='; tail -n 8 /tmp/cvps-install-panel.log 2>/dev/null || true`,
        20 * 1000
      );
    } catch (err) {
      // A transient Railway TCP/SSH reset is retried on the next poll.
      await new Promise(r => setTimeout(r, 2500));
      continue;
    }

    const text = String(status || '');
    const exitMatch = text.match(/EXIT=(\d+)/);
    const logSizeMatch = text.match(/LOGSIZE=(\d+)/);
    const tailMatch = text.match(/TAIL=([\s\S]*)$/);
    const tail = (tailMatch?.[1] || '').trim();
    const stages = [...tail.matchAll(/Stage: ([^\r\n]+)/g)];
    const stage = stages.length ? stages[stages.length - 1][1].trim() : '';
    const size = Number(logSizeMatch?.[1] || 0);

    if (stage && stage !== lastStage) {
      lastStage = stage;
      await bot.editMessageText(
        progress.header + `\n\n🔨 <b>${esc(stage)}</b>\n\n<i>Installer sedang bekerja di VPS...</i>`,
        { chat_id: progress.chatId, message_id: progress.messageId, parse_mode: 'HTML' }
      ).catch(() => {});
    }
    lastLogSize = size;

    if (exitMatch) {
      const exitCode = Number(exitMatch[1]);
      if (exitCode !== 0) {
        let log = '';
        try { log = await execSshCommand(vps, 'tail -n 120 /tmp/cvps-install-panel.log 2>/dev/null || true', 20 * 1000); } catch (_) {}
        throw new Error((String(log || '').trim() || `Installer gagal dengan exit code ${exitCode}`).slice(-7000));
      }
      break;
    }

    await new Promise(r => setTimeout(r, 3000));
  }

  if (Date.now() - startedAt >= 55 * 60 * 1000) {
    throw new Error('Installer Panel timeout. Cek /tmp/cvps-install-panel.log atau /var/log/pterodactyl-auto-install.log di VPS.');
  }

  const panelDomain = requestedDomain && requestedDomain.toLowerCase() !== 'auto'
    ? requestedDomain
    : vps.host;
  return {
    domain: panelDomain,
    appUrl: `http://${panelDomain}:${Number(vps.port)}`,
    panelServiceId: null,
    databaseServiceId: null,
    redisServiceId: null,
    databaseServiceName: 'MariaDB lokal',
    redisServiceName: 'Redis lokal',
    panelServiceName: 'Pterodactyl Panel lokal',
    dockerImage: null
  };
}
// ===== END PTERODACTYL PANEL INSTALLER VIA SSH =====


async function execSshCommand(vps, command, timeoutMs = 25 * 60 * 1000, onData = null) {
  if (!vps?.host || !vps?.port || !vps?.password) throw new Error('Data login VPS tidak lengkap.');
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      err ? reject(err) : resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('Proses SSH timeout.')), timeoutMs);
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); return finish(err); }
        let out = ''; let errOut = '';
        stream.on('data', d => { const t = d.toString(); out += t; if (onData) onData(t, false); });
        stream.stderr.on('data', d => { const t = d.toString(); errOut += t; if (onData) onData(t, true); });
        stream.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) return finish(new Error((errOut || out || `SSH command gagal (${code})`).trim().slice(-6000)));
          finish(null, out);
        });
      });
    });
    conn.on('error', err => { clearTimeout(timer); finish(new Error(`SSH gagal: ${err.message}`)); });
    conn.connect({ host: String(vps.host), port: Number(vps.port), username: 'root', password: String(vps.password), readyTimeout: 30000, keepaliveInterval: 10000, keepaliveCountMax: 6, tcpNoDelay: true, hostVerifier: () => true });
  });
}

async function latestDeployment(projectId, serviceId, token) {
  const data = await railway(
    `query($input: DeploymentListInput!) { deployments(input: $input, first: 1) { edges { node { id status } } } }`,
    { input: { projectId, serviceId } }, token
  );
  return data.deployments.edges[0]?.node || null;
}

async function waitForDeployment(projectId, serviceId, progress, token) {
  const startedAt = Date.now();
  let retryCount = 0;
  for (let i = 0; i < 120; i++) {
    const dep = await latestDeployment(projectId, serviceId, token);
    const status = dep?.status || 'QUEUED';
    if (status === 'SUCCESS') return dep;
    if (status === 'FAILED' || status === 'CRASHED') {
      if (retryCount < 2) {
        retryCount++;
        try {
          await bot.editMessageText(
            progress.header + `\n\n⚠️ <b>Deploy gagal (${status})</b>\n🔄 <b>Auto Retry ${retryCount}/2...</b>`,
            { chat_id: progress.chatId, message_id: progress.messageId, parse_mode: 'HTML' }
          );
        } catch (_) {}
        await sleep(2000);
        if (!progress.environmentId) throw new Error('Environment ID tidak tersedia untuk auto retry.');
        await redeployService(serviceId, progress.environmentId);
        await sleep(3000);
        continue;
      }
      throw new Error(`Deployment ${status} setelah ${retryCount}x auto retry`);
    }

    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    let text = '⏳ Membuat VPS...';
    if (status === 'BUILDING') text = '🔨 Installing...';
    else if (status === 'DEPLOYING') text = '🚀 Menjalankan service Railway...';
    else if (status === 'QUEUED' || status === 'INITIALIZING') text = '⏳ Menunggu proses CREATE...';
    try {
      await bot.editMessageText(
        progress.header + `\n\n${text}\n\n⏱️ <b>Waktu tunggu: ${elapsed} detik</b>\n<i>Mohon tunggu, VPS sedang diproses...</i>`,
        { chat_id: progress.chatId, message_id: progress.messageId, parse_mode: 'HTML' }
      );
    } catch (_) {}
    await sleep(10000);
  }
  throw new Error('Timeout deployment melebihi 20 menit.');
}

async function resolveProxyIp(host) {
  try {
    const result = await dns.lookup(host, { family: 4 });
    return result.address;
  } catch (_) {
    return '-';
  }
}

async function getVpsSpecs(vps) {
  if (!vps?.host || !vps?.port || !vps?.password) throw new Error('Data login VPS tidak lengkap.');
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      err ? reject(err) : resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('Timeout saat mengambil spek VPS (20 detik).')), 20000);

    // Semua data dibuat dalam format KEY=VALUE agar parser tidak rusak oleh newline/output lscpu.
    const command = [
      "printf '__CVPS_OS_ID__='; . /etc/os-release 2>/dev/null && printf '%s %s' \"${ID:-linux}\" \"${VERSION_ID:-}\" || printf 'linux'",
      "printf '\\n__CVPS_KERNEL__='; uname -sr 2>/dev/null || printf '-'",
      "printf '\\n__CVPS_ARCH__='; uname -m 2>/dev/null || printf '-'",
      "printf '\\n__CVPS_CORES__='; nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || printf '-'",
      "printf '\\n__CVPS_CPU_MODEL__='; lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | head -n 1 || true",
      "printf '\\n__CVPS_RAM__='; free -b 2>/dev/null | awk '/^Mem:/ {print $2\" \"$3\" \"$4; found=1} END {if (!found) exit 1}' || awk '/^MemTotal:/ {t=$2*1024} /^MemAvailable:/ {a=$2*1024} END {if(t>0){print t\" \"(t-a)\" \"a}}' /proc/meminfo",
      "printf '\\n__CVPS_DISK__='; df -P -B1 / 2>/dev/null | awk 'NR==2 {print $2\" \"$3\" \"$4; found=1} END {if (!found) exit 1}'",
      "printf '\\n__CVPS_END__\\n'"
    ].join('; ');

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); return finish(err); }
        let out = '';
        let errOut = '';
        stream.on('data', d => { out += d.toString(); });
        stream.stderr.on('data', d => { errOut += d.toString(); });
        stream.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0 && !out.trim()) return finish(new Error(errOut.trim() || `SSH command gagal (${code})`));

          const getValue = (key) => {
            const m = out.match(new RegExp(`^${key}=(.*)$`, 'm'));
            return (m?.[1] || '').trim();
          };
          const parts = (key) => getValue(key).split(/\s+/).map(Number).filter(Number.isFinite);
          const fmtBytes = (n) => {
            n = Number(n) || 0;
            if (n <= 0) return '-';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let i = 0, v = n;
            while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
            return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
          };

          const ram = parts('__CVPS_RAM__');
          const disk = parts('__CVPS_DISK__');
          const cores = getValue('__CVPS_CORES__');
          const cpuModel = getValue('__CVPS_CPU_MODEL__');
          const osRaw = getValue('__CVPS_OS_ID__');

          finish(null, {
            os: osRaw || 'Linux',
            kernel: getValue('__CVPS_KERNEL__') || '-',
            arch: getValue('__CVPS_ARCH__') || '-',
            cores: cores || '-',
            cpu: cpuModel || 'Unknown CPU',
            ramTotal: fmtBytes(ram[0]),
            ramUsed: fmtBytes(ram[1]),
            ramFree: fmtBytes(ram[2]),
            diskTotal: fmtBytes(disk[0]),
            diskUsed: fmtBytes(disk[1]),
            diskFree: fmtBytes(disk[2])
          });
        });
      });
    });
    conn.on('error', err => { clearTimeout(timer); finish(new Error(`SSH gagal: ${err.message}`)); });
    conn.connect({ host: String(vps.host), port: Number(vps.port), username: 'root', password: String(vps.password), readyTimeout: 15000, hostVerifier: () => true });
  });
}

async function deleteService(serviceId, token) {
  return railway(`mutation($id: String!) { serviceDelete(id: $id) }`, { id: serviceId }, token);
}

async function deleteProject(projectId, token) {
  return railway(`mutation($id: String!) { projectDelete(id: $id) }`, { id: projectId }, token);
}

async function redeployService(serviceId, environmentId) {
  await railway(
    `mutation($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }`,
    { serviceId, environmentId }
  );
}

{
  bot.onText(/\/backup(?:@\w+)?/, async (msg) => {
    const uid = String(msg.from?.id || '');
    if (!isOwner(uid)) return bot.sendMessage(msg.chat.id, '⛔ Perintah ini hanya untuk Owner.');
    await bot.sendMessage(msg.chat.id, '⏳ Membuat backup...');
    await sendAutoBackup('MANUAL');
  });
}

bot.onText(/\/(?:maintenance|mt)(?:@\w+)?(?:\s|$)/i, async (msg) => {
  const chatId = msg.chat.id;
  const userId = actorIdFromMessage(msg);

  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, '🚫 <b>Akses ditolak.</b>\n\nHanya Owner BOT UTAMA yang dapat mengatur Maintenance.', { parse_mode: 'HTML' });
  }

  // Ambil status terbaru sebelum menampilkan menu /mt.
  loadMaintenance();

  return bot.sendMessage(chatId, `🛠️ <b>MAINTENANCE SYSTEM</b>\n\nStatus saat ini: <b>${maintenanceEnabled ? '🔴 AKTIF' : '🟢 NONAKTIF'}</b>\n\nPilih tombol untuk mengatur maintenance.`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [
      [
        { text: maintenanceEnabled ? '🔴 ON (Aktif)' : '🟢 ON', callback_data: 'maintenance_on' },
        { text: !maintenanceEnabled ? '🟢 OFF (Nonaktif)' : '⚪ OFF', callback_data: 'maintenance_off' }
      ],
      [{ text: '🔄 Refresh Status', callback_data: 'maintenance_status' }]
    ] }
  });
});

bot.onText(/\/bcall(?:@\w+)?(?:\s|$)/i, async (msg) => {
  const chatId = String(msg.chat.id);
  const userId = actorIdFromMessage(msg);

  if (!isOwner(userId)) {
    return bot.sendMessage(chatId, '🚫 <b>Akses ditolak.</b>\n\nHanya Owner BOT UTAMA yang dapat menggunakan /bcall.', { parse_mode: 'HTML' });
  }

  const raw = msg.text?.replace(/^\/bcall(?:@\w+)?/i, '').trim() || '';
  let payload = raw;
  if (!payload && msg.reply_to_message) payload = msg.reply_to_message.text || msg.reply_to_message.caption || '';
  if (!payload) {
    return bot.sendMessage(chatId, '📢 <b>BROADCAST USER</b>\n\nGunakan:\n<code>/bcall pesan</code>\n\nAtau reply pesan lalu ketik <code>/bcall</code>.', { parse_mode: 'HTML' });
  }

  loadRegisteredUsers();
  const targets = Object.values(registeredUsers).filter(u => u?.chatId && String(u.chatId) !== chatId);
  if (!targets.length) {
    return bot.sendMessage(chatId, '📭 Belum ada user yang terdaftar untuk BCall.');
  }

  await bot.sendMessage(chatId, `📢 <b>MEMULAI BCALL</b>\n\n👥 Target: <b>${targets.length}</b> user\n⏳ Mengirim...`, { parse_mode: 'HTML' });

  let success = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      await bot.sendMessage(String(target.chatId), `📢 <b>BROADCAST</b>\n\n${esc(payload)}`, { parse_mode: 'HTML' });
      success++;
    } catch (_) {
      failed++;
    }
    await new Promise(r => setTimeout(r, 40));
  }

  return bot.sendMessage(chatId, `✅ <b>BCALL SELESAI</b>\n\n📨 Berhasil: <b>${success}</b>\n❌ Gagal: <b>${failed}</b>\n👥 Total target: <b>${targets.length}</b>` , { parse_mode: 'HTML' });
});

bot.onText(/\/start(?:@\w+)?/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = actorIdFromMessage(msg);
  if (isMaintenanceBlocked(userId)) return bot.sendMessage(chatId, '🔧 <b>SYSTEM MAINTENANCE</b>\n\n⏳ Bot sedang diperbaiki &amp; di-upgrade.\n🚀 Silakan coba kembali nanti.\n\n🙏 <b>Terima kasih atas pengertiannya!</b>', { parse_mode: 'HTML' });
  if (!hasAccess(userId)) {
    await bot.sendMessage(chatId, `🚫 <b>Akses belum aktif.</b>\n\nUntuk menggunakan fitur VPS, silakan beli akses manual seharga <b>${PAYMENT_PRICE}P</b>.`, { parse_mode: 'HTML' });
    return sendPaymentMenu(chatId);
  }

  const ownerDisplay = setting.OWNER_USERNAME ? `@${String(setting.OWNER_USERNAME).replace(/^@/, '')}` : 'adriancvps';
  const totalUsers = typeof users !== 'undefined' && users instanceof Map ? users.size : (typeof users !== 'undefined' && users ? Object.keys(users).length : 0);
  const totalIncome = typeof paymentOrders !== 'undefined' && paymentOrders
    ? Object.values(paymentOrders).filter(o => o && o.status === 'approved').reduce((sum, o) => sum + Number(o.amount || o.price || 0), 0)
    : 0;
  const formatRupiah = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;

  const caption = `🌸 ─────《 <b>“ WELCOME ”</b> 》───── 🌸

🚀 <b>INFORMASI BOT</b>
▶️ Developer : @orangasinggggggggggggg
▶️ Bot Name : <b>CVPS NAT</b>
▶️ Version : <b>BETA - Vip Buy Only</b>
▶️ Prefixes : / (Slash)

🖥️ <b>VPS STATUS</b>
▶️ VPS Aktif : ${typeof vpsStore !== 'undefined' ? vpsStore.size : 0}
▶️ STOK VPS : ${typeof railwayTokens !== 'undefined' ? Object.values(railwayTokens).reduce((sum, item) => sum + Math.max(0, Math.max(1, Number(item?.maxSlots || 2)) - Number(item?.used || 0) - Number(item?.pending || 0)), 0) : 0}

[ 𓆩☁𓆪 ] Olaa, <b>Welcome To Bot CVPS NAT</b>`;

  const startKeyboard = { inline_keyboard: [
    [{
      text: '↯ Create VPS', callback_data: 'create_vps'
    }, {
      text: '↯ Menu VPS', callback_data: 'menu_vps'
    }],
    [{ text: '📦 Cek Stok', callback_data: 'check_stock' }],
    [{ text: '📋 LIST UPDATE', callback_data: 'list_updates' }],
    ...(isOwner(userId) ? [[{ text: '↯ Owner Bot', callback_data: 'owner_bot' }], [{ text: '🖥️ VPS MANAGER', callback_data: 'pa_vps' }], [{ text: '🤖 PRIBADI ASISTEN', callback_data: 'pa_menu' }]] : [])
  ] };

  try {
    await bot.sendPhoto(chatId, require('path').join(__dirname, 'banner.jpg'), {
      caption,
      parse_mode: 'HTML',
      reply_markup: startKeyboard
    });
  } catch (_) {
    await bot.sendMessage(chatId, caption, {
      parse_mode: 'HTML',
      reply_markup: startKeyboard
    });
  }
});

bot.on('callback_query', async (query) => {
  const chatId = String(query.message.chat.id);
  const userId = actorIdFromCallback(query);
  const skey = sessionKey(chatId, userId);
  const action = query.data;

  // Approval /addgrup harus diproses oleh Owner BOT UTAMA.
  if (/^(approve_add|reject_add)_/.test(action)) {
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: '🚫 Hanya Owner bot ini yang dapat memproses approval.', show_alert: true });
    const [, approvalId] = action.match(/^(?:approve_add|reject_add)_(.+)$/) || [];
    const req = approvalId ? addApprovals[approvalId] : null;
    if (!req || req.status !== 'pending') return bot.answerCallbackQuery(query.id, { text: '⚠️ Request sudah diproses atau tidak ditemukan.', show_alert: true });
    if (action.startsWith('reject_add_')) {
      req.status = 'rejected'; req.updatedAt = Date.now(); saveAddApprovals();
      try { await bot.sendMessage(req.chatId, '❌ <b>PERMINTAAN /ADDGRUP DITOLAK OWNER.</b>', { parse_mode: 'HTML' }); } catch (_) {}
      await bot.editMessageText(`❌ <b>REQUEST /ADDGRUP DITOLAK</b>\n\n👤 ${esc(req.name)}\n🆔 <code>${esc(req.userId)}</code>\n🧾 Request: <code>${esc(approvalId)}</code>`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }).catch(() => {});
      return bot.answerCallbackQuery(query.id, { text: 'Request ditolak.' });
    }
    const approvedCount = countUserVps(req.userId);
    const approvedLimit = getVpsLimit(req.userId);
    if (approvedCount >= approvedLimit) {
      req.status = 'rejected'; req.updatedAt = Date.now(); req.rejectReason = 'Slot VPS tercapai'; saveAddApprovals();
      try { await bot.sendMessage(req.chatId, `🚫 <b>REQUEST /ADDGRUP DITOLAK</b>\n\n${slotSummaryText(req.userId)}\n\nKlik <b>➕ Tambah Slot</b> untuk mengajukan slot tambahan.`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '➕ TAMBAH SLOT', callback_data: 'extra_slot' }]] } }); } catch (_) {}
      await bot.editMessageText(`🚫 <b>REQUEST /ADDGRUP DITOLAK</b>\n\n👤 ${esc(req.name)}\n🆔 <code>${esc(req.userId)}</code>\n📌 Alasan: <b>Limit VPS tercapai</b>`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }).catch(() => {});
      return bot.answerCallbackQuery(query.id, { text: 'Limit VPS user sudah tercapai.', show_alert: true });
    }
    req.status = 'approved'; req.updatedAt = Date.now(); saveAddApprovals();
    const targetKey = sessionKey(String(req.chatId), String(req.userId));
    sessions.set(targetKey, 'create:auto');
    try {
      await bot.sendMessage(req.chatId, `✅ <b>/ADD DISETUJUI OWNER</b>\n\n🏷️ Silakan kirim <b>nama VPS</b> untuk melanjutkan pembuatan.`, { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } });
    } catch (_) {}
    await bot.editMessageText(`✅ <b>REQUEST /ADDGRUP DISETUJUI</b>\n\n👤 ${esc(req.name)}\n🆔 <code>${esc(req.userId)}</code>\n🧾 Request: <code>${esc(approvalId)}</code>`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }).catch(() => {});
    return bot.answerCallbackQuery(query.id, { text: 'Request disetujui.' });
  }

  // Tombol maintenance harus diproses sebelum blok maintenance,
  // agar Owner BOT UTAMA tetap bisa mematikan maintenance.
  if (['maintenance_on', 'maintenance_off', 'maintenance_status'].includes(action)) {
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: '🚫 Hanya Owner BOT UTAMA yang dapat mengatur Maintenance.', show_alert: true });

    if (action === 'maintenance_on') {
      maintenanceEnabled = true;
      saveMaintenance();
    } else if (action === 'maintenance_off') {
      maintenanceEnabled = false;
      saveMaintenance();
    } else {
      // Refresh status langsung dari file bersama.
      loadMaintenance();
    }

    await bot.editMessageText(`🛠️ <b>MAINTENANCE SYSTEM</b>\n\nStatus saat ini: <b>${maintenanceEnabled ? '🔴 AKTIF' : '🟢 NONAKTIF'}</b>\n\nPilih tombol untuk mengatur maintenance.`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [
          { text: maintenanceEnabled ? '🔴 ON (Aktif)' : '🟢 ON', callback_data: 'maintenance_on' },
          { text: !maintenanceEnabled ? '🟢 OFF (Nonaktif)' : '⚪ OFF', callback_data: 'maintenance_off' }
        ],
        [{ text: '🔄 Refresh Status', callback_data: 'maintenance_status' }]
      ] }
    }).catch(() => {});

    return bot.answerCallbackQuery(query.id, { text: maintenanceEnabled ? '🔴 Maintenance ON' : '🟢 Maintenance OFF' });
  }

  if (isMaintenanceBlocked(userId)) return bot.answerCallbackQuery(query.id, { text: '🔧 Bot sedang maintenance.', show_alert: true });

  // Payment manual dapat digunakan walaupun user belum punya role.
  if (action === 'payment_proof') {
    if (hasAccess(userId)) return bot.answerCallbackQuery(query.id, { text: 'Akun kamu sudah memiliki akses.', show_alert: true });
    if (hasPendingPayment(userId)) return bot.answerCallbackQuery(query.id, { text: 'Bukti kamu masih menunggu verifikasi.', show_alert: true });
    sessions.set(skey, 'payment_proof');
    await bot.sendMessage(chatId, `📤 <b>KIRIM BUKTI PEMBAYARAN</b>\n\nBayar <b>${PAYMENT_PRICE}P</b>, lalu kirim screenshot/foto bukti pembayaran di chat ini.`, { parse_mode: 'HTML' });
    return bot.answerCallbackQuery(query.id);
  }
  if (action === 'payment_status') {
    const last = Object.values(paymentOrders).filter(o => o && String(o.userId) === String(userId)).sort((a,b) => Number(b.createdAt||0)-Number(a.createdAt||0))[0];
    const status = !last ? '📭 Belum ada pengajuan pembayaran.' : last.status === 'pending' ? '⏳ Bukti masih menunggu verifikasi Owner/Admin.' : last.status === 'approved' ? '✅ Pembayaran disetujui. Role RESS sudah aktif.' : '❌ Pembayaran ditolak. Silakan kirim bukti yang valid.';
    return bot.answerCallbackQuery(query.id, { text: status, show_alert: true });
  }
  if (/^(approve|reject)_payment_\d+$/.test(action)) {
    if (!(isOwner(userId) || isAdmin(userId))) return bot.answerCallbackQuery(query.id, { text: '❌ Hanya Owner/Admin.', show_alert: true });
    const approved = action.startsWith('approve_payment_');
    const targetId = action.replace(/^(approve|reject)_payment_/, '');
    const order = Object.values(paymentOrders).find(o => o && String(o.userId) === String(targetId) && o.status === 'pending');
    if (!order) return bot.answerCallbackQuery(query.id, { text: 'Pengajuan tidak ditemukan/sudah diproses.', show_alert: true });
    order.status = approved ? 'approved' : 'rejected';
    order.reviewedBy = String(userId);
    order.reviewedAt = Date.now();
    if (approved) { buyers.add(String(targetId)); saveRoles(); }
    savePaymentData();
    try {
      await bot.sendMessage(String(targetId), approved
        ? '✅ <b>PEMBAYARAN DISETUJUI</b>\\n\\nRole <b>BUYER</b> sudah aktif. Ketik /start untuk menggunakan bot.'
        : '❌ <b>PEMBAYARAN DITOLAK</b>\\n\\nSilakan kirim bukti pembayaran yang valid lagi.', { parse_mode: 'HTML' });
    } catch (_) {}
    try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }); } catch (_) {}
    return bot.answerCallbackQuery(query.id, { text: approved ? 'RESS diaktifkan.' : 'Pembayaran ditolak.' });
  }
  if (action === 'back_start') {
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch (_) {}
    return bot.answerCallbackQuery(query.id);
  }

  if (action === 'list_updates') {
    await bot.sendMessage(chatId, `📋 <b>LIST UPDATE CVPS NAT</b>\n\n${getUpdatesText()}`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'back_start' }]] }
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (action === 'owner_bot') {
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Menu Owner hanya untuk Owner.', show_alert: true });
    await bot.sendMessage(chatId, `👑 <b>OWNER BOT</b>

⚙️ <b>Pengaturan & Manajemen</b>

Gunakan menu di bawah untuk mengelola bot, user, token Railway, dan VPS.`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '⚙️ SET API TOKEN', callback_data: 'set_api' }],
        [{ text: '🗑️ HAPUS TOKEN', callback_data: 'delete_token_menu' }],
        [{ text: '👥 ROLE MANAGER', callback_data: 'buyer_role' }],
        [{ text: '🖥️ KELOLA VPS', callback_data: 'owner_vps_menu' }],
        [{ text: '📚 COMMAND OWNER', callback_data: 'owner_commands' }],
        [{ text: '🔙 Kembali', callback_data: 'owner_commands_back' }]
      ] }
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (action === 'owner_vps_menu') {
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Owner only.', show_alert: true });
    const all = [...vpsStore.entries()];
    const active = all.filter(([_, v]) => v && v.status !== 'deleted');
    const lines = active.length
      ? active.slice(0, 50).map(([serviceId, v], i) =>
          `${i + 1}. <b>${esc(v.name || 'VPS')}</b>\n   👤 User: <code>${esc(v.ownerId || '-')}</code>\n   🟢 Status: <code>${esc(v.status || 'ACTIVE')}</code>\n   ⏳ Sisa: <code>${esc(remainingVpsTime(v.expiresAt))}</code>\n   🆔 <code>${esc(serviceId)}</code>`
        ).join('\n\n')
      : '📭 Belum ada VPS tersimpan.';

    await bot.sendMessage(chatId, `🛡️ <b>OWNER — KELOLA VPS</b>

📦 Total VPS: <b>${active.length}</b>

${lines}

Pilih tindakan:`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '📋 LIST VPS', callback_data: 'list_vps' }],
        [{ text: '🔁 REBUILD VPS', callback_data: 'rebuild_vps' }, { text: '🗑️ DELETE VPS', callback_data: 'delete_vps' }],
        [{ text: '🔄 REFRESH', callback_data: 'owner_vps_menu' }],
        [{ text: '↩️ Kembali', callback_data: 'owner_commands' }]
      ] }
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (action === 'owner_commands') {
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Owner only.', show_alert: true });
    const commands = `📚 <b>COMMAND OWNER</b>

<b>👥 USER & ROLE</b>
<code>/address ID</code> — tambah RESS
<code>/delress ID</code> — hapus RESS
<code>/ress</code> — daftar RESS
<code>/addprem ID</code> — tambah PREM
<code>/delprem ID</code> — hapus PREM
<code>/prems</code> — daftar PREM
<code>/addrole ID</code> — menu role

<b>🖥️ VPS</b>
<code>/addgrup</code> — request/buat VPS
<code>/vpsconfig</code> — lihat konfigurasi VPS
<code>/setvpslimit ROLE JUMLAH</code> — atur limit dasar VPS\n<code>/setslot USER_ID JUMLAH</code> — set extra slot user\n<code>/delslot USER_ID JUMLAH</code> — kurangi extra slot
<code>/setvpsdays ROLE HARI</code> — atur masa aktif
<code>/listvps</code> — daftar VPS
<code>/ping</code> — cek status VPS/bot

<b>🔑 RAILWAY</b>
<code>/setapi</code> — kelola API/token
<code>/deltoken</code> — hapus token

<b>🔧 SYSTEM</b>
<code>/mt</code> — menu Maintenance
<code>/maintenance</code> — kontrol Maintenance

<i>Gunakan tombol di bawah untuk kembali ke menu utama.</i>`;
    return bot.sendMessage(chatId, commands, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [{ text: '🖥️ KELOLA VPS', callback_data: 'owner_vps_menu' }],
      [{ text: '🔙 Kembali', callback_data: 'owner_commands_back' }]
    ] } });
  }
  if (action === 'owner_commands_back') {
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Owner only.', show_alert: true });
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch (_) {}
    return bot.answerCallbackQuery(query.id, { text: 'Kembali ke menu utama.' });
  }

  if (!hasAccess(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Kamu belum mendapat role RESS.', show_alert: true });
  if (action === 'buyer_role') {
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Owner only.' });
    await bot.sendMessage(chatId, `👥 <b>ROLE MANAGER</b>

👤 RESS aktif: <b>${buyers.size}</b>\n⭐ Prem aktif: <b>${prems.size}</b>\n🛡️ Admin aktif: <b>${admins.size}</b>\n🧩 Asisten aktif: <b>${assistants.size}</b>

Perintah:
<code>/addbuyer ID</code> — tambah buyer
<code>/delress ID</code> atau <code>/delbuyer ID</code> — hapus buyer
<code>/ress</code> atau <code>/buyers</code> — lihat daftar buyer

⭐ <b>ROLE PREM</b>
<code>/addprem ID</code> — beri role prem
<code>/delprem ID</code> — hapus role prem
<code>/prems</code> — daftar role prem\n\n🧩 <b>ROLE ASISTEN</b>\n<code>/addassistant ID</code> — beri role Asisten\n<code>/delassistant ID</code> — hapus role Asisten\n<code>/assistants</code> — daftar Asisten\n\nAsisten dapat menjalankan <code>/deploy</code> pada bot utama.

Role Prem dapat memakai <code>/address</code>.\n\n🛡️ <b>ROLE ADMIN</b>\nAdmin dapat <code>/addbuyer</code>, <code>/addprem</code>, SET API TOKEN, serta membuat/mengelola VPS seperti RESS.`, { parse_mode: 'HTML' });
    return bot.answerCallbackQuery(query.id);
  } else if (action === 'role_cancel') {
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch (_) {}
    return bot.answerCallbackQuery(query.id, { text: 'Dibatalkan.' });
  } else if (/^role_set_(buyer|prem|admin|assistant)_\d+$/.test(action)) {
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Owner only.', show_alert: true });
    const match = action.match(/^role_set_(buyer|prem|admin|assistant)_(\d+)$/);
    const role = match[1];
    const targetId = match[2];
    if (isOwner(targetId)) return bot.answerCallbackQuery(query.id, { text: 'Role Owner tidak dapat diubah.', show_alert: true });
    buyers.delete(targetId); prems.delete(targetId); admins.delete(targetId); assistants.delete(targetId);
    if (role === 'buyer') buyers.add(targetId);
    if (role === 'prem') prems.add(targetId);
    if (role === 'admin') admins.add(targetId);
    if (role === 'assistant') assistants.add(targetId);
    saveRoles();
    const labels = { buyer: 'RESS', prem: 'PREM', admin: 'ADMIN', assistant: 'ASISTEN' };
    const targetName = query.message?.text?.match(/Username:<\/b>\s*([^\n]+)/i)?.[1] || `User ${targetId}`;
    const keyboard = { inline_keyboard: [
      [{ text: '👤 RESS', callback_data: `role_set_buyer_${targetId}` }, { text: '⭐ PREM', callback_data: `role_set_prem_${targetId}` }],
      [{ text: '🛡️ ADMIN', callback_data: `role_set_admin_${targetId}` }, { text: '🧩 ASISTEN', callback_data: `role_set_assistant_${targetId}` }],
      [{ text: '↩️ Kembali', callback_data: `role_back_${targetId}` }, { text: '❌ Batalkan', callback_data: 'role_cancel' }]
    ] };
    try { await bot.editMessageText(`🛡️ <b>ROLE BERHASIL DIUBAH</b>\n\n👤 <b>Target:</b> ${targetName}\n📌 <b>ID:</b> <code>${targetId}</code>\n🎯 <b>Role:</b> <code>${labels[role]}</code>`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: keyboard }); } catch (_) {}
    return bot.answerCallbackQuery(query.id, { text: `Role ${labels[role]} diberikan.` });
  } else if (action.startsWith('role_back_')) {
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Owner only.', show_alert: true });
    const targetId = action.slice('role_back_'.length);
    if (!/^\d+$/.test(targetId) || isOwner(targetId)) return bot.answerCallbackQuery(query.id, { text: 'Target tidak valid.', show_alert: true });
    const role = isAdmin(targetId) ? 'ADMIN' : isPrem(targetId) ? 'PREM' : isBuyer(targetId) ? 'RESS' : 'NO ROLE';
    const keyboard = { inline_keyboard: [
      [{ text: '👤 RESS', callback_data: `role_set_buyer_${targetId}` }, { text: '⭐ PREM', callback_data: `role_set_prem_${targetId}` }],
      [{ text: '🛡️ ADMIN', callback_data: `role_set_admin_${targetId}` }, { text: '🧩 ASISTEN', callback_data: `role_set_assistant_${targetId}` }],
      [{ text: '↩️ Kembali', callback_data: `role_back_${targetId}` }, { text: '❌ Batalkan', callback_data: 'role_cancel' }]
    ] };
    try { await bot.editMessageText(`🛡️ <b>PILIH ROLE UNTUK TARGET</b>\n\n📌 <b>ID:</b> <code>${targetId}</code>\n🎯 <b>Role sekarang:</b> <code>${role}</code>\n\nPilih role yang ingin diberikan pada menu di bawah ini.`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: keyboard }); } catch (_) {}
    return bot.answerCallbackQuery(query.id);
  } else if (action === 'set_api') {
    if (!(isOwner(userId) || isAdmin(userId))) return bot.answerCallbackQuery(query.id, { text: '❌ Owner/Admin only.' });
    sessions.set(skey, 'set_api');
    await bot.sendMessage(chatId, '⚙️ <b>SET RAILWAY API TOKEN</b>\n\n<b>Account Token:</b> kirim <code>TOKEN</code> — workspace dideteksi otomatis.\n\n<b>Workspace Token:</b> kirim <code>TOKEN WORKSPACE_ID</code> — workspace disimpan khusus untuk token tersebut.\n\n⚠️ Project Token tidak bisa dipakai untuk membuat VPS baru.\n\nSetiap token punya slot CREATE sendiri: maksimal <b>2 VPS aktif</b>.', { parse_mode: 'HTML' });
    return bot.answerCallbackQuery(query.id);
  } else if (action === 'delete_token_menu') {
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Owner only.', show_alert: true });
    const entries = Object.entries(railwayTokens).filter(([_, item]) => item && item.token);
    if (!entries.length) {
      await bot.sendMessage(chatId, '📭 <b>Tidak ada token tersimpan.</b>', { parse_mode: 'HTML' });
      return bot.answerCallbackQuery(query.id);
    }
    const buttons = entries.map(([alias, item]) => ([{ text: `🗑️ ${alias} (${Number(item.used || 0)}/${Math.max(1, Number(item.maxSlots || 2))})`, callback_data: `delete_token_${alias}` }]));
    buttons.push([{ text: '❌ Batal', callback_data: 'delete_token_cancel' }]);
    await bot.sendMessage(chatId, '🗑️ <b>HAPUS TOKEN RAILWAY</b>\n\nPilih token yang ingin dihapus.', { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    return bot.answerCallbackQuery(query.id);
  } else if (action === 'delete_token_cancel') {
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch (_) {}
    return bot.answerCallbackQuery(query.id, { text: 'Dibatalkan.' });
  } else if (action.startsWith('delete_token_')) {
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Owner only.', show_alert: true });
    const alias = action.slice('delete_token_'.length);
    if (!railwayTokens[alias]) return bot.answerCallbackQuery(query.id, { text: 'Token tidak ditemukan.', show_alert: true });
    const pending = Number(railwayTokens[alias]?.pending || 0);
    if (pending > 0) {
      let cancelled = 0;
      for (const [jobId, job] of activeCreates.entries()) {
        if (String(job.tokenAlias) === String(alias)) { cancelCreate(jobId); cancelled++; }
      }
      delete railwayTokens[alias];
      saveRailwayTokens();
      try { await bot.editMessageText(`🛑 <b>TOKEN DIHAPUS + PROSES DIHENTIKAN</b>\n\n🔑 ID Token: <code>${esc(alias)}</code>\n⏳ Proses aktif: <b>${cancelled}</b>\n\nCREATE akan berhenti pada tahap berikutnya.`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }); } catch (_) {}
      return bot.answerCallbackQuery(query.id, { text: 'Token dihapus dan proses dibatalkan.' });
    }
    delete railwayTokens[alias];
    saveRailwayTokens();
    try { await bot.editMessageText(`✅ <b>Token berhasil dihapus.</b>\n\nID Token: <code>${esc(alias)}</code>`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }); } catch (_) {}
    return bot.answerCallbackQuery(query.id, { text: 'Token dihapus.' });
    } else if (action.startsWith('stop_create_')) {
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Owner only.', show_alert: true });
    const jobId = action.slice('stop_create_'.length);
    const job = activeCreates.get(jobId);
    if (!job) return bot.answerCallbackQuery(query.id, { text: 'Proses sudah selesai/tidak ditemukan.', show_alert: true });
    cancelCreate(jobId);
    return bot.answerCallbackQuery(query.id, { text: '🛑 Proses CREATE dihentikan.' });
  } else if (action === 'vps_slot') {
    if (!hasAccess(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Kamu belum memiliki akses.', show_alert: true });
    await bot.sendMessage(chatId, `📊 <b>STATUS SLOT VPS</b>\n\n${slotSummaryText(userId)}\n\n${countUserVps(userId) >= getVpsLimit(userId) ? '⚠️ <b>Slot VPS kamu habis.</b>' : '✅ <b>Masih ada slot VPS yang tersedia.</b>'}`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '➕ TAMBAH SLOT', callback_data: 'extra_slot' }]] }
    });
    return bot.answerCallbackQuery(query.id);
  } else if (action === 'extra_slot') {
    if (!hasAccess(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Kamu belum memiliki akses.', show_alert: true });
    await bot.sendMessage(chatId, `➕ <b>TAMBAH SLOT VPS</b>\n\n${slotSummaryText(userId)}\n\n📦 <b>Slot tambahan</b> tidak mengubah role kamu. RESS tetap RESS, PREM tetap PREM.\n\n💬 Untuk menambah slot, silakan <b>chat Owner Bot</b> dan sebutkan jumlah slot yang kamu butuhkan.\n\n⚠️ Slot hanya akan ditambahkan setelah disetujui Owner.`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '💬 CHAT OWNER BOT', url: `tg://user?id=${setting.OWNER_ID}` }],
        [{ text: '📊 Refresh', callback_data: 'vps_slot' }]
      ] }
    });
    return bot.answerCallbackQuery(query.id);
  } else if (/^request_slot_(1|3|5)$/.test(action)) {
    if (!hasAccess(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Kamu belum memiliki akses.', show_alert: true });
    const amount = Number(action.match(/^request_slot_(\d+)$/i)?.[1] || action.split('_').pop());
    try {
      await bot.sendMessage(String(setting.OWNER_ID),
        `➕ <b>REQUEST EXTRA SLOT VPS</b>\n\n👤 User: ${esc(query.from?.username ? '@' + query.from.username : (query.from?.first_name || 'User'))}\n🆔 Telegram ID: <code>${esc(userId)}</code>\n🎯 Role: <b>${esc(getUserRole(userId))}</b>\n📊 Saat ini: <b>${countUserVps(userId)}/${vpsLimitText(userId)}</b>\n➕ Request: <b>+${amount} SLOT</b>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
          [{ text: `✅ ACC +${amount}`, callback_data: `approve_slot_${userId}_${amount}` }, { text: '❌ TOLAK', callback_data: `reject_slot_${userId}_${amount}` }]
        ] } }
      );
      await bot.sendMessage(chatId, `⏳ <b>REQUEST EXTRA SLOT DIKIRIM</b>\n\n➕ Permintaan: <b>+${amount} slot</b>\n📊 Slot sekarang: <b>${vpsLimitText(userId)}</b>\n\nTunggu Owner memproses permintaan kamu.`, { parse_mode: 'HTML' });
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Gagal mengirim request ke Owner: <code>${esc(e.message)}</code>`, { parse_mode: 'HTML' });
    }
    return bot.answerCallbackQuery(query.id, { text: `Request +${amount} slot dikirim.` });
  } else if (/^(approve|reject)_slot_\d+_\d+$/.test(action)) {
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Hanya Owner.', show_alert: true });
    const match = action.match(/^(approve|reject)_slot_(\d+)_(\d+)$/);
    const approved = match[1] === 'approve';
    const targetId = match[2];
    const amount = Number(match[3]);
    if (!approved) {
      try { await bot.sendMessage(targetId, `❌ <b>REQUEST EXTRA SLOT DITOLAK</b>\n\nPermintaan +${amount} slot ditolak Owner.`, { parse_mode: 'HTML' }); } catch (_) {}
      try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }); } catch (_) {}
      return bot.answerCallbackQuery(query.id, { text: 'Request slot ditolak.' });
    }
    extraSlots[targetId] = getExtraSlots(targetId) + amount;
    saveExtraSlots();
    try { await bot.sendMessage(targetId, `✅ <b>EXTRA SLOT DITAMBAHKAN</b>\n\n➕ Slot tambahan: <b>+${amount}</b>\n\n${slotSummaryText(targetId)}`, { parse_mode: 'HTML' }); } catch (_) {}
    try { await bot.editMessageText(`✅ <b>EXTRA SLOT DISETUJUI</b>\n\n👤 User ID: <code>${esc(targetId)}</code>\n➕ Ditambahkan: <b>+${amount} slot</b>\n📦 Extra Slot sekarang: <b>${getExtraSlots(targetId)}</b>`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }); } catch (_) {}
    return bot.answerCallbackQuery(query.id, { text: `+${amount} slot ditambahkan.` });
  } else if (action === 'create_vps') {
    if (!hasAccess(userId)) {
      return bot.answerCallbackQuery(query.id, { text: '🚫 Kamu tidak memiliki role untuk CREATE VPS.', show_alert: true });
    }
    const callbackVpsCount = countUserVps(userId);
    const callbackVpsLimit = getVpsLimit(userId);
    if (callbackVpsCount >= callbackVpsLimit) {
      await bot.sendMessage(chatId, `⚠️ <b>SLOT VPS HABIS</b>\n\n${slotSummaryText(userId)}\n\nKlik tombol di bawah untuk mengajukan slot tambahan.`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '➕ TAMBAH SLOT', callback_data: 'extra_slot' }]] }
      });
      return bot.answerCallbackQuery(query.id, { text: 'Slot VPS habis.', show_alert: true });
    }
    const available = Object.entries(railwayTokens).filter(([alias, item]) => item && item.token && (Number(item.used || 0) + Number(item.pending || 0)) < Math.max(1, Number(item.maxSlots || 2)));
    if (!available.length) {
      await bot.sendMessage(chatId, '🚫 𝗦𝗧𝗢𝗞 𝗩𝗣𝗦 𝗦𝗨𝗗𝗔𝗛 𝗛𝗔𝗕𝗜𝗦! \n━━━━━━━━━━━━━━━━━━━━⨳\n📨 𝗦𝗶𝗹𝗮𝗵𝗸𝗮𝗻 𝗛𝘂𝗯𝘂𝗻𝗴𝗶 𝗢𝘄𝗻𝗲𝗿\n𝗨𝗻𝘁𝘂𝗸 𝗦𝗲𝗴𝗲𝗿𝗮 𝗥𝗲𝘀𝘁𝗼𝗰𝗸 𝗩𝗣𝗦.', { parse_mode: 'HTML' });
      return bot.answerCallbackQuery(query.id);
    }
    // Tidak ada lagi menu pilih token. Bot akan memakai token pertama yang masih punya slot.
    // Jika token pertama sudah 2/2, otomatis lanjut ke token berikutnya, dan seterusnya.
    sessions.set(skey, 'create:auto');
    await bot.sendMessage(chatId, '🏷️ <b>NAMA VPS</b>\n\nKirim nama VPS (contoh: <code>vpsadrian</code>).\n\n🔄 <i>Token akan dipilih otomatis. Jika Token 1 sudah 2/2, bot otomatis lanjut ke Token 2, lalu token berikutnya.</i>\n💡 Di grup, balas pesan ini dengan nama VPS.', { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } });
    return bot.answerCallbackQuery(query.id);
  } else if (action === 'create_token_cancel') {
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch (_) {}
    return bot.answerCallbackQuery(query.id, { text: 'Dibatalkan.' });
  } else if (action.startsWith('create_select_token_')) {
    // Legacy callback dari pesan/menu lama: tidak lagi digunakan.
    return bot.answerCallbackQuery(query.id, { text: 'Pemilihan token sudah otomatis.', show_alert: false });
  } else if (action === 'check_stock') {
    // Stok CREATE VPS dihitung dari slot seluruh token Railway.
    const entries = Object.entries(railwayTokens).filter(([_, item]) => item && item.token);
    const maxTotal = entries.reduce((sum, [_, item]) => sum + Math.max(1, Number(item.maxSlots || 2)), 0);
    const usedTotal = entries.reduce((sum, [_, item]) => sum + Math.max(0, Number(item.used || 0)) + Math.max(0, Number(item.pending || 0)), 0);
    const availableTotal = Math.max(0, maxTotal - usedTotal);
    const activeTokenCount = entries.length;
    const tokenLines = entries.length
      ? entries.map(([alias, item], i) => {
          const max = Math.max(1, Number(item.maxSlots || 2));
          const used = Math.max(0, Number(item.used || 0));
          const pending = Math.max(0, Number(item.pending || 0));
          const free = Math.max(0, max - used - pending);
          return `${i + 1}. <code>${esc(alias)}</code> — ${free > 0 ? '🟢' : '🔴'} <b>${free}/${max}</b> slot`;
        }).join('\n')
      : '📭 Belum ada token Railway yang tersimpan.';

    await bot.sendMessage(chatId, `📦 <b>CEK STOK VPS</b>

☁️ Provider: <b>Railway</b>
🔑 Total Token: <b>${activeTokenCount}</b>
📊 Total Kapasitas: <b>${maxTotal}</b> VPS
🟢 Stok Tersedia: <b>${availableTotal}</b> VPS
🔴 Terpakai/Proses: <b>${usedTotal}</b> VPS

<b>Detail Stok Token:</b>
${tokenLines}

${availableTotal > 0 ? '✅ <b>Stok masih tersedia.</b>' : '⚠️ <b>Stok VPS sedang penuh.</b>'}`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '🔄 Refresh Stok', callback_data: 'check_stock' }],
        [{ text: '↩️ Kembali', callback_data: 'check_stock_back' }]
      ] }
    });
    return bot.answerCallbackQuery(query.id);
  } else if (action === 'check_stock_back') {
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch (_) {}
    return bot.answerCallbackQuery(query.id, { text: 'Kembali.' });
  } else if (action === 'menu_vps') {
    if (!hasAccess(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Kamu belum memiliki akses.', show_alert: true });
    await bot.sendMessage(chatId, `🖥️ <b>MENU VPS</b>

Kelola VPS kamu dari sini.

Pilih menu:
• 📋 <b>Cek VPS</b> — melihat daftar VPS dan statusnya
• 🛠️ <b>Install Panel Pterodactyl</b> — pasang Panel otomatis pada VPS Railway
• 🔁 <b>Rebuild VPS</b> — redeploy VPS yang dipilih`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [
        [{ text: '📋 CEK VPS', callback_data: 'list_vps' }],
        [{ text: '🖥️ CEK SPEK VPS', callback_data: 'vps_specs' }],
        [{ text: '🛠️ INSTALL PANEL', callback_data: 'install_panel' }],
        [{ text: '🔁 REBUILD VPS', callback_data: 'rebuild_vps' }],
        [{ text: '↩️ Kembali', callback_data: 'menu_vps_back' }]
      ] }
    });
    return bot.answerCallbackQuery(query.id);
  } else if (action === 'install_panel') {
    if (!hasAccess(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Kamu belum memiliki akses.', show_alert: true });
    const own = [...vpsStore.entries()].filter(([_, v]) => isOwner(userId) || String(v.ownerId) === String(userId));
    if (!own.length) {
      await bot.sendMessage(chatId, '🚫 <b>Belum ada VPS.</b> Buat VPS Railway terlebih dahulu.', { parse_mode: 'HTML' });
      return bot.answerCallbackQuery(query.id);
    }
    const buttons = own.map(([serviceId, v]) => ([{ text: `🛠️ ${String(v.name || serviceId).slice(0, 30)}`, callback_data: `install_panel_select_${serviceId}` }]));
    buttons.push([{ text: '↩️ Kembali', callback_data: 'menu_vps' }]);
    await bot.sendMessage(chatId, '🛠️ <b>INSTALL PANEL PTERODACTYL</b>\n\nPilih VPS Railway yang akan dipasang Pterodactyl Panel.\n\n🔐 <b>Metode:</b> SSH root langsung ke VPS.\n🗄️ MariaDB + 🔴 Redis + Nginx + PHP-FPM dipasang di VPS yang sama.\n🌐 Link memakai host/port Railway dari VPS.\n\n⚠️ VPS harus Ubuntu 22.04/24.04 dan memiliki root SSH.', { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    return bot.answerCallbackQuery(query.id);
  } else if (action.startsWith('install_panel_select_')) {
    if (!hasAccess(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Kamu belum memiliki akses.', show_alert: true });
    const serviceId = action.slice('install_panel_select_'.length);
    const vps = vpsStore.get(serviceId);
    if (!vps) return bot.answerCallbackQuery(query.id, { text: 'VPS tidak ditemukan.', show_alert: true });
    if (!isOwner(userId) && String(vps.ownerId) !== String(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ VPS ini bukan milik kamu.', show_alert: true });
    sessions.set(skey, `panel_domain:${serviceId}`);
    await bot.sendMessage(chatId, `🌐 <b>ALAMAT PANEL</b>\n\nInstaller akan memakai host + port SSH/TCP Railway VPS ini untuk akses Panel.\n\nKetik <code>auto</code> untuk memakai alamat Railway otomatis, atau masukkan domain sendiri jika DNS domain tersebut sudah diarahkan ke VPS.`, { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } });
    return bot.answerCallbackQuery(query.id);
  } else if (action === 'install_panel_cancel') {
    sessions.delete(skey);
    return bot.answerCallbackQuery(query.id, { text: 'Dibatalkan.' });
  } else if (action === 'panel_run_confirm') {
    const state = sessions.get(skey);
    if (!state || !state.startsWith('panel_run:')) return bot.answerCallbackQuery(query.id, { text: '❌ Sesi install sudah kedaluwarsa.', show_alert: true });
    sessions.delete(skey);
    const parts = state.split(':');
    const serviceId = parts[1];
    const requestedDomain = decodeURIComponent(parts[2] || 'auto');
    const email = parts[3];
    const username = parts[4];
    const first = decodeURIComponent(parts[5] || 'Admin');
    const last = decodeURIComponent(parts[6] || first);
    const password = decodeURIComponent(parts.slice(7).join(':'));
    const vps = vpsStore.get(serviceId);
    if (!vps) return bot.answerCallbackQuery(query.id, { text: '❌ VPS tidak ditemukan.', show_alert: true });

    await bot.editMessageText(`⏳ <b>INSTALL PANEL PTERODACTYL</b>\n\n🖥️ VPS: <code>${esc(vps.name || serviceId)}</code>\n\n🔐 Menghubungkan SSH root...`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }).catch(() => {});
    const progress = {
      chatId,
      messageId: query.message.message_id,
      header: `<b>🛠️ INSTALL PANEL PTERODACTYL</b>\n\nVPS Railway: <code>${esc(vps.name || serviceId)}</code>`
    };
    try {
      const tokenInfo = railwayTokens[vps.tokenAlias] || getAvailableToken();
      if (!tokenInfo?.token) throw new Error('Token Railway untuk VPS ini tidak tersedia.');
      if (!vps.projectId || !vps.environmentId) throw new Error('Project/Environment Railway pada VPS tidak lengkap.');
      const stack = await installPterodactylOverSsh(vps, { email, username, first, last, password }, progress, requestedDomain);

      vps.panel = {
        host: stack.domain,
        railwayDomain: stack.domain,
        port: 80,
        url: stack.appUrl,
        installedAt: Date.now(),
        adminUsername: username,
        adminEmail: email,
        panelServiceId: stack.panelServiceId,
        databaseServiceId: stack.dbServiceId,
        redisServiceId: stack.redisServiceId,
        databaseServiceName: stack.dbName,
        redisServiceName: stack.redisName,
        panelServiceName: stack.panelName,
        dockerImage: null
      };
      saveVpsStore();
      const note = requestedDomain && requestedDomain.toLowerCase() !== 'auto'
        ? `\n⚠️ Domain custom yang diketik tidak digunakan pada deployment ini. Railway Domain otomatis tetap dipakai: <code>${esc(stack.domain)}</code>.`
        : '';
      await bot.editMessageText(`✅ <b>PANEL PTERODACTYL BERHASIL DIINSTALL</b>\n\n🖥️ <b>VPS RAILWAY</b>\n<code>${esc(vps.name || serviceId)}</code>\n\n🌐 <b>HOST PANEL</b>\n<code>${esc(stack.domain)}</code>\n\n🔗 <b>LINK PANEL</b>\n<code>${esc(stack.appUrl)}</code>\n\n🗄️ Database: <code>MariaDB lokal</code>\n🔴 Redis: <code>Redis lokal</code>\n🧩 Nginx + PHP-FPM: <code>ACTIVE</code>\n\n👤 <b>LOGIN ADMIN</b>\nUsername: <code>${esc(username)}</code>\nEmail: <code>${esc(email)}</code>\nPassword: <code>${esc(password)}</code>${note}\n\n✅ Installer melakukan migration, seeding, queue, cron, konfigurasi Nginx, dan health-check HTTP sebelum menampilkan BERHASIL.\n\n⚠️ <b>Catatan Railway:</b> VPS Ubuntu SSH ini berjalan sebagai container; untuk persistensi setelah redeploy/recreate, gunakan volume Railway atau VPS VM tradisional.`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' });
    } catch (e) {
      await bot.editMessageText(`❌ <b>INSTALL PANEL GAGAL</b>\n\nError: <code>${esc(e.message)}</code>\n\n🔐 Metode: SSH root ke VPS.\n📄 Log installer: <code>/var/log/pterodactyl-auto-install.log</code>\n\nTidak ada resource Railway baru yang dibuat.`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }).catch(() => {});
    }
    return bot.answerCallbackQuery(query.id, { text: 'Proses install Panel selesai.' });
  } else if (action === 'menu_vps_back') {
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch (_) {}
    return bot.answerCallbackQuery(query.id, { text: 'Kembali.' });
  } else if (action === 'delete_vps') {
    const own = [...vpsStore.entries()]
      .filter(([_, v]) => isOwner(userId) || String(v.ownerId) === String(userId));
    if (!own.length) {
      await bot.sendMessage(chatId, '🚫 <b>Belum ada VPS yang bisa dihapus.</b>', { parse_mode: 'HTML' });
      return bot.answerCallbackQuery(query.id);
    }
    const buttons = own.map(([serviceId, v]) => ([{
      text: `🗑️ ${String(v.name).slice(0, 30)}`,
      callback_data: `delete_select_${serviceId}`
    }]));
    buttons.push([{ text: '❌ Batal', callback_data: 'delete_cancel' }]);
    await bot.sendMessage(chatId, '🗑️ <b>PILIH VPS YANG INGIN DIHAPUS</b>\n\nKlik VPS di bawah. Setelah berhasil dihapus, kuota token pembuat VPS akan otomatis kembali 1.', { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    return bot.answerCallbackQuery(query.id);
  } else if (action === 'delete_cancel') {
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch (_) {}
    return bot.answerCallbackQuery(query.id, { text: 'Dibatalkan.' });
  } else if (action.startsWith('delete_select_')) {
    const serviceId = action.slice('delete_select_'.length);
    const vps = vpsStore.get(serviceId);
    if (!vps) return bot.answerCallbackQuery(query.id, { text: 'VPS tidak ditemukan.', show_alert: true });
    if (!isOwner(userId) && String(vps.ownerId) !== String(userId)) {
      return bot.answerCallbackQuery(query.id, { text: 'VPS itu bukan milik akun kamu.', show_alert: true });
    }
    const tokenInfo = getAnyToken(vps.tokenAlias);
    if (!tokenInfo) return bot.answerCallbackQuery(query.id, { text: 'Token Railway untuk VPS ini tidak ditemukan.', show_alert: true });
    try {
      await bot.editMessageText(`⏳ <b>Menghapus VPS...</b>\n\nNama: <code>${esc(vps.name)}</code>`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' });
      // Hapus project Railway langsung agar service/VPS dan project induknya ikut terhapus.
      await deleteProject(vps.projectId, tokenInfo.token);
      vpsStore.delete(serviceId);
      saveVpsStore();
      const restored = restoreToken(tokenInfo.alias);
      await bot.sendMessage(chatId, `✅ <b>VPS + PROJECT berhasil dihapus.</b>\n\n📦 Nama: <code>${esc(vps.name)}</code>\n🗑️ Project Railway: <code>${esc(vps.projectId)}</code>\n🔑 Token: <code>${esc(tokenInfo.alias)}</code>\n📊 Kuota CREATE sekarang: <b>${restored ? restored.used + '/' + restored.maxSlots : '?'}</b>\n\nProject induk VPS tersebut sudah ikut dihapus. Token akan muncul kembali di menu <b>🟢 Buat VPS</b>.`, { parse_mode: 'HTML' });
    } catch (e) {
      await bot.sendMessage(chatId, `❌ <b>Gagal menghapus VPS.</b>\n\nError: <code>${esc(e.message)}</code>`, { parse_mode: 'HTML' });
    }
    return bot.answerCallbackQuery(query.id);
  } else if (action === 'list_vps') {
    try {
      if (!getAnyToken()) return bot.sendMessage(chatId, '⚠️ Railway API Token belum diatur oleh owner.');
      const own = [...vpsStore.entries()].filter(([_, v]) => isOwner(userId) || String(v.ownerId) === String(userId));
      if (!own.length) return bot.sendMessage(chatId, `🚫 Belum ada VPS untuk akun kamu.\n\n${slotSummaryText(userId)}`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '➕ TAMBAH SLOT', callback_data: 'extra_slot' }]] } });
      const lines = own.map(([serviceId, v]) => `• ${esc(v.name)}\n  ID: <code>${esc(serviceId)}</code>\n  Status: <code>ACTIVE</code>\n  Sisa masa aktif: <code>${esc(remainingVpsTime(v.expiresAt))}</code>`);
      await bot.sendMessage(chatId, `📋 <b>LIST VPS ${isOwner(userId) ? 'SEMUA' : 'SAYA'}</b>\n\n${slotSummaryText(userId)}\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '➕ TAMBAH SLOT', callback_data: 'extra_slot' }]] } });
    } catch (e) { await bot.sendMessage(chatId, `❌ Gagal mengambil list: ${esc(e.message)}`, { parse_mode: 'HTML' }); }
  } else if (action === 'vps_specs') {
    if (!hasAccess(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Kamu belum memiliki akses.', show_alert: true });
    const own = [...vpsStore.entries()].filter(([_, v]) => isOwner(userId) || String(v.ownerId) === String(userId));
    if (!own.length) {
      await bot.sendMessage(chatId, '🚫 <b>Belum ada VPS yang bisa dicek.</b>\n\nBuat VPS terlebih dahulu.', { parse_mode: 'HTML' });
      return bot.answerCallbackQuery(query.id);
    }
    const buttons = own.map(([serviceId, v]) => ([{ text: `🖥️ ${String(v.name || serviceId).slice(0, 30)}`, callback_data: `specs_select_${serviceId}` }]));
    buttons.push([{ text: '↩️ Kembali', callback_data: 'menu_vps' }]);
    await bot.sendMessage(chatId, '🖥️ <b>CEK SPEK VPS</b>\n\nPilih VPS yang ingin dicek. Bot akan terhubung langsung ke VPS dan mengambil CPU, RAM, Storage, OS, Kernel, dan Arsitektur.', { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    return bot.answerCallbackQuery(query.id);
  } else if (action.startsWith('specs_select_')) {
    if (!hasAccess(userId)) return bot.answerCallbackQuery(query.id, { text: '❌ Kamu belum memiliki akses.', show_alert: true });
    const serviceId = action.slice('specs_select_'.length);
    const vps = vpsStore.get(serviceId);
    if (!vps) return bot.answerCallbackQuery(query.id, { text: 'VPS tidak ditemukan.', show_alert: true });
    if (!isOwner(userId) && String(vps.ownerId) !== String(userId)) return bot.answerCallbackQuery(query.id, { text: 'VPS ini bukan milik kamu.', show_alert: true });
    await bot.answerCallbackQuery(query.id, { text: 'Mengambil spesifikasi VPS...' });
    const progress = await bot.sendMessage(chatId, `⏳ <b>CEK SPEK VPS</b>\n\n🖥️ VPS: <code>${esc(vps.name || serviceId)}</code>\n🔌 Menghubungkan ke VPS...`, { parse_mode: 'HTML' });
    try {
      const spec = await getVpsSpecs(vps);
      const text = `🖥️ <b>SPEK VPS</b>\n━━━━━━━━━━━━━━━━━━\n🏷️ Nama: <code>${esc(vps.name || serviceId)}</code>\n🟢 Status: <b>ACTIVE</b>\n\n🐧 <b>SYSTEM</b>\n» OS: <code>${esc(spec.os)}</code>\n» Kernel: <code>${esc(spec.kernel)}</code>\n» Arch: <code>${esc(spec.arch)}</code>\n\n⚙️ <b>CPU</b>\n» Core: <b>${esc(spec.cores)}</b>\n» Model: <code>${esc(spec.cpu)}</code>\n\n💾 <b>RAM</b>\n» Total: <b>${esc(spec.ramTotal)}</b>\n» Terpakai: <b>${esc(spec.ramUsed)}</b>\n» Tersedia: <b>${esc(spec.ramFree)}</b>\n\n💿 <b>STORAGE</b>\n» Total: <b>${esc(spec.diskTotal)}</b>\n» Terpakai: <b>${esc(spec.diskUsed)}</b>\n» Tersedia: <b>${esc(spec.diskFree)}</b>\n\n🌐 <b>NETWORK</b>\n» Host: <code>${esc(vps.host)}</code>\n» Port: <code>${esc(vps.port)}</code>\n\n⏳ Sisa masa aktif: <code>${esc(remainingVpsTime(vps.expiresAt))}</code>`;
      await bot.editMessageText(text, { chat_id: chatId, message_id: progress.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Cek Lagi', callback_data: `specs_select_${serviceId}` }], [{ text: '↩️ Menu VPS', callback_data: 'menu_vps' }]] } });
    } catch (e) {
      await bot.editMessageText(`❌ <b>GAGAL CEK SPEK VPS</b>\n\n🖥️ VPS: <code>${esc(vps.name || serviceId)}</code>\n\nError: <code>${esc(e.message)}</code>`, { chat_id: chatId, message_id: progress.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Coba Lagi', callback_data: `specs_select_${serviceId}` }], [{ text: '↩️ Menu VPS', callback_data: 'menu_vps' }]] } });
    }
    return;
  } else if (action === 'rebuild_vps') {
    if (!getAnyToken()) {
      await bot.sendMessage(chatId, '⚠️ Railway API Token belum diatur oleh owner.');
      return bot.answerCallbackQuery(query.id);
    }

    const own = [...vpsStore.entries()]
      .filter(([_, v]) => isOwner(userId) || String(v.ownerId) === String(userId));

    if (!own.length) {
      await bot.sendMessage(chatId, '🚫 Belum ada VPS yang bisa di-rebuild untuk akun kamu.');
      return bot.answerCallbackQuery(query.id);
    }

    const buttons = own.map(([serviceId, v]) => ([
      { text: `🔁 ${v.name || serviceId}`, callback_data: `rebuild_select_${serviceId}` }
    ]));
    buttons.push([{ text: '❌ Batal', callback_data: 'rebuild_cancel' }]);

    await bot.sendMessage(chatId, `🔁 <b>PILIH VPS UNTUK REBUILD</b>\n\nPilih salah satu VPS di bawah. Setelah dipilih, bot akan langsung menjalankan redeploy tanpa meminta Service ID atau Environment ID lagi.`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } else if (action === 'rebuild_cancel') {
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch (_) {}
    return bot.answerCallbackQuery(query.id, { text: 'Rebuild dibatalkan.' });
  } else if (action === 'rebuild_vps') {
    if (!getAnyToken()) {
      await bot.sendMessage(chatId, '⚠️ Railway API Token belum diatur oleh owner.');
      return bot.answerCallbackQuery(query.id);
    }

    const own = [...vpsStore.entries()]
      .filter(([_, v]) => isOwner(userId) || String(v.ownerId) === String(userId));

    if (!own.length) {
      await bot.sendMessage(chatId, '🚫 Belum ada VPS yang bisa di-rebuild untuk akun kamu.');
      return bot.answerCallbackQuery(query.id);
    }

    const buttons = own.map(([serviceId, v]) => ([
      { text: `🔁 ${v.name || serviceId}`, callback_data: `rebuild_select_${serviceId}` }
    ]));
    buttons.push([{ text: '❌ Batal', callback_data: 'rebuild_cancel' }]);

    await bot.sendMessage(chatId, `🔁 <b>PILIH VPS UNTUK REBUILD</b>\n\nPilih salah satu VPS di bawah. Setelah dipilih, bot akan langsung menjalankan redeploy tanpa meminta Service ID atau Environment ID lagi.`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    });
  } else if (action === 'rebuild_cancel') {
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch (_) {}
    return bot.answerCallbackQuery(query.id, { text: 'Rebuild dibatalkan.' });
  } else if (action.startsWith('rebuild_select_')) {
    if (!getAvailableToken()) {
      return bot.answerCallbackQuery(query.id, { text: 'API Token belum diatur.', show_alert: true });
    }

    const serviceId = action.replace('rebuild_select_', '');
    const vps = vpsStore.get(serviceId);
    if (!vps) {
      return bot.answerCallbackQuery(query.id, { text: 'VPS tidak ditemukan.', show_alert: true });
    }
    if (!isOwner(userId) && String(vps.ownerId) !== String(userId)) {
      return bot.answerCallbackQuery(query.id, { text: 'VPS ini bukan milik kamu.', show_alert: true });
    }

    await bot.answerCallbackQuery(query.id, { text: 'Memulai rebuild...' });
    try {
      await bot.editMessageText(`⏳ <b>REBUILD VPS</b>\n\nNama: <code>${esc(vps.name || serviceId)}</code>\n\n🔁 Mengirim perintah redeploy ke Railway...`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });
      await redeployService(serviceId, vps.environmentId);
      await bot.editMessageText(`✅ <b>REBUILD BERHASIL DIMULAI</b>\n\n🐧 VPS: <code>${esc(vps.name || serviceId)}</code>\n☁️ Provider: <code>Railway</code>\n🔁 Status: <code>REDEPLOYING</code>\n\n<i>Tunggu beberapa saat sampai VPS kembali aktif.</i>`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });
    } catch (e) {
      await bot.editMessageText(`❌ <b>GAGAL REBUILD VPS</b>\n\nVPS: <code>${esc(vps.name || serviceId)}</code>\nError: <code>${esc(e.message)}</code>`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });
    }
    return;
  }
  await bot.answerCallbackQuery(query.id);
});

bot.on('message', async (msg) => {
  const chatId = String(msg.chat.id);
  const userId = actorIdFromMessage(msg);
  const skey = sessionKey(chatId, userId);
  // Terima bukti pembayaran berupa foto/screenshot.
  if (msg.photo?.length && sessions.get(skey) === 'payment_proof') {
    if (hasAccess(userId)) { sessions.delete(skey); return bot.sendMessage(chatId, '✅ Akun kamu sudah memiliki akses.', { parse_mode: 'HTML' }); }
    if (hasPendingPayment(userId)) { sessions.delete(skey); return bot.sendMessage(chatId, '⏳ Pengajuan sebelumnya masih menunggu verifikasi.', { parse_mode: 'HTML' }); }
    const proof = msg.photo[msg.photo.length - 1];
    const orderId = `PAY-${Date.now()}-${String(userId).slice(-6)}`;
    paymentOrders[orderId] = { id: orderId, userId: String(userId), chatId: String(chatId), username: msg.from?.username || '', name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' '), price: PAYMENT_PRICE, status: 'pending', proofFileId: proof.file_id, caption: msg.caption || '', createdAt: Date.now() };
    savePaymentData(); sessions.delete(skey);
    await bot.sendMessage(chatId, `⏳ <b>BUKTI DITERIMA</b>\n\nID: <code>${esc(orderId)}</code>\n💰 Nominal: <b>${PAYMENT_PRICE}P</b>\n\nTunggu verifikasi Owner/Admin.`, { parse_mode: 'HTML' });
    try {
      await bot.sendPhoto(String(setting.OWNER_ID), proof.file_id, {
        caption: `💳 <b>PEMBAYARAN MANUAL MASUK</b>\n\n🧾 ID: <code>${esc(orderId)}</code>\n👤 User: <a href="tg://user?id=${esc(userId)}">${esc(msg.from?.username ? '@' + msg.from.username : (msg.from?.first_name || 'User'))}</a>\n🆔 User ID: <code>${esc(userId)}</code>\n💰 Nominal: <b>${PAYMENT_PRICE}P</b>`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✅ APPROVE', callback_data: `approve_payment_${userId}` }, { text: '❌ REJECT', callback_data: `reject_payment_${userId}` }]] }
      });
    } catch (_) {}
    return;
  }

  const text = msg.text?.trim();
  if (!text) return;
  registerBcallUser(msg);
  if (isMaintenanceBlocked(userId) && !/^\/(?:maintenance|mt)(?:@\w+)?(?:\s|$)/i.test(text)) {
    return bot.sendMessage(chatId, '🔧 <b>SYSTEM MAINTENANCE</b>\n\n⏳ Bot sedang diperbaiki &amp; di-upgrade.\n🚀 Silakan coba kembali nanti.\n\n🙏 <b>Terima kasih atas pengertiannya!</b>', { parse_mode: 'HTML' });
  }

  if (text && /^\/(?:buy|payment)(?:@\w+)?(?:\s|$)/i.test(text)) {
    if (hasAccess(userId)) return bot.sendMessage(chatId, '✅ <b>Akun kamu sudah memiliki akses.</b>', { parse_mode: 'HTML' });
    return sendPaymentMenu(chatId);
  }

  // /addgrup bisa digunakan di PV/DM maupun grup.
  if (/^\/addgrup(?:@\w+)?(?:\s|$)/i.test(text)) {
    if (!hasAccess(userId)) {
      return bot.sendMessage(chatId, '🚫 Kamu belum memiliki role untuk membuat VPS.', { parse_mode: 'HTML' });
    }
    const userVpsCount = countUserVps(userId);
    const userVpsLimit = getVpsLimit(userId);
    if (userVpsCount >= userVpsLimit) {
      return bot.sendMessage(chatId, `🚫 <b>LIMIT VPS TERCAPAI</b>\n\n📊 VPS aktif kamu: <b>${userVpsCount}/${vpsLimitText(userId)}</b>\n🛡️ Role: <b>${getUserRole(userId)}</b>\n\nHubungi Owner jika ingin limit diubah.`, { parse_mode: 'HTML' });
    }
    const available = Object.entries(railwayTokens).filter(([alias, item]) =>
      item && item.token &&
      (Number(item.used || 0) + Number(item.pending || 0)) < Math.max(1, Number(item.maxSlots || 2))
    );
    if (!available.length) {
      return bot.sendMessage(chatId, '⚠️ <b>Semua token sedang penuh.</b>\n\nHapus salah satu VPS untuk mengembalikan slot, atau tambahkan token baru.', { parse_mode: 'HTML' });
    }

    // Owner boleh langsung membuat VPS. User lain wajib menunggu approval Owner.
    if (!isOwner(userId)) {
      const approvalId = crypto.randomBytes(6).toString('hex');
      addApprovals[approvalId] = {
        id: approvalId, userId: String(userId), chatId: String(chatId),
        username: msg.from?.username || '',
        name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'User',
        groupTitle: msg.chat.title || '', createdAt: Date.now(), status: 'pending'
      };
      saveAddApprovals();
      await bot.sendMessage(chatId, '⏳ <b>PERMINTAAN /ADDGRUP DIKIRIM</b>\n\nVPS belum dibuat. Tunggu Owner menyetujui permintaan ini.', { parse_mode: 'HTML' });
      try {
        await bot.sendMessage(String(setting.OWNER_ID),
          `🖥️ <b>PERMINTAAN CREATE VPS</b>\n\n👤 User: <b>${esc(addApprovals[approvalId].name)}</b>\n🔗 Username: ${msg.from?.username ? '@' + esc(msg.from.username) : '-'}\n🆔 Telegram ID: <code>${esc(userId)}</code>\n👥 Grup: <b>${esc(msg.chat.title || '-')}</b>\n🆔 Request ID: <code>${approvalId}</code>`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
            { text: '✅ ACC /ADDGRUP', callback_data: `approve_add_${approvalId}` },
            { text: '❌ TOLAK', callback_data: `reject_add_${approvalId}` }
          ]] } }
        );
      } catch (_) {}
      return;
    }

    // chatId otomatis adalah ID grup tempat /addgrup dijalankan.
    sessions.set(skey, 'create:auto');
    await bot.sendMessage(chatId,
      `🏷️ <b>NAMA VPS</b>\n\nKirim nama VPS (contoh: <code>vpsadrian</code>).\n\n👥 <b>ID GRUP:</b> <code>${esc(chatId)}</code>\n📌 <i>ID grup otomatis tersimpan pada VPS ini.</i>`,
      { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } }
    );
    return;
  }

  // /ping: status VPS + status bot seperti format monitoring panel.
  if (/^\/ping(?:@\w+)?(?:\s|$)/i.test(text)) {
    const pingStart = Date.now();
    const formatDuration = (seconds) => {
      let s = Math.max(0, Math.floor(Number(seconds) || 0));
      const d = Math.floor(s / 86400); s %= 86400;
      const h = Math.floor(s / 3600); s %= 3600;
      const m = Math.floor(s / 60); s %= 60;
      const parts = [];
      if (d) parts.push(`${d}d`);
      if (h) parts.push(`${h}h`);
      if (m) parts.push(`${m}m`);
      parts.push(`${s}s`);
      return parts.join(' ');
    };
    const gb = (bytes) => (Number(bytes) / (1024 ** 3)).toFixed(2);
    const cpu = os.cpus()?.[0]?.model || 'Unknown CPU';
    const cores = os.cpus()?.length || 0;
    const load = os.loadavg().map(v => v.toFixed(2)).join(' / ');
    const totalRam = os.totalmem();
    const freeRam = os.freemem();
    const usedRam = totalRam - freeRam;

    let diskTotal = 0;
    let diskUsed = 0;
    try {
      const { stdout } = await execFileAsync('df', ['-kP', '/'], { timeout: 5000 });
      const line = stdout.trim().split('\n').pop();
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5) {
        diskTotal = Number(parts[1]) * 1024;
        diskUsed = Number(parts[2]) * 1024;
      }
    } catch (_) {}

    let botName = 'CVPS ADRIAN';
    try {
      const me = await bot.getMe();
      botName = me.first_name || me.username || botName;
    } catch (_) {}

    const from = msg.from || {};
    const username = from.username ? `@${from.username}` : (from.first_name || 'Unknown');
    const roles = [];
    if (isOwner(userId)) roles.push('owner');
    if (isAdmin(userId)) roles.push('admin');
    if (isPrem(userId)) roles.push('prem');
    if (isAssistant(userId)) roles.push('assistant');
    if (isBuyer(userId)) roles.push('ress');
    const role = roles.length ? roles.join(' + ') : 'no role';

    // Railway region: ubah kode region menjadi nama lokasi yang mudah dibaca.
    // Railway saat ini menyediakan 4 deployment regions.
    const railwayRegionNames = {
      'us-west2': 'California',
      'us-west2-eqdc4a': 'California',
      'us-east4': 'Virginia',
      'us-east4-eqdc4a': 'Virginia',
      'europe-west4': 'Amsterdam',
      'europe-west4-drams3a': 'Amsterdam',
      'asia-southeast1': 'Singapore',
      'asia-southeast1-eqsg3a': 'Singapore'
    };
    const rawRailwayRegion = String(process.env.RAILWAY_REPLICA_REGION || '').trim();
    const vpsRegion = railwayRegionNames[rawRailwayRegion] ||
      (rawRailwayRegion ? rawRailwayRegion : 'Singapore');

    const responseMs = Math.max(1, Date.now() - pingStart);

    const pingText = `
<b>🏓 PONG</b> ☑️

<b>RESPONS :</b> ${responseMs} ms

━━━━━━━━ <b>VPS STATUS</b> 🔵 ━━━━━━━━

🌀 <b>VPS UPTIME :</b> ${formatDuration(os.uptime())}
🌍 <b>VPS REGION :</b> ${esc(vpsRegion)}
🖥️ <b>CPU TYPE :</b> ${esc(cpu)}
<b>CORE CPU :</b> ${cores}
📊 <b>LOAD AVG :</b> ${load}
💾 <b>RAM :</b> ${gb(usedRam)} GB / ${gb(totalRam)} GB

━━━━━━━━ <b>STORAGE</b> 💿 ━━━━━━━━

💿 <b>DISK TOTAL :</b> ${diskTotal ? `${gb(diskUsed)} GB / ${gb(diskTotal)} GB` : 'Unavailable'}

━━━━━━━━ <b>BOT STATUS</b> 🤖 ━━━━━━━━

🤖 <b>BOT NAME :</b> ${esc(botName)}
🤖 <b>BOT UPTIME :</b> ${formatDuration(process.uptime())}
💎 <b>USER :</b> ${esc(username)}
🪪 <b>ID USER :</b> ${esc(userId)}
🏷️ <b>ROLE :</b> ${esc(role)}

<i>PING BOT BY ADRIAN</i>`;

    return bot.sendMessage(chatId, pingText.trim(), { parse_mode: 'HTML' });
  }

  // /cekrole: cek role sendiri, atau reply pesan user untuk cek role user tersebut.
  if (/^\/cekrole(?:@\w+)?(?:\s|$)/i.test(text)) {
    const targetId = msg.reply_to_message?.from?.id ? String(msg.reply_to_message.from.id) : userId;
    const roles = [];
    if (isOwner(targetId)) roles.push('OWNER');
    if (isAdmin(targetId)) roles.push('ADMIN');
    if (isPrem(targetId)) roles.push('PREM');
    if (isAssistant(targetId)) roles.push('ASISTEN');
    if (isBuyer(targetId)) roles.push('RESS');
    if (!roles.length) roles.push('NO ROLE');
    const isReplyCheck = Boolean(msg.reply_to_message?.from?.id);
    const displayName = msg.reply_to_message?.from ? [msg.reply_to_message.from.first_name, msg.reply_to_message.from.last_name].filter(Boolean).join(' ') : '';
    return bot.sendMessage(chatId, `🔎 <b>CEK ROLE</b>\n\n👤 ${isReplyCheck ? 'Target' : 'User'}: <b>${esc(displayName || 'User')}</b>\n🆔 User ID: <code>${esc(targetId)}</code>\n🛡️ Role: <b>${roles.join(' + ')}</b>\n📌 Akses VPS: <b>${hasAccess(targetId) ? 'AKTIF' : 'TIDAK AKTIF'}</b>`, { parse_mode: 'HTML' });
  }

  // /cekstok versi simple: hanya ringkasan stok tanpa detail token.
  if (/^\/cekstok(?:@\w+)?(?:\s|$)/i.test(text)) {
    const entries = Object.values(railwayTokens).filter(item => item && item.token);
    if (!entries.length) {
      return bot.sendMessage(chatId, '📦 <b>CEK STOK</b>\n\n⚠️ Belum ada Railway API Token.\nTambahkan token melalui <b>⚙️ SET API TOKEN</b>.', { parse_mode: 'HTML' });
    }
    let totalUsed = 0, totalPending = 0, totalSlots = 0;
    for (const item of entries) {
      const used = Number(item.used || 0);
      const pending = Number(item.pending || 0);
      const max = Math.max(1, Number(item.maxSlots || 2));
      totalUsed += used;
      totalPending += pending;
      totalSlots += max;
    }
    const available = Math.max(0, totalSlots - totalUsed - totalPending);
    return bot.sendMessage(chatId,
      `📦 <b>CEK STOK</b>\n\n🎟️ Total Token: <b>${entries.length}</b>\n📊 Terpakai: <b>${totalUsed}/${totalSlots}</b>\n⏳ Diproses: <b>${totalPending}</b>\n🟢 Tersedia: <b>${available}</b>`,
      { parse_mode: 'HTML' }
    );
  }

  // ================= EXTRA SLOT VPS =================
  if (isOwner(userId) && /^\/setslot(?:@\w+)?\s+/i.test(text)) {
    const args = text.replace(/^\/setslot(?:@\w+)?\s*/i, '').trim().split(/\s+/);
    const targetId = String(args[0] || '');
    const amount = Number(args[1]);
    if (!/^\d+$/.test(targetId) || !Number.isInteger(amount) || amount < 0 || amount > 1000)
      return bot.sendMessage(chatId, '❌ Format: <code>/setslot USER_ID JUMLAH</code>', { parse_mode: 'HTML' });
    extraSlots[targetId] = amount;
    saveExtraSlots();
    return bot.sendMessage(chatId, `✅ <b>EXTRA SLOT DISETEL</b>\n\n🆔 User: <code>${esc(targetId)}</code>\n➕ Extra Slot: <b>${amount}</b>`, { parse_mode: 'HTML' });
  }
  if (isOwner(userId) && /^\/delslot(?:@\w+)?\s+/i.test(text)) {
    const args = text.replace(/^\/delslot(?:@\w+)?\s*/i, '').trim().split(/\s+/);
    const targetId = String(args[0] || '');
    const amount = Number(args[1]);
    if (!/^\d+$/.test(targetId) || !Number.isInteger(amount) || amount < 1)
      return bot.sendMessage(chatId, '❌ Format: <code>/delslot USER_ID JUMLAH</code>', { parse_mode: 'HTML' });
    extraSlots[targetId] = Math.max(0, getExtraSlots(targetId) - amount);
    saveExtraSlots();
    return bot.sendMessage(chatId, `✅ <b>EXTRA SLOT DIKURANGI</b>\n\n🆔 User: <code>${esc(targetId)}</code>\n➖ Dikurangi: <b>${amount}</b>\n➕ Extra Slot sekarang: <b>${getExtraSlots(targetId)}</b>`, { parse_mode: 'HTML' });
  }

  // ================= VPS LIMIT & EXPIRED CONFIG =================
  if (isOwner(userId) && /^\/setvpslimit(?:@\w+)?\s+/i.test(text)) {
    const args = text.replace(/^\/setvpslimit(?:@\w+)?\s*/i, '').trim().split(/\s+/);
    let role = String(args[0] || '').toUpperCase();
    const value = String(args[1] || '').toLowerCase();
    if (role === 'BUYER') role = 'RESS';
    if (!['RESS', 'PREM', 'ADMIN', 'OWNER'].includes(role)) return bot.sendMessage(chatId, '❌ Role harus RESS, PREM, ADMIN, atau OWNER.');
    if (value === 'unlimited' || value === '0') vpsSettings.limits[role] = 0;
    else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 100) return bot.sendMessage(chatId, '❌ Limit harus 1-100 atau <code>unlimited</code>.', { parse_mode: 'HTML' });
      vpsSettings.limits[role] = n;
    }
    saveVpsSettings();
    return bot.sendMessage(chatId, `✅ <b>LIMIT VPS DIPERBARUI</b>\n\n🛡️ Role: <b>${role}</b>\n📊 Limit: <b>${vpsSettings.limits[role] || 'UNLIMITED'}</b>`, { parse_mode: 'HTML' });
  }
  if (isOwner(userId) && /^\/setvpsdays(?:@\w+)?\s+/i.test(text)) {
    const args = text.replace(/^\/setvpsdays(?:@\w+)?\s*/i, '').trim().split(/\s+/);
    let role = String(args[0] || '').toUpperCase();
    const n = Number(args[1]);
    if (role === 'BUYER') role = 'RESS';
    if (!['RESS', 'PREM', 'ADMIN', 'OWNER'].includes(role)) return bot.sendMessage(chatId, '❌ Role harus RESS, PREM, ADMIN, atau OWNER.');
    if (!Number.isInteger(n) || n < 1 || n > 3650) return bot.sendMessage(chatId, '❌ Masa aktif harus 1-3650 hari.');
    vpsSettings.durationDays[role] = n;
    saveVpsSettings();
    return bot.sendMessage(chatId, `✅ <b>MASA AKTIF VPS DIPERBARUI</b>\n\n🛡️ Role: <b>${role}</b>\n⏱️ Durasi: <b>${n} hari</b>`, { parse_mode: 'HTML' });
  }
  if (isOwner(userId) && /^\/vpsconfig(?:@\w+)?(?:\s|$)/i.test(text)) {
    return bot.sendMessage(chatId, `⚙️ <b>VPS CONFIG</b>\n\n👤 RESS: <b>${vpsSettings.limits.RESS || 'UNLIMITED'}</b> VPS / <b>${vpsSettings.durationDays.RESS} hari</b>\n⭐ PREM: <b>${vpsSettings.limits.PREM || 'UNLIMITED'}</b> VPS / <b>${vpsSettings.durationDays.PREM} hari</b>\n🛡️ ADMIN: <b>${vpsSettings.limits.ADMIN || 'UNLIMITED'}</b> VPS / <b>${vpsSettings.durationDays.ADMIN} hari</b>\n👑 OWNER: <b>${vpsSettings.limits.OWNER || 'UNLIMITED'}</b> VPS / <b>${vpsSettings.durationDays.OWNER} hari</b>\n\nPerintah: <code>/setvpslimit ROLE JUMLAH</code>\nContoh: <code>/setvpslimit RESS 2</code>\n<code>/setvpslimit ADMIN unlimited</code>\n\nMasa aktif: <code>/setvpsdays ROLE HARI</code>`, { parse_mode: 'HTML' });
  }

  // /addrole: buka menu pemilihan role sesuai role yang memang tersedia di bot.
  // Target bisa diberikan dengan ID atau cukup reply pesan user lalu ketik /addrole.
  if (isOwner(userId) && /^\/addrole(?:@\w+)?(?:\s|$)/i.test(text)) {
    const args = text.split(/\s+/).slice(1).filter(Boolean);
    let targetId = args[0];
    let targetName = '';
    if (!targetId && msg.reply_to_message?.from?.id && !msg.reply_to_message.from.is_bot) {
      targetId = String(msg.reply_to_message.from.id);
      targetName = [msg.reply_to_message.from.first_name, msg.reply_to_message.from.last_name].filter(Boolean).join(' ');
      if (msg.reply_to_message.from.username) targetName = `@${msg.reply_to_message.from.username}`;
    }
    if (!targetId || !/^\d+$/.test(targetId)) {
      return bot.sendMessage(chatId, '🛡️ <b>ROLE MANAGER</b>\n\nReply pesan user dengan <code>/addrole</code> atau gunakan <code>/addrole USER_ID</code>.', { parse_mode: 'HTML' });
    }
    if (isOwner(targetId)) return bot.sendMessage(chatId, '❌ Role Owner tidak dapat diubah melalui menu ini.', { parse_mode: 'HTML' });
    if (!targetName) targetName = `User ${targetId}`;
    const roleText = () => {
      if (isAdmin(targetId)) return 'ADMIN';
      if (isPrem(targetId)) return 'PREM';
      if (isAssistant(targetId)) return 'ASISTEN';
      if (isBuyer(targetId)) return 'RESS';
      return 'NO ROLE';
    };
    const keyboard = { inline_keyboard: [
      [{ text: '👤 RESS', callback_data: `role_set_buyer_${targetId}` }, { text: '⭐ PREM', callback_data: `role_set_prem_${targetId}` }],
      [{ text: '🛡️ ADMIN', callback_data: `role_set_admin_${targetId}` }, { text: '🧩 ASISTEN', callback_data: `role_set_assistant_${targetId}` }],
      [{ text: '↩️ Kembali', callback_data: `role_back_${targetId}` }, { text: '❌ Batalkan', callback_data: 'role_cancel' }]
    ] };
    return bot.sendMessage(chatId, `🛡️ <b>PILIH ROLE UNTUK TARGET</b>\n\n👤 <b>Username:</b> ${esc(targetName)}\n📌 <b>ID:</b> <code>${esc(targetId)}</code>\n\n🎯 <b>Role sekarang:</b> <code>${roleText()}</code>\n\nPilih role yang ingin diberikan pada menu di bawah ini.`, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  // ================= ROLE ASISTEN =================
  // Asisten: role dengan hak akses penggunaan bot (hasAccess), bukan Owner.
  if (isOwner(userId) && text.startsWith('/addassistant')) {
    const args = text.split(/\s+/).slice(1).filter(Boolean);
    let id = args[0];
    if (!id && msg.reply_to_message?.from?.id && !msg.reply_to_message.from.is_bot) id = String(msg.reply_to_message.from.id);
    if (!id || !/^\d+$/.test(id)) return bot.sendMessage(chatId, '❌ Format: <code>/addassistant 123456789</code> atau reply pesan user dengan <code>/addassistant</code>.', { parse_mode: 'HTML' });
    if (isOwner(id)) return bot.sendMessage(chatId, '❌ Owner tidak perlu diberi role Asisten.');
    buyers.delete(String(id)); prems.delete(String(id)); admins.delete(String(id));
    assistants.add(String(id));
    saveRoles();
    return bot.sendMessage(chatId, `✅ <b>ROLE ASISTEN DITAMBAHKAN</b>\n\n👤 User ID: <code>${esc(id)}</code>\n🧩 Akses: <b>penggunaan bot</b> (bukan Owner)`, { parse_mode: 'HTML' });
  }
  if (isOwner(userId) && text.startsWith('/delassistant')) {
    const id = text.split(/\s+/)[1];
    if (!id || !/^\d+$/.test(id)) return bot.sendMessage(chatId, '❌ Format: <code>/delassistant 123456789</code>', { parse_mode: 'HTML' });
    assistants.delete(String(id));
    saveRoles();
    return bot.sendMessage(chatId, `✅ Role Asisten <code>${esc(id)}</code> dihapus.`, { parse_mode: 'HTML' });
  }
  if (isOwner(userId) && text === '/assistants') {
    const list = [...assistants].map((id, i) => `${i + 1}. <code>${esc(id)}</code>`).join('\n') || 'Belum ada role Asisten.';
    return bot.sendMessage(chatId, `🧩 <b>DAFTAR ASISTEN</b>\n\n${list}\n\nAsisten memiliki akses penggunaan bot (bukan Owner).`, { parse_mode: 'HTML' });
  }

  if (isOwner(userId) && text.startsWith('/addadmin')) {
    const args = text.split(/\s+/).slice(1).filter(Boolean);
    let id = args[0];
    if (!id && msg.reply_to_message?.from?.id && !msg.reply_to_message.from.is_bot) id = String(msg.reply_to_message.from.id);
    if (!id || !/^\d+$/.test(id)) return bot.sendMessage(chatId, '❌ Format: <code>/addadmin 123456789</code> atau reply pesan user dengan <code>/addadmin</code>.', { parse_mode: 'HTML' });
    admins.add(String(id)); saveRoles();
    return bot.sendMessage(chatId, `✅ <b>ADMIN DITAMBAHKAN</b>\n\n👤 User ID: <code>${esc(id)}</code>`, { parse_mode: 'HTML' });
  }
  if (isOwner(userId) && text.startsWith('/deladmin')) {
    const id = text.split(/\s+/)[1];
    if (!id || !/^\d+$/.test(id)) return bot.sendMessage(chatId, '❌ Format: <code>/deladmin 123456789</code>', { parse_mode: 'HTML' });
    admins.delete(String(id)); saveRoles();
    return bot.sendMessage(chatId, `✅ Admin <code>${esc(id)}</code> dihapus.`, { parse_mode: 'HTML' });
  }
  if (isOwner(userId) && text === '/admins') {
    const list = [...admins].map((id, i) => `${i + 1}. <code>${esc(id)}</code>`).join('\n') || 'Belum ada admin.';
    return bot.sendMessage(chatId, `🛡️ <b>DAFTAR ADMIN</b>\n\n${list}`, { parse_mode: 'HTML' });
  }
  if ((isOwner(userId) || isAdmin(userId)) && text.startsWith('/addprem')) {
    const args = text.split(/\s+/).slice(1).filter(Boolean);
    if (msg.reply_to_message?.from?.id && !msg.reply_to_message.from.is_bot && args.length === 0) {
      const id = String(msg.reply_to_message.from.id);
      prems.add(id); saveRoles();
      return bot.sendMessage(chatId, `✅ <b>ROLE PREM DITAMBAHKAN</b>\n\n👤 User ID: <code>${esc(id)}</code>`, { parse_mode: 'HTML' });
    }
    const id = args[0];
    if (!id || !/^\d+$/.test(id)) return bot.sendMessage(chatId, '❌ Format: <code>/addprem 123456789</code> atau reply pesan user dengan <code>/addprem</code>.', { parse_mode: 'HTML' });
    prems.add(id); saveRoles();
    return bot.sendMessage(chatId, `✅ <b>ROLE PREM DITAMBAHKAN</b>\n\n👤 User ID: <code>${esc(id)}</code>`, { parse_mode: 'HTML' });
  }
  if (isOwner(userId) && text.startsWith('/delprem')) {
    const id = text.split(/\s+/)[1];
    if (!id || !/^\d+$/.test(id)) return bot.sendMessage(chatId, '❌ Format: <code>/delprem 123456789</code>', { parse_mode: 'HTML' });
    prems.delete(String(id)); saveRoles();
    return bot.sendMessage(chatId, `✅ Role Prem <code>${esc(id)}</code> dihapus.`, { parse_mode: 'HTML' });
  }
  if (isOwner(userId) && text === '/prems') {
    const list = [...prems].map((id, i) => `${i + 1}. <code>${esc(id)}</code>`).join('\n') || 'Belum ada role prem.';
    return bot.sendMessage(chatId, `⭐ <b>DAFTAR ROLE PREM</b>\n\n${list}`, { parse_mode: 'HTML' });
  }
  if (canManageBuyer(userId) && text.startsWith('/addbuyer')) {
    const args = text.split(/\s+/).slice(1).filter(Boolean);

    // Cara cepat: reply pesan user lalu ketik /addbuyer
    if (msg.reply_to_message?.from?.id && !msg.reply_to_message.from.is_bot && args.length === 0) {
      const id = String(msg.reply_to_message.from.id);
      buyers.add(id);
      saveRoles();
      return bot.sendMessage(chatId, `✅ <b>BUYER DITAMBAHKAN</b>\n\n👤 User ID: <code>${esc(id)}</code>`, { parse_mode: 'HTML' });
    }

    // /addbuyer 123456789 tetap didukung
    if (args[0]) {
      const id = args[0];
      if (!/^\d+$/.test(id)) return bot.sendMessage(chatId, '❌ User ID harus berupa angka.', { parse_mode: 'HTML' });
      buyers.add(String(id));
      saveRoles();
      return bot.sendMessage(chatId, `✅ <b>BUYER DITAMBAHKAN</b>\n\n👤 User ID: <code>${esc(id)}</code>`, { parse_mode: 'HTML' });
    }

    // Tanpa ID: minta owner membalas pesan ini dengan User ID
    sessions.set(skey, 'add_buyer_reply');
    return bot.sendMessage(chatId, '👥 <b>TAMBAH BUYER</b>\n\nBalas/reply pesan ini dengan <b>User ID Telegram</b> buyer.\n\nAtau cara lebih cepat: reply pesan buyer lalu ketik <code>/addbuyer</code>.', {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, selective: true }
    });
  }
  if (isOwner(userId) && text.startsWith('/delbuyer')) {
    const id = text.split(/\s+/)[1];
    if (!id || !/^\d+$/.test(id)) return bot.sendMessage(chatId, '❌ Format: <code>/delbuyer 123456789</code>', { parse_mode: 'HTML' });
    buyers.delete(String(id));
    saveRoles();
    return bot.sendMessage(chatId, `✅ Buyer <code>${esc(id)}</code> dihapus.` , { parse_mode: 'HTML' });
  }
  if (isOwner(userId) && text === '/buyers') {
    const list = [...buyers].map((id, i) => `${i + 1}. <code>${esc(id)}</code>`).join('\n') || 'Belum ada buyer.';
    return bot.sendMessage(chatId, `👥 <b>DAFTAR BUYER</b>\n\n${list}`, { parse_mode: 'HTML' });
  }
  if (text.startsWith('/')) return;
  const action = sessions.get(skey);
  if (action === 'add_buyer_reply') {
    sessions.delete(skey);
    const id = text.trim();
    if (!/^\d+$/.test(id)) {
      return bot.sendMessage(chatId, '❌ User ID harus berupa angka. Klik /addbuyer lagi untuk mencoba.');
    }
    buyers.add(String(id));
    saveRoles();
    return bot.sendMessage(chatId, `✅ <b>BUYER DITAMBAHKAN</b>\n\n👤 User ID: <code>${esc(id)}</code>`, { parse_mode: 'HTML' });
  }
  if (!action) return;
  if (!action) return;

  if (action === 'set_api') {
    sessions.delete(skey);
    const parts = text.replace(/^Bearer\s+/i, '').trim().split(/\s+/);
    const token = parts[0] || '';
    const maxSlots = 2;
    if (token.length < 10) {
      await bot.sendMessage(chatId, '❌ API Token tidak valid atau terlalu pendek. Silakan klik SET API TOKEN lagi.');
      return;
    }
    try {
      const workspaceId = parts[1] || '';
      let detectedWorkspace = null;
      if (workspaceId) {
        // Workspace Token: validasi ID sebelum token disimpan.
        detectedWorkspace = await getWorkspaceForToken(token, workspaceId);
      } else {
        // Account Token: validasi + deteksi workspace sekarang agar token kedua tidak gagal diam-diam saat CREATE.
        detectedWorkspace = await getWorkspaceForToken(token);
      }
      const alias = await addRailwayToken(token, detectedWorkspace.id);
      railwayTokens[alias].maxSlots = maxSlots;
      railwayTokens[alias].workspaceName = detectedWorkspace.name || '';
      saveRailwayTokens();
      const info = railwayTokens[alias];
      try {
        const actorName = msg.from?.username
          ? `@${msg.from.username}`
          : (msg.from?.first_name || 'Tanpa Username');
        await bot.sendMessage(String(setting.OWNER_ID),
          `🔐 <b>LOG ADD TOKEN RAILWAY</b>\n\n` +
          `👤 Ditambahkan oleh: <a href="tg://user?id=${esc(userId)}">${esc(actorName)}</a>\n` +
          `🆔 User ID: <code>${esc(userId)}</code>\n` +
          `💬 Chat ID: <code>${esc(chatId)}</code>\n` +
          `🔑 ID Token: <code>${esc(alias)}</code>\n` +
          `🏢 Workspace: <b>${esc(detectedWorkspace.name || '-')}</b>\n` +
          `🆔 Workspace ID: <code>${esc(detectedWorkspace.id)}</code>\n` +
          `📊 Slot: <b>${Number(info.used || 0)}/${Number(info.maxSlots || 2)}</b>\n` +
          `🕐 Waktu: <code>${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}</code>`,
          { parse_mode: 'HTML' }
        );
      } catch (_) {}
      await bot.sendMessage(chatId, `✅ <b>Railway API Token berhasil ditambahkan.</b>\n\n🔑 ID Token: <code>${esc(alias)}</code>\n🏢 Workspace: <b>${esc(detectedWorkspace.name || '-')}</b>\n🆔 Workspace ID: <code>${esc(detectedWorkspace.id)}</code>\n📊 Slot: <b>${Number(info.used || 0)}/${Number(info.maxSlots || 2)}</b>\n\nToken ini akan selalu memakai workspace tersebut saat CREATE.`, { parse_mode: 'HTML' });
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Gagal menyimpan token: <code>${esc(e.message)}</code>`, { parse_mode: 'HTML' });
    }
    return;
  }

  if (action.startsWith('panel_domain:')) {
    const serviceId = action.slice('panel_domain:'.length);
    const vps = vpsStore.get(serviceId);
    if (!vps) { sessions.delete(skey); return bot.sendMessage(chatId, '❌ VPS tidak ditemukan.'); }
    const requestedDomain = text.trim();
    sessions.set(skey, `panel_email:${serviceId}:${requestedDomain}`);
    return bot.sendMessage(chatId, '📧 <b>EMAIL ADMIN PANEL</b>\n\nKirim email admin Pterodactyl.', { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } });
  }
  if (action.startsWith('panel_email:')) {
    const m = action.match(/^panel_email:([^:]+):(.*)$/);
    if (!m) { sessions.delete(skey); return bot.sendMessage(chatId, '❌ Sesi install tidak valid.'); }
    const [, serviceId, requestedDomain] = m;
    const email = text.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bot.sendMessage(chatId, '❌ Format email tidak valid.');
    sessions.set(skey, `panel_user:${serviceId}:${requestedDomain}:${email}`);
    return bot.sendMessage(chatId, '👤 <b>USERNAME ADMIN</b>\n\nMinimal 3 karakter, contoh: <code>admin</code>.', { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } });
  }
  if (action.startsWith('panel_user:')) {
    const parts = action.split(':');
    const serviceId = parts[1]; const requestedDomain = parts[2]; const email = parts.slice(3).join(':');
    const username = text.trim();
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return bot.sendMessage(chatId, '❌ Username tidak valid.');
    sessions.set(skey, `panel_name:${serviceId}:${requestedDomain}:${email}:${username}`);
    return bot.sendMessage(chatId, '📝 <b>NAMA ADMIN</b>\n\nKirim nama depan dan belakang, contoh: <code>Adrian Cloud</code>.', { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } });
  }
  if (action.startsWith('panel_name:')) {
    const parts = action.split(':');
    const serviceId = parts[1]; const requestedDomain = parts[2]; const email = parts[3]; const username = parts[4];
    const names = text.trim().split(/\s+/);
    if (!names[0]) return bot.sendMessage(chatId, '❌ Nama tidak boleh kosong.');
    const first = names.shift(); const last = names.join(' ') || first;
    sessions.set(skey, `panel_pass:${serviceId}:${requestedDomain}:${email}:${username}:${encodeURIComponent(first)}:${encodeURIComponent(last)}`);
    return bot.sendMessage(chatId, '🔐 <b>PASSWORD ADMIN PANEL</b>\n\nMinimal 8 karakter. Pesan password akan dihapus setelah diterima.', { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } });
  }
  if (action.startsWith('panel_pass:')) {
    const parts = action.split(':');
    const serviceId = parts[1]; const requestedDomain = parts[2]; const email = parts[3]; const username = parts[4];
    const first = decodeURIComponent(parts[5]); const last = decodeURIComponent(parts[6] || parts[5]);
    const password = text.trim();
    if (password.length < 8) return bot.sendMessage(chatId, '❌ Password minimal 8 karakter.');
    sessions.set(skey, `panel_run:${serviceId}:${requestedDomain}:${email}:${username}:${encodeURIComponent(first)}:${encodeURIComponent(last)}:${encodeURIComponent(password)}`);
    try { await bot.deleteMessage(chatId, msg.message_id); } catch (_) {}
    return bot.sendMessage(chatId, '⚙️ <b>DATA DITERIMA</b>\n\nKlik <b>INSTALL PANEL</b> untuk memulai pemasangan Pterodactyl Panel di VPS Railway.', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🚀 INSTALL PANEL', callback_data: 'panel_run_confirm' }], [{ text: '❌ Batal', callback_data: 'install_panel_cancel' }]] } });
  }
  if (action.startsWith('panel_run:')) {
    // Data sensitif hanya berada di session sementara sampai tombol konfirmasi.
    return;
  }

  if (action === 'create:auto') {
    sessions.delete(skey);

    const currentVpsCount = countUserVps(userId);
    const currentVpsLimit = getVpsLimit(userId);
    if (currentVpsCount >= currentVpsLimit) {
      await bot.sendMessage(chatId, `🚫 <b>LIMIT VPS TERCAPAI</b>\n\nVPS aktif kamu: <b>${currentVpsCount}/${vpsLimitText(userId)}</b>\nRole: <b>${getUserRole(userId)}</b>`, { parse_mode: 'HTML' });
      return;
    }

    // Pilih token otomatis berdasarkan urutan token yang disimpan.
    // Token yang sudah 2/2 dilewati. Pending juga dihitung agar dua CREATE
    // yang berjalan bersamaan tidak mengambil slot yang sama melebihi batas.
    let selectedAlias = null;
    let selectedItem = null;
    for (const [alias, item] of Object.entries(railwayTokens)) {
      if (!item || !item.token) continue;
      const used = Number(item.used || 0);
      const pending = Number(item.pending || 0);
      const maxSlots = Math.max(1, Number(item.maxSlots || 2));
      if (used + pending < maxSlots) {
        selectedAlias = alias;
        selectedItem = item;
        break;
      }
    }

    if (!selectedItem || !selectedAlias) {
      await bot.sendMessage(chatId, '⚠️ <b>Semua token sedang penuh.</b>\n\nToken akan otomatis berpindah ke token berikutnya setelah kuota token sebelumnya mencapai 2/2.');
      return;
    }

    const currentUsed = Number(selectedItem.used || 0);
    const currentPending = Number(selectedItem.pending || 0);
    const maxSlots = Math.max(1, Number(selectedItem.maxSlots || 2));
    if (currentUsed + currentPending >= maxSlots) {
      await bot.sendMessage(chatId, '⚠️ Semua slot token baru saja terpakai. Silakan tekan 🟢 Buat VPS lagi.');
      return;
    }

    const tokenInfo = {
      alias: selectedAlias,
      token: selectedItem.token,
      used: currentUsed,
      workspaceId: selectedItem.workspaceId || ''
    };
    selectedItem.pending = currentPending + 1;
    saveRailwayTokens();
    saveRailwayTokens();
    const name = text.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || `vps-${Date.now()}`;
    const password = generatePassword();
    const jobId = crypto.randomBytes(5).toString('hex');
    const progress = await bot.sendMessage(chatId, `<b>⏳ Membuat VPS...</b>\n\nNama: <code>${esc(name)}</code>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🛑 STOP PROSES', callback_data: `stop_create_${jobId}` }]] } });
    activeCreates.set(jobId, { userId: String(userId), chatId: String(chatId), name, tokenAlias: tokenInfo.alias, cancelled: false });
    let createStage = 'INIT';
    let createdProjectId = null;
    try {
      ensureCreateNotCancelled(jobId);
      createStage = 'CREATE_PROJECT';
      const { projectId, environmentId } = await createProject(name, tokenInfo.token, tokenInfo);
      createdProjectId = projectId;
      await bot.editMessageText(`<b>⏳ Membuat VPS...</b>\n\n✔️ Project Railway dibuat\n✔️ Service disiapkan`, { chat_id: chatId, message_id: progress.message_id, parse_mode: 'HTML' });
      ensureCreateNotCancelled(jobId);
      createStage = 'CREATE_SERVICE';
      const serviceId = await createService(projectId, name, tokenInfo.token);
      ensureCreateNotCancelled(jobId);
      createStage = 'SET_VARIABLES';
      await setVariables(projectId, environmentId, serviceId, password, tokenInfo.token);
      ensureCreateNotCancelled(jobId);
      createStage = 'CREATE_TCP_PROXY';
      const proxy = await createTcpProxy(environmentId, serviceId, tokenInfo.token);
      ensureCreateNotCancelled(jobId);
      createStage = 'WAIT_DEPLOYMENT';
      await waitForDeployment(projectId, serviceId, { chatId, messageId: progress.message_id, environmentId, header: `<b>☁️ RAILWAY VPS</b>\n\nService: <code>${esc(name)}</code>` }, tokenInfo.token);
      ensureCreateNotCancelled(jobId);
      createStage = 'RESOLVE_PROXY';
      const proxyIp = await resolveProxyIp(proxy.domain);
      ensureCreateNotCancelled(jobId);
      createStage = 'SAVE_VPS';
      const durationDays = getVpsDurationDays(userId);
      const expiresAt = Date.now() + durationDays * 24 * 60 * 60 * 1000;
      vpsStore.set(serviceId, {
        projectId, environmentId, serviceId, name,
        host: proxy.domain, port: proxy.proxyPort, proxyIp, password,
        ownerId: userId, tokenAlias: tokenInfo.alias,
        groupId: isGroupChat(msg.chat) ? chatId : null,
        groupTitle: isGroupChat(msg.chat) ? (msg.chat.title || '') : null,
        createdAt: Date.now(), expiresAt, durationDays
      });
      saveVpsStore();
      // Log VPS baru otomatis ke Owner BOT UTAMA.
      try {
        const creator = msg.from || {};
        const creatorName = [creator.first_name, creator.last_name].filter(Boolean).join(' ') || 'User';
        await bot.sendMessage(String(setting.OWNER_ID),
          `🖥️ <b>VPS BARU DIBUAT</b>\n\n👤 User: <b>${esc(creatorName)}</b>\n🔗 Username: ${creator.username ? '@' + esc(creator.username) : '-'}\n🆔 Telegram ID: <code>${esc(userId)}</code>\n📦 VPS: <b>${esc(name)}</b>\n🆔 Service ID: <code>${esc(serviceId)}</code>\n🕐 Waktu: <code>${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}</code>\n📊 Status: <b>SUCCESS</b>`,
          { parse_mode: 'HTML' }
        );
      } catch (_) {}
      ensureCreateNotCancelled(jobId);
      createStage = 'SEND_RESULT';
      const tokenResult = consumeToken(tokenInfo.alias);
      const ssh = `ssh root@${proxy.domain} -p ${proxy.proxyPort}`;
      const message = `<b>✅ VPS READY!</b>\n\n<b>🐧 SPEK VPS</b>\n» Sistem      : <code>Ubuntu 24.04 + SSH + Claude</code>\n» Provider    : <code>Railway</code>\n» Status      : <code>✅ ACTIVE</code>\n» Nama VPS    : <code>${esc(name)}</code>\n\n<b>🔐 DETAIL LOGIN</b>\n» IP Proxy    : <code>${esc(proxyIp)}</code>\n» SSH Host    : <code>${esc(proxy.domain)}</code>\n» Username    : <code>root</code>\n» Port        : <code>${esc(proxy.proxyPort)}</code>\n» Password    : <code>${esc(password)}</code>\n\n<b>🔗 SSH COMMAND</b>\n<code>${esc(ssh)}</code>\n\n<b>📋 FORMAT MANUAL</b>\n<code>IP:PORT   = ${esc(proxyIp)}:${esc(proxy.proxyPort)}\nHOST:PORT = ${esc(proxy.domain)}:${esc(proxy.proxyPort)}\nUSER      = root\nPASSWORD  = ${esc(password)}</code>\n\n<i>Gunakan tombol di bawah untuk menyalin bagian tertentu.</i>

🔑 <b>Token CREATE:</b> ${tokenResult.used}/${tokenResult.maxSlots} → sisa ${tokenResult.remaining} slot`;
      const keyboard = { inline_keyboard: [
        [{ text: '📋 COPY IP:PORT', copy_text: { text: `${proxyIp}:${proxy.proxyPort}` }, style: 'success' }],
        [{ text: '📋 COPY HOST:PORT', copy_text: { text: `${proxy.domain}:${proxy.proxyPort}` }, style: 'success' }],
        [{ text: '🔐 COPY SSH', copy_text: { text: ssh }, style: 'primary' }],
        [{ text: '📋 COPY PASSWORD', copy_text: { text: password }, style: 'primary' }]
      ] };
      try { await bot.deleteMessage(chatId, progress.message_id); } catch (_) {}

      // Jika dibuat dari grup, detail login dikirim otomatis ke DM buyer.
      // Di grup hanya tampil notifikasi singkat agar password tidak bocor ke anggota lain.
      const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
      if (isGroup) {
        try {
          await bot.sendMessage(userId, message, { parse_mode: 'HTML', reply_markup: keyboard });
          await bot.sendMessage(chatId, `✅ <b>VPS berhasil dibuat!</b>\n\nNama: <code>${esc(name)}</code>\n📩 Detail login VPS sudah dikirim ke <b>DM kamu</b>.`, { parse_mode: 'HTML' });
        } catch (dmError) {
          await bot.sendMessage(chatId, `⚠️ <b>VPS berhasil dibuat, tetapi detail belum bisa dikirim ke DM.</b>\n\nSilakan buka DM bot dan kirim <code>/start</code>, lalu hubungi owner agar data VPS dikirim ulang.\n\nNama VPS: <code>${esc(name)}</code>`, { parse_mode: 'HTML' });
        }
      } else {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    } catch (e) {
      if (e?.code === 'CREATE_CANCELLED') {
        if (createdProjectId) { try { await deleteProject(createdProjectId, tokenInfo.token); } catch (_) {} }
        try { await bot.editMessageText(`🛑 <b>CREATE VPS DIHENTIKAN</b>\n\n📦 Nama: <code>${esc(name)}</code>\n🔑 Token: <code>${esc(tokenInfo.alias)}</code>\n📍 Tahap: <code>${esc(createStage)}</code>\n\n🧹 Resource Railway yang sudah sempat dibuat dibersihkan.`, { chat_id: chatId, message_id: progress.message_id, parse_mode: 'HTML' }); } catch (_) {}
        return;
      }
      const chatType = msg.chat.type || 'unknown';
      const logLine = logCreateError({
        userId,
        chatId,
        chatType,
        name,
        alias: tokenInfo.alias,
        stage: createStage,
        error: e
      });
      try { await bot.editMessageText(`❌ <b>Gagal membuat VPS</b>\n\n<b>Stage:</b> <code>${esc(createStage)}</code>\n<b>Error:</b> <code>${esc(e.message)}</code>\n\n<i>Log error sudah dicatat dan Owner sudah diberi notifikasi.</i>`, { chat_id: chatId, message_id: progress.message_id, parse_mode: 'HTML' }); } catch (_) {}
      try {
        await bot.sendMessage(String(setting.OWNER_ID), `🚨 <b>CREATE VPS GAGAL</b>\n\n👤 Buyer: <code>${esc(userId)}</code>\n💬 Chat: <code>${esc(chatId)}</code>\n📦 Nama: <code>${esc(name)}</code>\n🔑 Token: <code>${esc(tokenInfo.alias)}</code>\n📍 Stage: <code>${esc(createStage)}</code>\n❌ Error: <code>${esc(e.message)}</code>\n\n<code>${esc(logLine)}</code>`, { parse_mode: 'HTML' });
      } catch (_) {}
    } finally {
      activeCreates.delete(jobId);
      const item = railwayTokens[tokenInfo.alias];
      if (item) {
        item.pending = Math.max(0, Number(item.pending || 0) - 1);
        saveRailwayTokens();
      }
    }
    return;
  }

});


// ================= AUTO EXPIRED VPS / CLEANUP =================
let cleanupRunning = false;
async function cleanupExpiredVps() {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const now = Date.now();
    for (const [serviceId, vps] of [...vpsStore.entries()]) {
      if (!vps?.expiresAt || Number(vps.expiresAt) > now) continue;
      const tokenInfo = getAnyToken(vps.tokenAlias);
      try {
        if (tokenInfo?.token && vps.projectId) await deleteProject(vps.projectId, tokenInfo.token);
        vpsStore.delete(serviceId);
        saveVpsStore();
        if (tokenInfo) restoreToken(tokenInfo.alias);
        try {
          await bot.sendMessage(String(vps.ownerId), `⏰ <b>VPS EXPIRED & OTOMATIS DIHAPUS</b>\n\n📦 VPS: <b>${esc(vps.name || serviceId)}</b>\n🆔 Service ID: <code>${esc(serviceId)}</code>\n📅 Masa aktif sudah berakhir.\n🧹 Project Railway otomatis dibersihkan.`, { parse_mode: 'HTML' });
        } catch (_) {}
        try {
          await bot.sendMessage(String(setting.OWNER_ID), `🧹 <b>AUTO CLEANUP VPS</b>\n\n📦 VPS: <b>${esc(vps.name || serviceId)}</b>\n👤 User ID: <code>${esc(vps.ownerId)}</code>\n🆔 Service ID: <code>${esc(serviceId)}</code>\n📊 Status: <b>EXPIRED & DELETED</b>`, { parse_mode: 'HTML' });
        } catch (_) {}
      } catch (e) {
        try { await bot.sendMessage(String(setting.OWNER_ID), `⚠️ <b>AUTO CLEANUP GAGAL</b>\n\n📦 VPS: <code>${esc(vps.name || serviceId)}</code>\n🆔 Service ID: <code>${esc(serviceId)}</code>\n❌ Error: <code>${esc(e.message)}</code>`, { parse_mode: 'HTML' }); } catch (_) {}
      }
    }
  } finally { cleanupRunning = false; }
}

// Auto backup: kirim setelah bot siap, lalu setiap 6 jam.
{
  setTimeout(() => sendStartupUpdate().catch(() => {}), 8000);
  setTimeout(() => sendAutoBackup('STARTUP'), 15000);
  setInterval(() => sendAutoBackup('6 JAM'), 6 * 60 * 60 * 1000);
}
setTimeout(() => cleanupExpiredVps().catch(() => {}), 20000);
setInterval(() => cleanupExpiredVps().catch(() => {}), 30 * 60 * 1000);

// ================= SERVER MANAGER PATCH (VPS / Server Manager) =================
// Modul terpisah agar TIDAK mengubah fitur lama. Semua command di dalamnya
// hanya untuk Owner, memakai isOwner() yang sudah ada (bukan sistem OWNER_ID baru).
try {
  const serverManager = require('./server-manager.js');
  serverManager.registerServerManager({
    bot,
    sessions,
    sessionKey,
    isOwner,
    isMainBot: true
  });
} catch (e) {
  console.error('\u274c Gagal memuat Server Manager patch:', e.message);
}
