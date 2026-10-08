'use strict';

/**
 * ============================================================================
 *  server-manager.js  --  PATCH MODUL untuk bot CVPS NAT (node-telegram-bot-api)
 * ============================================================================
 *  Menambahkan fitur VPS / Server Manager TANPA menghapus / mengubah fitur lama.
 *
 *  Fitur:
 *    /upload            upload & extract ZIP project (owner only)          [FITUR 1]
 *    /installbase       install Node.js 22 + npm via NodeSource (owner)     [FITUR 2]
 *    /npminstall        npm install di PROJECT_DIR (owner only)             [FITUR 3]
 *    /terminal  /term   terminal menu + eksekusi command (owner only)       [FITUR 4]
 *    /server            status VPS (owner only)                             [FITUR 7]
 *    /startproject | /restartproject | /stopproject  (PM2, owner only)      [FITUR 6]
 *    /logs              log PM2 project terbaru (owner only)                [FITUR 4b]
 *    /errors            error PM2 + create-errors.log (owner only)          [FITUR 4c]
 *    /health            health check VPS (owner only)                       [FITUR 9b]
 *    /backupvps         backup PROJECT_DIR -> .tar.gz (owner only)          [FITUR 10]
 *    Menu "VPS MANAGER" via inline keyboard                                 [FITUR 9]
 *
 *  Keamanan (FITUR 8):
 *    - HANYA OWNER (dari konfigurasi owner yang sudah ada, `isOwner()` bot.js).
 *    - TIDAK memakai eval(). Semua eksekusi lewat child_process.exec dengan
 *      timeout + batas ukuran output (maxBuffer).
 *    - Environment child process disanitasi: BOT_TOKEN / API key / password /
 *      secret TIDAK diwariskan ke command yang dijalankan.
 *    - Output di-escape untuk HTML Telegram sebelum dikirim.
 *    - Secret / token / password di-redact dari output.
 *    - ZIP divalidasi (harus ZIP asli) + proteksi Zip Slip / path traversal
 *      sebelum extraction; symlink di ZIP ditolak; file diekstrak mode 0644
 *      (tanpa bit executable) => file dari ZIP tidak dijalankan otomatis.
 *    - Project lama TIDAK dihapus sebelum ZIP tervalidasi & terekstrak.
 *    - Project lama dibackup (.tar.gz) SEBELUM digantikan; bila backup gagal,
 *      proses replacement dibatalkan agar project lama tetap aman.
 *    - ZIP temporary selalu dihapus setelah selesai (sukses maupun gagal).
 *
 *  Modul ini dipanggil dari bot.js:
 *      const serverManager = require('./server-manager.js');
 *      serverManager.registerServerManager({ bot, sessions, sessionKey, isOwner, ... });
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { exec } = require('child_process');
const setting = require('./setting.js');

// ================= KONFIGURASI (FITUR 5 & 10) =================
// Membaca dari setting.js (config.js lama) -- TIDAK ada hardcode path tersebar.
const SM = (setting.SERVER_MANAGER && typeof setting.SERVER_MANAGER === 'object')
  ? setting.SERVER_MANAGER
  : {};

const PROJECT_DIR = path.resolve(SM.PROJECT_DIR || '/root/project');
const TEMP_DIR = path.resolve(SM.TEMP_DIR || path.join(os.tmpdir(), 'server-manager'));
const COMMAND_TIMEOUT = Math.max(1000, Number(SM.COMMAND_TIMEOUT) || 120000);
const MAX_OUTPUT = Math.max(1000, Number(SM.MAX_OUTPUT) || 12000);
const MAX_ZIP_BYTES = Math.max(1024 * 1024, Number(SM.MAX_ZIP_BYTES) || 200 * 1024 * 1024);
const ENABLE_ON_DEPLOYED = SM.ENABLE_ON_DEPLOYED === true;

const INPUT_SESSION = 'vps_terminal_input';
const UPLOAD_SESSION = 'vps_wait_upload';
const MAX_TELEGRAM_LEN = 3500; // batas aman < 4096 saat parse_mode HTML

// Diisi saat registerServerManager() dipanggil.
const MAX_UNZIPPED_BYTES = Math.max(10 * 1024 * 1024, Number(SM.MAX_UNZIPPED_BYTES) || 1024 * 1024 * 1024);
const MAX_ZIP_ENTRIES = Math.max(100, Number(SM.MAX_ZIP_ENTRIES) || 20000);
const LOCAL_UPLOAD_TTL_MS = 10 * 60 * 1000;
const LOCAL_ARMED = new Map();   // userKey -> timestamp (upload ZIP lokal hanya diterima setelah "armed")
const LOCAL_LOCKS = new Set();   // cegah upload / npm install / installbase berjalan bersamaan
// Tidak ikut backup: dependency, cache, dan SEMUA yang berpotensi secret (.env, key, database).
const BACKUP_EXCLUDE_PATTERNS = [
  'node_modules', '.npm', 'npm-cache', '.cache', '.git', 'tmp', '.tmp', '*.log',
  '.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*',
  '*.sqlite', '*.sqlite3', '*.db', 'vps-store.json', 'railway-token.json',
  'vps-profiles.enc.json', '*.enc.json'
];
let PA_API = null;
let BOT = null;
let SESSIONS = null;
let SESSION_KEY = null;
let IS_OWNER = null;
let IS_MAIN_BOT = true;

// ================= UTIL UMUM =================

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Menyamarkan token / password / api key yang mungkin muncul di output command.
function redactSecrets(text) {
  let out = String(text ?? '');
  // Token bot Telegram: 123456789:AA...
  out = out.replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_BOT_TOKEN]');
  // bearer / authorization
  out = out.replace(/(bearer\s+)[A-Za-z0-9._-]{10,}/gi, '$1[REDACTED]');
  // key=value / key: value sensitif
  out = out.replace(
    /((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|auth|authorization|access[_-]?key|private[_-]?key)\s*[:=]\s*)(["']?)([^\s"'\n]{3,})/gi,
    (m, p1, q) => `${p1}${q}[REDACTED]`
  );
  return out;
}

// Environment untuk child process TANPA secret (BOT_TOKEN, API key, password,
// database URL, dsb). Mencegah command yang dijalankan (atau `env`/`printenv`)
// membocorkan kredensial bot ke output Telegram.
function sanitizedEnv() {
  const env = { ...process.env };
  const SECRET_RE = /(token|secret|password|passwd|pwd|api[_-]?key|apikey|auth|private[_-]?key|access[_-]?key|database_url|db_url|dsn|credential)/i;
  for (const key of Object.keys(env)) {
    if (SECRET_RE.test(key)) delete env[key];
  }
  return env;
}

function truncate(text, limit = MAX_OUTPUT) {
  const s = String(text ?? '');
  if (s.length <= limit) return { text: s, truncated: false, full: s };
  return {
    text: s.slice(0, limit) + `\n\n…(output dipotong, ${s.length - limit} karakter disembunyikan)`,
    truncated: true,
    full: s
  };
}

function ensureDirs() {
  try { fs.mkdirSync(TEMP_DIR, { recursive: true, mode: 0o700 }); } catch (_) {}
  try { fs.mkdirSync(PROJECT_DIR, { recursive: true, mode: 0o755 }); } catch (_) {}
}

function fmtBytes(n) {
  n = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function fmtUptime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d} hari`);
  if (h) parts.push(`${h} jam`);
  parts.push(`${m} menit`);
  return parts.join(' ');
}

function isOwnerId(userId) {
  try {
    return typeof IS_OWNER === 'function' ? IS_OWNER(userId) : false;
  } catch (_) { return false; }
}

function userKey(chatId, userId) {
  if (typeof SESSION_KEY === 'function') return SESSION_KEY(String(chatId), String(userId));
  return `${chatId}:${userId}`;
}

function resetSession(chatId, userId) {
  try { SESSIONS.delete(userKey(chatId, userId)); } catch (_) {}
}

// ================= EKSEKUSI SHELL (FITUR 8: aman) =================
// Semua eksekusi lewat exec (TIDAK ada eval) dengan timeout + maxBuffer.
// Environment disanitasi agar secret bot tidak bocor ke command.
function runShell(command, options = {}) {
  const timeout = Math.max(1000, Number(options.timeout) || COMMAND_TIMEOUT);
  const maxBuffer = Math.max(1024 * 1024, Number(options.maxBuffer) || 8 * 1024 * 1024);
  const cwd = (options.cwd && fs.existsSync(options.cwd)) ? options.cwd : undefined;
  return new Promise((resolve) => {
    let child;
    let killTimer = null;
    try {
      child = exec(command, {
        timeout,
        cwd,
        maxBuffer,
        encoding: 'utf8',
        windowsHide: true,
        detached: process.platform !== 'win32', // process group sendiri -> bisa dibunuh sekaligus
        env: sanitizedEnv()
      }, (error, stdout, stderr) => {
        if (killTimer) clearTimeout(killTimer);
        const code = (error && typeof error.code === 'number') ? error.code : (error ? 1 : 0);
        resolve({
          ok: !error,
          code,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut: Boolean(error && (error.killed || error.signal === 'SIGTERM')),
          message: error ? String(error.message || '') : ''
        });
      });
    } catch (e) {
      return resolve({ ok: false, code: 1, stdout: '', stderr: String(e.message || e), timedOut: false, message: String(e.message || e) });
    }
    if (child && child.pid && process.platform !== 'win32') {
      // exec(timeout) hanya membunuh shell; proses anak (npm, node) bisa tetap hidup -> bunuh group.
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} }, timeout + 3000);
      if (killTimer.unref) killTimer.unref();
    }
    if (child && child.stdin) { try { child.stdin.end(); } catch (_) {} }
  });
}

async function withProjectLock(chatId, fn) {
  if (LOCAL_LOCKS.has('project')) {
    await BOT.sendMessage(chatId, '⏳ Masih ada proses lain yang berjalan (upload / npm install / installbase). Tunggu sampai selesai.').catch(() => {});
    return;
  }
  LOCAL_LOCKS.add('project');
  try { return await fn(); } finally { LOCAL_LOCKS.delete('project'); }
}

function combinedOutput(res) {
  const parts = [];
  if (res.stdout && res.stdout.trim()) parts.push(res.stdout.trim());
  if (res.stderr && res.stderr.trim()) parts.push(res.stderr.trim());
  return parts.join('\n') || '(tidak ada output)';
}

function writeTempText(name, content) {
  ensureDirs();
  const safe = String(name).replace(/[^a-z0-9._-]/gi, '_');
  const file = path.join(TEMP_DIR, safe);
  fs.writeFileSync(file, String(content ?? ''), { mode: 0o600 });
  return file;
}

function safeUnlink(file) {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
}

// Kirim hasil command ke Telegram dengan format "🖥 COMMAND RESULT".
// Output panjang -> potong aman + SELALU kirim file .txt berisi output lengkap
// (baik saat dipotong maupun saat melebihi batas satu pesan Telegram).
async function sendCommandResult(chatId, cmd, output) {
  const raw = redactSecrets(output || '(tidak ada output)');
  const t = truncate(raw);
  const shownCmd = String(cmd).length > 200 ? String(cmd).slice(0, 200) + '…' : String(cmd);
  const header = `🖥 <b>COMMAND RESULT</b>\n<code>$ ${escapeHtml(redactSecrets(shownCmd))}</code>`;
  const body = t.text.slice(0, MAX_TELEGRAM_LEN);

  try {
    await BOT.sendMessage(chatId, `${header}\n\n<pre>${escapeHtml(body)}</pre>`, { parse_mode: 'HTML' });
  } catch (_) {
    // fallback tanpa <pre> bila gagal (mis. karakter khusus)
    await BOT.sendMessage(chatId, `${header}\n\n${escapeHtml(body)}`, { parse_mode: 'HTML' }).catch(() => {});
  }

  // Kirim file .txt bila output dipotong ATAU terlalu panjang untuk 1 pesan.
  if (t.truncated || raw.length > MAX_TELEGRAM_LEN) {
    try {
      const filePath = writeTempText(`cmd-output-${Date.now()}.txt`, raw);
      await BOT.sendDocument(chatId, filePath, { caption: '📄 Output lengkap (file .txt)' });
      safeUnlink(filePath);
    } catch (e) {
      await BOT.sendMessage(chatId, `⚠️ Gagal mengirim file output: ${escapeHtml(e.message)}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  }
}

async function progressEdit(chatId, messageId, text) {
  try {
    await BOT.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
  } catch (_) {}
}

// ================= OWNER CHECK =================

async function ownerGuard(msg) {
  const uid = String(msg.from?.id ?? msg.chat?.id ?? '');
  if (!isOwnerId(uid)) {
    await BOT.sendMessage(msg.chat.id, '⛔ <b>Akses ditolak.</b>\n\nCommand Server Manager hanya untuk <b>Owner</b>.', { parse_mode: 'HTML' }).catch(() => {});
    return false;
  }
  return true;
}

// ================= FITUR 1 : /upload (ZIP) =================

// Validasi nama entri ZIP (dipakai inspectZip & safeExtractZip).
function normalizeEntryName(rawName) {
  const normalized = String(rawName || '').replace(/\\/g, '/');
  if (normalized.includes('\0')) throw new Error('ZIP tidak aman (karakter NUL pada nama file).');
  // Tolak path absolut / drive letter (Windows) / UNC.
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`ZIP tidak aman (path absolut): ${rawName}`);
  }
  if (normalized.split('/').includes('..')) {
    throw new Error(`ZIP tidak aman (Zip Slip / path traversal terdeteksi): ${rawName}`);
  }
  return normalized;
}
function isSymlinkEntry(entry) {
  const unixMode = (entry.header && entry.header.attr) ? ((entry.header.attr >>> 16) & 0xffff) : 0;
  return Boolean(unixMode && (unixMode & 0xf000) === 0xa000);
}

/**
 * Inspeksi ZIP TANPA mengekstrak: batas jumlah entri & total ukuran hasil ekstrak
 * (anti ZIP bomb), tolak path berbahaya & symlink, deteksi folder pembungkus tunggal.
 */
function inspectZip(zipPath) {
  let AdmZip;
  try { AdmZip = require('adm-zip'); } catch (_) {
    const e = new Error('Library "adm-zip" belum terpasang. Jalankan: npm install');
    e.code = 'NO_ADMZIP';
    throw e;
  }
  const zip = new AdmZip(zipPath); // throw bila bukan ZIP valid
  const entries = zip.getEntries();
  if (!entries || !entries.length) throw new Error('ZIP kosong / tidak berisi file.');
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`ZIP berisi terlalu banyak entri (${entries.length} > ${MAX_ZIP_ENTRIES}).`);

  let total = 0, fileCount = 0, topFiles = 0;
  const tops = new Set();
  const names = new Set();
  for (const entry of entries) {
    const rawName = String(entry.entryName || '');
    if (!rawName) continue;
    const n = normalizeEntryName(rawName);
    if (isSymlinkEntry(entry)) throw new Error(`ZIP berisi symlink (ditolak): ${rawName}`);
    const isDir = entry.isDirectory || n.endsWith('/');
    if (!isDir) {
      total += Number(entry.header && entry.header.size) || 0;
      fileCount++;
      if (total > MAX_UNZIPPED_BYTES) throw new Error(`Ukuran hasil ekstrak melebihi batas ${fmtBytes(MAX_UNZIPPED_BYTES)} (kemungkinan ZIP bomb).`);
    }
    const parts = n.split('/').filter(Boolean);
    if (!parts.length || parts[0] === '__MACOSX') continue;
    names.add(parts.join('/'));
    tops.add(parts[0]);
    if (parts.length === 1 && !isDir) topFiles++;
  }
  const singleRoot = (tops.size === 1 && topFiles === 0) ? [...tops][0] : null;
  const hasPackageJson = names.has('package.json') || (singleRoot ? names.has(`${singleRoot}/package.json`) : false);
  return { entryCount: entries.length, fileCount, totalSize: total, singleRoot, hasPackageJson };
}

// Ekstraksi ZIP yang aman dari Zip Slip / path traversal (async: tidak memblokir event loop).
async function safeExtractZip(zipPath, destDir) {
  const info = inspectZip(zipPath); // batas jumlah/ukuran + nama berbahaya + symlink
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  const destRoot = path.resolve(destDir);
  fs.mkdirSync(destRoot, { recursive: true, mode: 0o755 });

  let fileCount = 0;
  let dirCount = 0;
  let written = 0;
  let i = 0;

  for (const entry of entries) {
    const rawName = String(entry.entryName || '');
    if (!rawName) continue;
    const normalized = normalizeEntryName(rawName);

    // Hitung target & pastikan masih di dalam destRoot => cegah Zip Slip ("../").
    const target = path.resolve(destRoot, normalized);
    const rel = path.relative(destRoot, target);
    if (rel === '' && (entry.isDirectory || normalized.endsWith('/'))) continue; // entri "./"
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`ZIP tidak aman (Zip Slip / path traversal terdeteksi): ${rawName}`);
    }

    if (entry.isDirectory || normalized.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true, mode: 0o755 });
      dirCount++;
      continue;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    const data = entry.getData();
    written += data.length;
    if (written > MAX_UNZIPPED_BYTES) throw new Error('Ukuran hasil ekstrak melebihi batas (ZIP bomb).');
    // mode 0644 => TIDAK ada bit executable; file dari ZIP tidak dijalankan otomatis.
    fs.writeFileSync(target, data, { mode: 0o644 });
    fileCount++;
    if (++i % 50 === 0) await new Promise((r) => setImmediate(r)); // beri napas ke event loop
  }

  return { fileCount, dirCount, total: entries.length, singleRoot: info.singleRoot };
}

function downloadToFile(url, destPath, maxBytes) {
  return new Promise((resolve, reject) => {
    const follow = (u, depth = 0) => {
      if (depth > 5) return reject(new Error('Terlalu banyak redirect'));
      const mod = u.startsWith('http://') ? require('http') : https;
      const req = mod.get(u, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return follow(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} saat mengunduh file`));
        }
        let received = 0;
        const out = fs.createWriteStream(destPath, { mode: 0o600 });
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            req.destroy();
            out.destroy();
            safeUnlink(destPath);
            return reject(new Error('Ukuran file melebihi batas yang diizinkan.'));
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(received)));
        out.on('error', (e) => { safeUnlink(destPath); reject(e); });
        res.on('error', (e) => { safeUnlink(destPath); reject(e); });
      });
      req.on('error', (e) => reject(e));
      req.setTimeout(120000, () => { req.destroy(new Error('Timeout mengunduh file')); });
    };
    follow(url);
  });
}

function looksLikeZip(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    // Signature ZIP: PK\x03\x04 (atau PK\x05\x06 untuk ZIP kosong)
    return (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05) && (buf[3] === 0x04 || buf[3] === 0x06));
  } catch (_) { return false; }
}

// Salin data lama yang TIDAK ada di source baru (mis. .env, database JSON, folder data/uploads)
// ke source baru -> pola "overlay" seperti unzip ke folder lama. node_modules & .git dilewati,
// symlink dilewati. File yang ada di ZIP selalu menang. Async agar event loop tidak terblokir.
async function carryOverData(oldDir, newDir) {
  const fsp = fs.promises;
  const SKIP = new Set(['node_modules', '.git']);
  const filter = (src) => {
    if (SKIP.has(path.basename(src))) return false;
    try { return !fs.lstatSync(src).isSymbolicLink(); } catch (_) { return false; }
  };
  const merge = async (from, to) => {
    for (const ent of await fsp.readdir(from, { withFileTypes: true })) {
      if (SKIP.has(ent.name) || ent.isSymbolicLink()) continue;
      const s = path.join(from, ent.name);
      const d = path.join(to, ent.name);
      const exists = fs.existsSync(d);
      if (ent.isDirectory()) {
        if (!exists) await fsp.cp(s, d, { recursive: true, filter });
        else if (fs.statSync(d).isDirectory()) await merge(s, d);
      } else if (!exists) {
        await fsp.copyFile(s, d, fs.constants.COPYFILE_EXCL);
      }
    }
  };
  await merge(oldDir, newDir);
}

// Mengganti isi PROJECT_DIR dengan source baru secara aman:
// source baru (staging, satu filesystem) + data lama yang tidak ada di ZIP -> rename atomik.
// Project lama dipindah ke PROJECT_DIR.prev (untuk rollback), tidak pernah hilang sebelum sukses.
async function swapProjectDir(srcDir) {
  const parent = path.dirname(PROJECT_DIR);
  const prevDir = `${PROJECT_DIR}.prev`;
  fs.mkdirSync(parent, { recursive: true, mode: 0o755 });

  let hadOld = false;
  try {
    if (fs.existsSync(PROJECT_DIR)) {
      if (fs.readdirSync(PROJECT_DIR).length > 0) {
        await carryOverData(PROJECT_DIR, srcDir); // sebelum swap: bila gagal, project lama utuh
        rmrf(prevDir);
        fs.renameSync(PROJECT_DIR, prevDir);
        hadOld = true;
      } else {
        fs.rmdirSync(PROJECT_DIR);
      }
    }
  } catch (e) {
    throw new Error(`Gagal memindahkan project lama: ${e.message}`);
  }

  try {
    fs.renameSync(srcDir, PROJECT_DIR);
  } catch (e) {
    if (hadOld) { try { fs.renameSync(prevDir, PROJECT_DIR); } catch (_) {} } // rollback
    throw new Error(`Gagal memasang project baru: ${e.message}`);
  }

  return { prevDir: hadOld ? prevDir : null };
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ================= FITUR 10 : BACKUP PROJECT =================

// Membuat arsip .tar.gz (fallback .zip) dari PROJECT_DIR.
// node_modules / cache / .git dikecualikan agar backup ringan.
// Throw bila backup gagal -> pemanggil WAJIB membatalkan replacement.
// Simpan hanya 5 arsip backup terbaru di TEMP_DIR/backups (cegah disk penuh).
function pruneBackups(dir, keep = 5) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^project-backup-/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const x of files.slice(keep)) safeUnlink(path.join(dir, x.f));
  } catch (_) {}
}

async function createProjectBackup() {
  ensureDirs();
  if (!fs.existsSync(PROJECT_DIR)) throw new Error('PROJECT_DIR tidak ditemukan, tidak ada yang bisa dibackup.');
  const backupDir = path.join(TEMP_DIR, 'backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parent = path.dirname(PROJECT_DIR);
  const base = path.basename(PROJECT_DIR);
  const excludes = BACKUP_EXCLUDE_PATTERNS.map((p) => `--exclude='${p}'`).join(' ');

  const tarPath = path.join(backupDir, `project-backup-${stamp}.tar.gz`);
  const tarRes = await runShell(
    `tar -czf "${tarPath}" -C "${parent}" ${excludes} "${base}"`,
    { timeout: 300000, maxBuffer: 16 * 1024 * 1024 }
  );
  if (tarRes.ok && fs.existsSync(tarPath) && fs.statSync(tarPath).size > 0) { pruneBackups(backupDir); return tarPath; }
  safeUnlink(tarPath);

  // Fallback: zip (bila tar tidak tersedia).
  const zipPath = path.join(backupDir, `project-backup-${stamp}.zip`);
  const zipRes = await runShell(
    `zip -r -q \"${zipPath}\" \"${base}\" -x ${BACKUP_EXCLUDE_PATTERNS.map((p) => `'*/${p}' '*/${p}/*'`).join(' ')}`,
    { cwd: parent, timeout: 300000, maxBuffer: 16 * 1024 * 1024 }
  );
  if (zipRes.ok && fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0) { pruneBackups(backupDir); return zipPath; }
  safeUnlink(zipPath);

  throw new Error(`Backup project gagal: ${combinedOutput(tarRes).slice(0, 300)}`);
}

async function cmdBackupProject(chatId) {
  ensureDirs();
  if (!fs.existsSync(PROJECT_DIR)) {
    return BOT.sendMessage(chatId, `❌ <b>Project tidak ditemukan.</b>\n\n📁 <code>${escapeHtml(PROJECT_DIR)}</code>`, { parse_mode: 'HTML' });
  }
  const statusMsg = await BOT.sendMessage(chatId, `💾 Membuat backup project...\n📁 <code>${escapeHtml(PROJECT_DIR)}</code>`, { parse_mode: 'HTML' }).catch(() => null);
  try {
    const archive = await createProjectBackup();
    const size = fmtBytes(fs.statSync(archive).size);
    if (statusMsg) await progressEdit(chatId, statusMsg.message_id, `✅ <b>Backup project selesai</b>\n📦 Ukuran: <b>${escapeHtml(size)}</b>`);
    await BOT.sendDocument(chatId, archive, {
      caption: `💾 <b>BACKUP PROJECT</b>\n\n📁 <code>${escapeHtml(PROJECT_DIR)}</code>\n📦 ${escapeHtml(size)}\n🕐 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`,
      parse_mode: 'HTML'
    }).catch(() => {});
    safeUnlink(archive); // jangan menumpuk arsip backup di TEMP_DIR
  } catch (e) {
    const text = `❌ <b>Backup project gagal</b>\n\n<code>${escapeHtml(e.message)}</code>`;
    if (statusMsg) await progressEdit(chatId, statusMsg.message_id, text);
    else await BOT.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => {});
  }
}

function depMapLocal(pkg) {
  const m = {};
  for (const sec of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [k, v] of Object.entries((pkg && pkg[sec]) || {})) m[k] = String(v);
  }
  return m;
}
function diffDepMaps(oldPkg, newPkg) {
  const a = depMapLocal(oldPkg), b = depMapLocal(newPkg);
  const added = [], removed = [], changed = [];
  for (const k of Object.keys(b)) {
    if (!(k in a)) added.push(`${k}@${b[k]}`);
    else if (a[k] !== b[k]) changed.push(`${k}: ${a[k]} → ${b[k]}`);
  }
  for (const k of Object.keys(a)) if (!(k in b)) removed.push(`${k}@${a[k]}`);
  return { added, removed, changed, total: added.length + removed.length + changed.length };
}
function readPkgJson(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (_) { return null; }
}

function armLocalUpload(chatId, userId) {
  SESSIONS.set(userKey(chatId, userId), UPLOAD_SESSION);
  LOCAL_ARMED.set(userKey(chatId, userId), Date.now());
  if (PA_API) PA_API.clearState(userId); // jangan ada dua alur upload aktif bersamaan
}

// Gerbang upload: hanya OWNER, hanya ZIP, dan HANYA bila owner sudah menekan Upload / /upload.
// (Sebelumnya ZIP apa pun dari owner langsung menimpa project.)
async function handleUploadDocument(msg, doc) {
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id ?? chatId);
  if (!isOwnerId(userId)) return;

  const fileName = doc.file_name || 'upload.zip';
  const isZip = /\.zip$/i.test(fileName)
    || doc.mime_type === 'application/zip'
    || doc.mime_type === 'application/x-zip-compressed';
  if (!isZip) return; // dokumen non-zip diabaikan (biar fitur lama tetap jalan)

  const skey = userKey(chatId, userId);
  const armedAt = LOCAL_ARMED.get(skey);
  if (SESSIONS.get(skey) !== UPLOAD_SESSION || !armedAt || Date.now() - armedAt > LOCAL_UPLOAD_TTL_MS) {
    LOCAL_ARMED.delete(skey);
    return; // tidak sedang menunggu upload -> abaikan (jangan menimpa project)
  }
  if (LOCAL_LOCKS.has('project')) {
    await BOT.sendMessage(chatId, '⏳ Masih ada proses lain yang berjalan (upload / npm install / installbase). Tunggu sampai selesai.').catch(() => {});
    return;
  }
  LOCAL_ARMED.delete(skey);
  LOCAL_LOCKS.add('project');
  try { await processUploadZip(msg, doc, fileName); }
  finally { LOCAL_LOCKS.delete('project'); }
}

async function processUploadZip(msg, doc, fileName) {
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id ?? chatId);
  resetSession(chatId, userId);
  ensureDirs();

  const destZip = path.join(TEMP_DIR, `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`);
  const stagingDir = `${PROJECT_DIR}.staging-${Date.now()}`;
  let projectBackup = null;

  const sizeText = `${fmtBytes(doc.file_size || 0)}`;
  const statusMsg = await BOT.sendMessage(chatId,
    `📦 <b>Upload diterima</b>\n` +
    `├─ File: <b>${escapeHtml(fileName)}</b>\n` +
    `├─ Ukuran: ${escapeHtml(sizeText)}\n` +
    `└─ Status: memproses...`,
    { parse_mode: 'HTML' }).catch(() => null);

  const head = `📦 <b>Upload diterima</b>\n├─ File: <b>${escapeHtml(fileName)}</b>\n├─ Ukuran: ${escapeHtml(sizeText)}\n`;
  const edit = async (t) => { if (statusMsg) await progressEdit(chatId, statusMsg.message_id, t); };

  try {
    // 0) Batas ukuran (Telegram file_size) -- tolak lebih awal.
    if (Number(doc.file_size || 0) > MAX_ZIP_BYTES) {
      throw new Error(`Ukuran ZIP (${sizeText}) melebihi batas ${fmtBytes(MAX_ZIP_BYTES)}.`);
    }

    // 1) Download ke TEMP_DIR
    const fileInfo = await BOT.getFile(doc.file_id);
    const dlUrl = `https://api.telegram.org/file/bot${BOT.__token || setting.BOT_TOKEN}/${fileInfo.file_path}`;
    await downloadToFile(dlUrl, destZip, MAX_ZIP_BYTES);

    // 2) Validasi ZIP asli (signature) + isi (Zip Slip, symlink, ZIP bomb).
    if (!looksLikeZip(destZip)) {
      throw new Error('File bukan ZIP yang valid (signature PK tidak ditemukan).');
    }
    const zi = inspectZip(destZip);

    await edit(`${head}└─ Status: mengekstrak...`);

    // 3) Extract ke STAGING (belum menyentuh project lama) -- aman dari Zip Slip.
    rmrf(stagingDir);
    const { fileCount } = await safeExtractZip(destZip, stagingDir);
    const srcDir = zi.singleRoot ? path.join(stagingDir, zi.singleRoot) : stagingDir;
    if (!fs.existsSync(srcDir)) throw new Error('Struktur ZIP tidak valid.');

    // 4) BACKUP project lama SEBELUM replacement (FITUR 10).
    //    Bila backup gagal -> batalkan upload, project lama tetap utuh.
    if (fs.existsSync(PROJECT_DIR) && fs.readdirSync(PROJECT_DIR).length > 0) {
      await edit(`${head}└─ Status: backup project lama...`);
      projectBackup = await createProjectBackup();
    }

    // 5) Bandingkan dependency (project lama vs ZIP) SEBELUM swap.
    const oldPkg = readPkgJson(PROJECT_DIR);
    const newPkg = readPkgJson(srcDir);
    if (fs.existsSync(path.join(srcDir, 'package.json')) && !newPkg) {
      throw new Error('package.json di dalam ZIP bukan JSON valid.');
    }
    const depDiff = newPkg ? diffDepMaps(oldPkg, newPkg) : null;

    // 6) Swap: source baru + data lama (.env dll) -> PROJECT_DIR; lama disimpan sebagai .prev.
    await edit(`${head}└─ Status: memasang project...`);
    const { prevDir } = await swapProjectDir(srcDir);
    rmrf(stagingDir);

    // 7) Dependency: sama -> pakai ulang node_modules lama; beda -> npm install.
    let npmLine = 'tidak ada package.json (dilewati)';
    let npmFailed = null;
    let rolledBack = false;
    if (newPkg) {
      const declared = Object.keys(depMapLocal(newPkg)).length;
      let carried = false;
      const prevModules = prevDir ? path.join(prevDir, 'node_modules') : null;
      if (prevDir && oldPkg && depDiff.total === 0 && fs.existsSync(prevModules) && !fs.existsSync(path.join(PROJECT_DIR, 'node_modules'))) {
        fs.renameSync(prevModules, path.join(PROJECT_DIR, 'node_modules'));
        carried = true;
      }
      if (carried) npmLine = 'dilewati (dependency tidak berubah, node_modules dipakai ulang)';
      else if (declared === 0) npmLine = 'dilewati (tanpa dependency)';
      else {
        await edit(`${head}└─ Status: menjalankan <b>npm install</b>...`);
        const res = await runShell('npm install --no-audit --no-fund', {
          cwd: PROJECT_DIR,
          timeout: Math.max(COMMAND_TIMEOUT, 300000)
        });
        if (res.ok) npmLine = 'selesai';
        else {
          npmFailed = res;
          if (prevDir) { // ROLLBACK: kembalikan project lama utuh
            const failedDir = `${PROJECT_DIR}.failed`;
            rmrf(failedDir);
            fs.renameSync(PROJECT_DIR, failedDir);
            fs.renameSync(prevDir, PROJECT_DIR);
            rmrf(failedDir);
            rolledBack = true;
          }
        }
      }
    }

    if (npmFailed) {
      const out = truncate(redactSecrets(combinedOutput(npmFailed)), 2500);
      await edit(
        `❌ <b>Upload dibatalkan — npm install gagal</b>\n` +
        `📁 Folder: <code>${escapeHtml(PROJECT_DIR)}</code>\n\n<pre>${escapeHtml(out.text)}</pre>\n\n` +
        (rolledBack
          ? '↩️ Project lama sudah <b>dipulihkan otomatis</b>.'
          : '⚠️ Belum ada versi sebelumnya; source baru tetap terpasang tanpa dependency. Perbaiki lalu jalankan npm install.')
      );
      return;
    }

    let depNote = '';
    if (depDiff && prevDir && depDiff.total) {
      depNote = `\n⚠️ Dependency berubah: +${depDiff.added.length} / -${depDiff.removed.length} / ~${depDiff.changed.length}`;
    }
    await edit(
      `✅ <b>Upload berhasil</b>\n` +
      `📁 Folder: <code>${escapeHtml(PROJECT_DIR)}</code>\n` +
      `📄 File diekstrak: <b>${fileCount}</b>\n` +
      `📦 npm install: <b>${escapeHtml(npmLine)}</b>${depNote}\n` +
      (projectBackup ? `💾 Backup lama: <code>${escapeHtml(path.basename(projectBackup))}</code>\n` : '') +
      (prevDir ? `↩️ Versi sebelumnya: <code>${escapeHtml(prevDir)}</code> (untuk rollback)\n` : '') +
      `ℹ️ <code>.env</code> &amp; data lama yang tidak ada di ZIP dipertahankan.\n` +
      `🚀 Restart project untuk menerapkan perubahan.`
    );
  } catch (e) {
    rmrf(stagingDir);
    // Project lama TIDAK disentuh saat gagal sebelum swap.
    const hint = e.code === 'NO_ADMZIP'
      ? '\n\n💡 Jalankan <code>npm install</code> di folder bot untuk memasang library <b>adm-zip</b>.'
      : (e.code === 'ENOSPC' ? '\n\n💡 Disk penuh. Kosongkan ruang lalu coba lagi.' : '');
    await edit(
      `❌ <b>Upload gagal</b>\n` +
      `├─ File: <b>${escapeHtml(fileName)}</b>\n` +
      `└─ Error: <code>${escapeHtml(redactSecrets(e.message))}</code>${hint}\n\n` +
      `<i>Project lama tidak diubah.</i>`
    );
  } finally {
    safeUnlink(destZip); // ZIP temporary selalu dihapus (sukses maupun gagal)
  }
}

// ================= FITUR 2 : /installbase =================

async function cmdInstallBase(chatId) {
  return withProjectLock(chatId, () => cmdInstallBaseInner(chatId));
}

async function cmdInstallBaseInner(chatId) {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    return BOT.sendMessage(chatId,
      '❌ <b>Tidak punya permission root.</b>\n\nInstall base butuh root. Jalankan bot sebagai <b>root</b> atau <code>sudo</code>, lalu coba lagi.',
      { parse_mode: 'HTML' });
  }

  const hasApt = (await runShell('command -v apt-get', { timeout: 15000 })).ok;
  if (!hasApt) {
    return BOT.sendMessage(chatId,
      '❌ <b>apt-get tidak tersedia</b> di sistem ini. /installbase membutuhkan distro Debian/Ubuntu.',
      { parse_mode: 'HTML' });
  }

  const statusMsg = await BOT.sendMessage(chatId, '⏳ <b>/installbase</b> — memulai instalasi base...', { parse_mode: 'HTML' }).catch(() => null);
  const steps = [
    { label: 'apt update', cmd: 'apt-get update -y' },
    { label: 'apt install curl ca-certificates', cmd: 'apt-get install -y curl ca-certificates' },
    { label: 'setup NodeSource 22.x', cmd: 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -' },
    { label: 'apt install nodejs', cmd: 'apt-get install -y nodejs' }
  ];

  const results = [];
  for (let i = 0; i < steps.length; i++) {
    if (statusMsg) await progressEdit(chatId, statusMsg.message_id,
      `⏳ <b>/installbase</b> (${i + 1}/${steps.length})\n» <code>${escapeHtml(steps[i].cmd)}</code>`);
    const res = await runShell(steps[i].cmd, { timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
    results.push({ ...steps[i], ok: res.ok });
    if (!res.ok) {
      const out = truncate(redactSecrets(combinedOutput(res)), 2500);
      if (statusMsg) {
        await progressEdit(chatId, statusMsg.message_id,
          `❌ <b>Gagal pada langkah:</b> <code>${escapeHtml(steps[i].cmd)}</code>\n\n<pre>${escapeHtml(out.text)}</pre>`);
      }
      return;
    }
  }

  // VERIFIKASI: node -v dan npm -v harus benar-benar mengembalikan versi.
  const nodeV = await runShell('node -v', { timeout: 20000 });
  const npmV = await runShell('npm -v', { timeout: 30000 });
  const nodeStr = nodeV.ok ? nodeV.stdout.trim() : null;
  const npmStr = npmV.ok ? npmV.stdout.trim() : null;

  const okAll = Boolean(nodeStr && npmStr);
  const lines = [
    okAll ? '✅ <b>/installbase selesai & terverifikasi</b>' : '⚠️ <b>/installbase selesai, tetapi verifikasi gagal</b>',
    `🟢 Node: <b>${escapeHtml(nodeStr || 'tidak terdeteksi')}</b>`,
    `📦 NPM : <b>${escapeHtml(npmStr || 'tidak terdeteksi')}</b>`
  ].join('\n');

  if (statusMsg) await progressEdit(chatId, statusMsg.message_id, lines);
  else await BOT.sendMessage(chatId, lines, { parse_mode: 'HTML' });
}

// ================= FITUR 3 : /npminstall =================

async function cmdNpmInstall(chatId) {
  return withProjectLock(chatId, () => cmdNpmInstallInner(chatId));
}

async function cmdNpmInstallInner(chatId) {
  ensureDirs();
  const pkg = path.join(PROJECT_DIR, 'package.json');
  if (!fs.existsSync(pkg)) {
    return BOT.sendMessage(chatId,
      `❌ <b>package.json tidak ditemukan di folder project.</b>\n\n📁 <code>${escapeHtml(PROJECT_DIR)}</code>`,
      { parse_mode: 'HTML' });
  }
  const npmOk = (await runShell('command -v npm', { timeout: 15000 })).ok;
  if (!npmOk) {
    return BOT.sendMessage(chatId,
      '❌ <b>npm tidak tersedia.</b>\n\nJalankan <code>/installbase</code> terlebih dahulu.',
      { parse_mode: 'HTML' });
  }
  const statusMsg = await BOT.sendMessage(chatId,
    `⏳ Menjalankan <b>npm install</b> di <code>${escapeHtml(PROJECT_DIR)}</code>...`,
    { parse_mode: 'HTML' }).catch(() => null);

  const res = await runShell('npm install --no-audit --no-fund', {
    cwd: PROJECT_DIR,
    timeout: Math.max(COMMAND_TIMEOUT, 300000)
  });

  if (res.ok) {
    const out = truncate(redactSecrets(combinedOutput(res)), 1500);
    const text = `✅ <b>npm install selesai.</b>\n📁 <code>${escapeHtml(PROJECT_DIR)}</code>` +
      (out.text && out.text !== '(tidak ada output)' ? `\n\n<pre>${escapeHtml(out.text)}</pre>` : '');
    if (statusMsg) await progressEdit(chatId, statusMsg.message_id, text);
    else await BOT.sendMessage(chatId, text, { parse_mode: 'HTML' });
    return;
  }

  const out = truncate(redactSecrets(combinedOutput(res)), 3000);
  const text = `❌ <b>npm install gagal</b>\n📁 <code>${escapeHtml(PROJECT_DIR)}</code>\n\n<pre>${escapeHtml(out.text)}</pre>`;
  if (statusMsg) await progressEdit(chatId, statusMsg.message_id, text);
  else await BOT.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

// ================= FITUR 7 : /server =================

function osPrettyName() {
  try {
    if (fs.existsSync('/etc/os-release')) {
      const rel = fs.readFileSync('/etc/os-release', 'utf8');
      const m = rel.match(/PRETTY_NAME="?([^"\n]+)"?/);
      if (m) return m[1];
    }
  } catch (_) {}
  return `${os.type()} ${os.release()}`;
}

async function cmdServerStatus(chatId) {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() || 'tidak diketahui';
  const cores = cpus.length || '?';
  const load = os.loadavg().map(n => n.toFixed(2)).join(', ');
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const [df, nodeV, npmV, pm2V] = await Promise.all([
    runShell('df -h /', { timeout: 15000 }),
    runShell('node -v', { timeout: 15000 }),
    runShell('npm -v', { timeout: 20000 }),
    runShell('pm2 -v', { timeout: 20000 })
  ]);

  let diskStr = 'tidak tersedia';
  if (df.ok && df.stdout.trim()) {
    const lines = df.stdout.trim().split('\n').filter(Boolean);
    const last = lines[lines.length - 1].trim().split(/\s+/);
    if (last.length >= 5) {
      diskStr = `${last[2]} / ${last[1]} (${last[4]} terpakai, sisa ${last[3]})`;
    }
  }

  const nodeStr = nodeV.ok ? nodeV.stdout.trim() : 'tidak tersedia';
  const npmStr = npmV.ok ? npmV.stdout.trim() : 'tidak tersedia';
  const pm2Str = pm2V.ok ? pm2V.stdout.trim().replace(/^v/i, '') : 'tidak tersedia (pm2 belum dipasang)';

  const text =
    `🖥 <b>VPS STATUS</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🐧 <b>OS</b>     : ${escapeHtml(osPrettyName())}\n` +
    `⏱ <b>Uptime</b> : ${escapeHtml(fmtUptime(os.uptime()))}\n` +
    `⚙️ <b>CPU</b>    : ${escapeHtml(cpuModel)}\n` +
    `      • Core: <b>${cores}</b> • Load: <code>${escapeHtml(load)}</code>\n` +
    `💾 <b>RAM</b>    : ${escapeHtml(fmtBytes(usedMem))} / ${escapeHtml(fmtBytes(totalMem))} (free ${escapeHtml(fmtBytes(freeMem))})\n` +
    `💽 <b>Disk</b>   : ${escapeHtml(diskStr)}\n` +
    `🟢 <b>Node</b>   : ${escapeHtml(nodeStr)}\n` +
    `📦 <b>NPM</b>    : ${escapeHtml(npmStr)}\n` +
    `🔄 <b>PM2</b>    : ${escapeHtml(pm2Str)}`;

  await BOT.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'vpsmgr_menu' }]] }
  });
}

// ================= FITUR 6 : PM2 (start / restart / stop) =================

async function pm2Available() {
  const res = await runShell('command -v pm2', { timeout: 15000 });
  return res.ok;
}

// Nama proses PM2 untuk project ini. Memakai basename PROJECT_DIR (sama dengan
// nama yang dipakai saat `pm2 start npm --name <basename>`), BUKAN hardcode.
function pm2TargetName() {
  return path.basename(PROJECT_DIR) || 'project';
}

async function cmdProjectAction(chatId, action) {
  ensureDirs();
  const eco = path.join(PROJECT_DIR, 'ecosystem.config.js');
  const pkg = path.join(PROJECT_DIR, 'package.json');
  const hasEco = fs.existsSync(eco);
  const hasPkg = fs.existsSync(pkg);
  const target = pm2TargetName();

  if (!(await pm2Available())) {
    return BOT.sendMessage(chatId,
      '❌ <b>PM2 tidak terpasang.</b>\n\nInstall dulu: <code>npm install -g pm2</code>',
      { parse_mode: 'HTML' });
  }

  if (action === 'start') {
    if (!hasEco && !hasPkg) {
      return BOT.sendMessage(chatId,
        `❌ <b>Tidak bisa start project.</b>\n\n` +
        `Diperlukan <code>ecosystem.config.js</code> atau <code>package.json</code> di:\n` +
        `<code>${escapeHtml(PROJECT_DIR)}</code>\n\n` +
        `<i>Upload project terlebih dahulu lewat /upload.</i>`,
        { parse_mode: 'HTML' });
    }
    const cmd = hasEco
      ? 'pm2 start ecosystem.config.js'
      : `pm2 start npm --name "${target}" -- start`;
    const res = await runShell(cmd, { cwd: PROJECT_DIR, timeout: Math.max(COMMAND_TIMEOUT, 120000) });
    await sendProjectResult(chatId, '🚀', 'START PROJECT', cmd, res);
    return;
  }

  if (action === 'restart') {
    if (!hasEco && !hasPkg) {
      return BOT.sendMessage(chatId, `❌ Tidak ada project di <code>${escapeHtml(PROJECT_DIR)}</code> untuk di-restart.`, { parse_mode: 'HTML' });
    }
    // Target HANYA proses project ini (bukan `pm2 restart all` yang berbahaya).
    const cmd = hasEco ? 'pm2 restart ecosystem.config.js' : `pm2 restart "${target}"`;
    const res = await runShell(cmd, { cwd: PROJECT_DIR, timeout: Math.max(COMMAND_TIMEOUT, 120000) });
    await sendProjectResult(chatId, '🔄', 'RESTART PROJECT', cmd, res);
    return;
  }

  if (action === 'stop') {
    if (!hasEco && !hasPkg) {
      return BOT.sendMessage(chatId, `❌ Tidak ada project di <code>${escapeHtml(PROJECT_DIR)}</code> untuk di-stop.`, { parse_mode: 'HTML' });
    }
    // Target HANYA proses project ini (bukan `pm2 stop all` yang berbahaya).
    const cmd = hasEco ? 'pm2 stop ecosystem.config.js' : `pm2 stop "${target}"`;
    const res = await runShell(cmd, { cwd: PROJECT_DIR, timeout: Math.max(COMMAND_TIMEOUT, 120000) });
    await sendProjectResult(chatId, '⛔', 'STOP PROJECT', cmd, res);
    return;
  }
}

async function sendProjectResult(chatId, icon, title, cmd, res) {
  const out = truncate(redactSecrets(combinedOutput(res)), 2500);
  const head = res.ok
    ? `${icon} <b>${escapeHtml(title)} OK</b>`
    : `❌ <b>${escapeHtml(title)} GAGAL</b>`;
  await BOT.sendMessage(chatId,
    `${head}\n📁 <code>${escapeHtml(PROJECT_DIR)}</code>\n<code>$ ${escapeHtml(cmd)}</code>\n\n<pre>${escapeHtml(out.text)}</pre>`,
    { parse_mode: 'HTML' }).catch(() => {});
}

// ================= FITUR 4b/4c : LOGS & ERRORS =================

async function pm2Logs(chatId, { err = false, lines = 60 } = {}) {
  if (!(await pm2Available())) {
    return BOT.sendMessage(chatId, '❌ <b>PM2 tidak terpasang.</b>\n\nInstall dulu: <code>npm install -g pm2</code>', { parse_mode: 'HTML' });
  }
  const target = pm2TargetName();
  const flag = err ? ' --err' : '';
  let res = await runShell(`pm2 logs "${target}"${flag} --lines ${lines} --nostream`, { timeout: 30000 });
  let label = `pm2 logs ${target}${flag}`;
  // Bila proses project belum ada di PM2, fallback ke log PM2 global (read-only).
  if (!res.ok || /not found|does not exist|no process/i.test(res.stdout + res.stderr)) {
    res = await runShell(`pm2 logs${flag} --lines ${lines} --nostream`, { timeout: 30000 });
    label = `pm2 logs${flag} (semua proses)`;
  }
  const out = redactSecrets(combinedOutput(res));
  const title = err ? '🔴 <b>ERROR LOGS</b>' : '📜 <b>LOGS</b>';
  const t = truncate(out, 3000);
  await BOT.sendMessage(chatId, `${title}\n<code>$ ${escapeHtml(label)}</code>\n\n<pre>${escapeHtml(t.text)}</pre>`, { parse_mode: 'HTML' }).catch(() => {});
  if (t.truncated) {
    try {
      const filePath = writeTempText(`${err ? 'errors' : 'logs'}-${Date.now()}.txt`, out);
      await BOT.sendDocument(chatId, filePath, { caption: '📄 Log lengkap (file .txt)' });
      safeUnlink(filePath);
    } catch (_) {}
  }
}

async function cmdErrors(chatId) {
  // 1) Error log PM2 project.
  await pm2Logs(chatId, { err: true, lines: 60 });
  // 2) create-errors.log milik bot (bila ada).
  try {
    const errFile = path.join(__dirname, 'create-errors.log');
    if (fs.existsSync(errFile)) {
      const content = fs.readFileSync(errFile, 'utf8');
      const tail = content.split('\n').filter(Boolean).slice(-40).join('\n') || '(kosong)';
      const t = truncate(redactSecrets(tail), 3000);
      await BOT.sendMessage(chatId, `🗂 <b>create-errors.log</b> (40 baris terakhir)\n\n<pre>${escapeHtml(t.text)}</pre>`, { parse_mode: 'HTML' }).catch(() => {});
    }
  } catch (_) {}
}

// ================= FITUR 9b : HEALTH CHECK =================

async function cmdHealth(chatId) {
  ensureDirs();
  const [nodeV, npmV, pm2Ok, df] = await Promise.all([
    runShell('node -v', { timeout: 15000 }),
    runShell('npm -v', { timeout: 20000 }),
    pm2Available(),
    runShell('df -kP /', { timeout: 15000 })
  ]);

  const nodeStr = nodeV.ok ? nodeV.stdout.trim() : null;
  const npmStr = npmV.ok ? npmV.stdout.trim() : null;

  const projectOk = fs.existsSync(PROJECT_DIR);
  const pkgOk = projectOk && fs.existsSync(path.join(PROJECT_DIR, 'package.json'));

  let permOk = false;
  try { fs.accessSync(PROJECT_DIR, fs.constants.R_OK | fs.constants.W_OK); permOk = true; } catch (_) { permOk = false; }

  // Disk
  let diskOk = false;
  let diskText = 'tidak tersedia';
  try {
    if (df.ok) {
      const line = df.stdout.trim().split('\n').pop().trim().split(/\s+/);
      if (line.length >= 5) {
        const totalKb = Number(line[1]);
        const availKb = Number(line[3]);
        const usedPct = Number(String(line[4]).replace('%', ''));
        diskOk = usedPct < 90;
        diskText = `${usedPct}% terpakai, sisa ${fmtBytes(availKb * 1024)} / ${fmtBytes(totalKb * 1024)}`;
      }
    }
  } catch (_) {}

  // Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memUsedPct = totalMem ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0;
  const memOk = memUsedPct < 95;
  const memText = `${memUsedPct}% terpakai, free ${fmtBytes(freeMem)} / ${fmtBytes(totalMem)}`;

  // Process status via PM2
  let procText = '⚪ PM2 tidak tersedia';
  let procOk = false;
  if (pm2Ok) {
    const target = pm2TargetName();
    const jl = await runShell('pm2 jlist', { timeout: 20000 });
    if (jl.ok) {
      try {
        const list = JSON.parse(jl.stdout || '[]');
        const proc = Array.isArray(list) ? list.find(p => p?.name === target) : null;
        if (proc) {
          const status = String(proc?.pm2_env?.status || 'unknown');
          procOk = status === 'online';
          procText = `${procOk ? '🟢' : '🔴'} ${status.toUpperCase()} (restart: ${Number(proc?.pm2_env?.restart_time || 0)})`;
        } else {
          procText = '⚪ proses project belum terdaftar di PM2';
        }
      } catch (_) { procText = '⚠️ gagal membaca pm2 jlist'; }
    } else {
      procText = '⚠️ pm2 jlist gagal';
    }
  }

  const mark = (ok) => (ok ? '✅' : '❌');
  const text =
    `🩺 <b>VPS HEALTH</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Node ${mark(Boolean(nodeStr))} ${escapeHtml(nodeStr || 'tidak tersedia')}\n` +
    `NPM ${mark(Boolean(npmStr))} ${escapeHtml(npmStr || 'tidak tersedia')}\n` +
    `PM2 ${mark(pm2Ok)} ${pm2Ok ? 'tersedia' : 'tidak tersedia'}\n` +
    `Project ${mark(projectOk)} <code>${escapeHtml(PROJECT_DIR)}</code>\n` +
    `package ${mark(pkgOk)} ${pkgOk ? 'ditemukan' : 'tidak ada package.json'}\n` +
    `Permission ${mark(permOk)} ${permOk ? 'read/write OK' : 'tidak bisa akses'}\n` +
    `Disk ${mark(diskOk)} ${escapeHtml(diskText)}\n` +
    `Memory ${mark(memOk)} ${escapeHtml(memText)}\n` +
    `Process ${procText}`;

  await BOT.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'vpsmgr_menu' }]] }
  }).catch(() => {});
}

// ================= FITUR 4 & 9 : TERMINAL + UI MENUS =================

function vpsManagerKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📦 Upload ZIP', callback_data: 'vpsmgr_upload' }],
      [{ text: '🛠 Install Base', callback_data: 'vpsmgr_installbase' }],
      [{ text: '📦 NPM Install', callback_data: 'vpsmgr_npminstall' }],
      [{ text: '⌨️ Terminal', callback_data: 'vpsmgr_terminal' }],
      [{ text: '📜 Logs', callback_data: 'vpsmgr_logs' }, { text: '🔴 Errors', callback_data: 'vpsmgr_errors' }],
      [{ text: '📊 Server Status', callback_data: 'vpsmgr_server' }],
      [{ text: '🩺 Health Check', callback_data: 'vpsmgr_health' }],
      [{ text: '🚀 Start Project', callback_data: 'vpsmgr_start' }],
      [{ text: '🔄 Restart Project', callback_data: 'vpsmgr_restart' }],
      [{ text: '⛔ Stop Project', callback_data: 'vpsmgr_stop' }],
      [{ text: '💾 Backup', callback_data: 'vpsmgr_backup' }],
      [{ text: '🤖 Pribadi Asisten (VPS remote)', callback_data: 'pa_menu' }],
      [{ text: '🔙 Kembali', callback_data: 'vpsmgr_back' }]
    ]
  };
}

function terminalKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '⌨️ Input Command', callback_data: 'vpsmgr_term_input' }],
      [{ text: '📊 Status VPS', callback_data: 'vpsmgr_term_status' }],
      [{ text: '🟢 Node Version', callback_data: 'vpsmgr_term_node' }],
      [{ text: '📦 NPM Version', callback_data: 'vpsmgr_term_npm' }],
      [{ text: '📁 Project Info', callback_data: 'vpsmgr_term_project' }],
      [{ text: '❌ Tutup', callback_data: 'vpsmgr_term_close' }]
    ]
  };
}

async function showVpsManagerMenu(chatId) {
  await BOT.sendMessage(chatId,
    `🖥 <b>VPS MANAGER</b>\n\n` +
    `Kelola project di VPS: upload ZIP, install base, npm install, terminal, status, log, health, dan proses PM2.\n\n` +
    `📁 Project : <code>${escapeHtml(PROJECT_DIR)}</code>\n` +
    `🗂 Temp    : <code>${escapeHtml(TEMP_DIR)}</code>\n\n` +
    `ℹ️ Menu ini mengelola <b>host tempat bot berjalan</b> (lokal). Untuk VPS lain via SSH buka <b>🤖 Pribadi Asisten</b>.\n\n` +
    `<i>Semua aksi di menu ini hanya untuk Owner.</i>`,
    { parse_mode: 'HTML', reply_markup: vpsManagerKeyboard() });
}

async function showTerminalMenu(chatId) {
  await BOT.sendMessage(chatId,
    `🖥 <b>VPS TERMINAL</b>\n\nPilih aksi di bawah.\n` +
    `<i>Gunakan "Input Command" lalu kirim command shell dari VPS.</i>`,
    { parse_mode: 'HTML', reply_markup: terminalKeyboard() });
}

async function projectInfo(chatId) {
  ensureDirs();
  let lines = [];
  try {
    const entries = fs.readdirSync(PROJECT_DIR, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).length;
    const files = entries.filter(e => e.isFile()).length;
    lines.push(`📁 Folder: <code>${escapeHtml(PROJECT_DIR)}</code>`);
    lines.push(`📄 File: <b>${files}</b> • 📁 Folder: <b>${dirs}</b>`);
    const top = entries.slice(0, 15).map(e => (e.isDirectory() ? '📁 ' : '📄 ') + escapeHtml(e.name)).join('\n');
    if (top) lines.push(`\n<b>Isi (ringkas):</b>\n${top}`);
    if (entries.length > 15) lines.push(`<i>…dan ${entries.length - 15} item lainnya</i>`);
  } catch (e) {
    lines.push(`❌ Gagal membaca project: ${escapeHtml(e.message)}`);
  }
  await BOT.sendMessage(chatId, `📁 <b>PROJECT INFO</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' }).catch(() => {});
}

// ================= HANDLER: onText (commands owner) =================

function registerServerManager(ctx) {
  BOT = ctx.bot;
  SESSIONS = ctx.sessions;
  SESSION_KEY = ctx.sessionKey;
  IS_OWNER = ctx.isOwner;
  IS_MAIN_BOT = ctx.isMainBot !== false;

  // Bot hasil /deploy default TIDAK mendapat server manager (mencegah privilese
  // shell lintas-owner pada satu host). Aktifkan via setting.SERVER_MANAGER.ENABLE_ON_DEPLOYED.
  if (!IS_MAIN_BOT && !ENABLE_ON_DEPLOYED) return;

  ensureDirs();
  // Simpan token untuk URL unduh Telegram (tidak pernah dikirim ke user).
  try { BOT.__token = (BOT.token || setting.BOT_TOKEN); } catch (_) {}

  // Helper: bungkus handler agar error TIDAK pernah membuat bot crash.
  const safe = (fn) => async (...args) => {
    try { await fn(...args); }
    catch (e) { console.error('[server-manager] handler error:', e && e.message ? e.message : e); }
  };

  // ---- /upload : info cara upload ----
  BOT.onText(/^\/upload(?:@\w+)?(?:\s|$)/i, safe(async (msg) => {
    if (!(await ownerGuard(msg))) return;
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id ?? chatId);
    armLocalUpload(chatId, userId);
    await BOT.sendMessage(chatId,
      `📦 <b>UPLOAD PROJECT (.zip)</b>\n\n` +
      `Kirim file <b>.zip</b> ke chat ini. Bot akan:\n` +
      `1. Validasi file benar-benar ZIP\n` +
      `2. Download ke TEMP_DIR & extract ke PROJECT_DIR\n` +
      `3. Proteksi Zip Slip (../) & hapus ZIP temporary\n` +
      `4. Backup project lama sebelum digantikan\n` +
      `5. Bandingkan dependency; <b>npm install</b> hanya bila berubah (gagal → rollback otomatis)\n` +
      `6. <code>.env</code> &amp; data lama yang tidak ada di ZIP dipertahankan\n\n` +
      `📁 Project: <code>${escapeHtml(PROJECT_DIR)}</code>`,
      { parse_mode: 'HTML' });
  }));

  // ---- /installbase ----
  BOT.onText(/^\/installbase(?:@\w+)?(?:\s|$)/i, safe(async (msg) => {
    if (!(await ownerGuard(msg))) return;
    await cmdInstallBase(msg.chat.id);
  }));

  // ---- /npminstall ----
  BOT.onText(/^\/npminstall(?:@\w+)?(?:\s|$)/i, safe(async (msg) => {
    if (!(await ownerGuard(msg))) return;
    await cmdNpmInstall(msg.chat.id);
  }));

  // ---- /terminal | /term ----
  BOT.onText(/^\/term(?:inal)?(?:@\w+)?(?:\s|$)/i, safe(async (msg) => {
    if (!(await ownerGuard(msg))) return;
    resetSession(msg.chat.id, String(msg.from?.id ?? msg.chat.id));
    await showTerminalMenu(msg.chat.id);
  }));

  // ---- /server ----
  BOT.onText(/^\/server(?:@\w+)?(?:\s|$)/i, safe(async (msg) => {
    if (!(await ownerGuard(msg))) return;
    await cmdServerStatus(msg.chat.id);
  }));

  // ---- /logs ----
  BOT.onText(/^\/logs(?:@\w+)?(?:\s|$)/i, safe(async (msg) => {
    if (!(await ownerGuard(msg))) return;
    await pm2Logs(msg.chat.id, { err: false, lines: 60 });
  }));

  // ---- /errors ----
  BOT.onText(/^\/errors(?:@\w+)?(?:\s|$)/i, safe(async (msg) => {
    if (!(await ownerGuard(msg))) return;
    await cmdErrors(msg.chat.id);
  }));

  // ---- /health ----
  BOT.onText(/^\/health(?:@\w+)?(?:\s|$)/i, safe(async (msg) => {
    if (!(await ownerGuard(msg))) return;
    await cmdHealth(msg.chat.id);
  }));

  // ---- /backupvps (backup PROJECT_DIR). Nama dibedakan dari /backup milik
  //      bot.js (backup source bot) agar tidak ada dua handler /backup. ----
  BOT.onText(/^\/backupvps(?:@\w+)?(?:\s|$)/i, safe(async (msg) => {
    if (!(await ownerGuard(msg))) return;
    await cmdBackupProject(msg.chat.id);
  }));

  // ---- /startproject /restartproject /stopproject ----
  BOT.onText(/^\/startproject(?:@\w+)?(?:\s|$)/i, safe(async (msg) => {
    if (!(await ownerGuard(msg))) return;
    await cmdProjectAction(msg.chat.id, 'start');
  }));
  BOT.onText(/^\/restartproject(?:@\w+)?(?:\s|$)/i, safe(async (msg) => {
    if (!(await ownerGuard(msg))) return;
    await cmdProjectAction(msg.chat.id, 'restart');
  }));
  BOT.onText(/^\/stopproject(?:@\w+)?(?:\s|$)/i, safe(async (msg) => {
    if (!(await ownerGuard(msg))) return;
    await cmdProjectAction(msg.chat.id, 'stop');
  }));

  // ---- Callback query: menu VPS MANAGER + TERMINAL ----
  BOT.on('callback_query', safe(async (query) => {
    const action = query.data || '';
    if (!action.startsWith('vpsmgr_')) return; // hanya tangani callback milik modul ini
    const chatId = String(query.message.chat.id);
    const userId = String(query.from?.id ?? chatId);

    if (!isOwnerId(userId)) {
      return BOT.answerCallbackQuery(query.id, { text: '⛔ Hanya Owner.', show_alert: true }).catch(() => {});
    }

    // Menu VPS MANAGER
    if (action === 'vpsmgr_menu') {
      await BOT.answerCallbackQuery(query.id).catch(() => {});
      return showVpsManagerMenu(chatId);
    }
    if (action === 'vpsmgr_back') {
      try { await BOT.deleteMessage(chatId, query.message.message_id); } catch (_) {}
      resetSession(chatId, userId);
      return BOT.answerCallbackQuery(query.id, { text: 'Kembali.' }).catch(() => {});
    }
    if (action === 'vpsmgr_upload') {
      armLocalUpload(chatId, userId);
      await BOT.answerCallbackQuery(query.id, { text: 'Kirim file .zip ke chat ini.' }).catch(() => {});
      return BOT.sendMessage(chatId,
        `📦 <b>UPLOAD ZIP</b>\n\nKirim file <b>.zip</b> project ke chat ini sekarang.`,
        { parse_mode: 'HTML' });
    }
    if (action === 'vpsmgr_installbase') {
      await BOT.answerCallbackQuery(query.id, { text: 'Menjalankan install base...' }).catch(() => {});
      return cmdInstallBase(chatId);
    }
    if (action === 'vpsmgr_npminstall') {
      await BOT.answerCallbackQuery(query.id, { text: 'Menjalankan npm install...' }).catch(() => {});
      return cmdNpmInstall(chatId);
    }
    if (action === 'vpsmgr_terminal') {
      await BOT.answerCallbackQuery(query.id).catch(() => {});
      return showTerminalMenu(chatId);
    }
    if (action === 'vpsmgr_server') {
      await BOT.answerCallbackQuery(query.id).catch(() => {});
      return cmdServerStatus(chatId);
    }
    if (action === 'vpsmgr_logs') {
      await BOT.answerCallbackQuery(query.id, { text: 'Mengambil log...' }).catch(() => {});
      return pm2Logs(chatId, { err: false, lines: 60 });
    }
    if (action === 'vpsmgr_errors') {
      await BOT.answerCallbackQuery(query.id, { text: 'Mengambil error...' }).catch(() => {});
      return cmdErrors(chatId);
    }
    if (action === 'vpsmgr_health') {
      await BOT.answerCallbackQuery(query.id, { text: 'Health check...' }).catch(() => {});
      return cmdHealth(chatId);
    }
    if (action === 'vpsmgr_backup') {
      await BOT.answerCallbackQuery(query.id, { text: 'Membuat backup...' }).catch(() => {});
      return cmdBackupProject(chatId);
    }
    if (action === 'vpsmgr_start') {
      await BOT.answerCallbackQuery(query.id, { text: 'Start project...' }).catch(() => {});
      return cmdProjectAction(chatId, 'start');
    }
    if (action === 'vpsmgr_restart') {
      await BOT.answerCallbackQuery(query.id, { text: 'Restart project...' }).catch(() => {});
      return cmdProjectAction(chatId, 'restart');
    }
    if (action === 'vpsmgr_stop') {
      await BOT.answerCallbackQuery(query.id, { text: 'Stop project...' }).catch(() => {});
      return cmdProjectAction(chatId, 'stop');
    }

    // Terminal sub-menu
    if (action === 'vpsmgr_term_input') {
      SESSIONS.set(userKey(chatId, userId), INPUT_SESSION);
      await BOT.answerCallbackQuery(query.id, { text: 'Kirim command shell sekarang.' }).catch(() => {});
      return BOT.sendMessage(chatId,
        `⌨️ <b>INPUT COMMAND</b>\n\nKirim command shell yang ingin dijalankan di VPS.\n` +
        `Mode ini <b>aktif</b> sampai kamu klik ❌ Tutup.\n\n` +
        `<i>Contoh:</i> <code>ls -la</code>, <code>pm2 list</code>, <code>df -h</code>`,
        { parse_mode: 'HTML', reply_markup: { force_reply: true, selective: true } });
    }
    if (action === 'vpsmgr_term_status') {
      await BOT.answerCallbackQuery(query.id).catch(() => {});
      return cmdServerStatus(chatId);
    }
    if (action === 'vpsmgr_term_node') {
      await BOT.answerCallbackQuery(query.id).catch(() => {});
      const res = await runShell('node -v', { timeout: 15000 });
      return sendCommandResult(chatId, 'node -v', res.ok ? res.stdout.trim() : 'node tidak tersedia');
    }
    if (action === 'vpsmgr_term_npm') {
      await BOT.answerCallbackQuery(query.id).catch(() => {});
      const res = await runShell('npm -v', { timeout: 20000 });
      return sendCommandResult(chatId, 'npm -v', res.ok ? res.stdout.trim() : 'npm tidak tersedia');
    }
    if (action === 'vpsmgr_term_project') {
      await BOT.answerCallbackQuery(query.id).catch(() => {});
      return projectInfo(chatId);
    }
    if (action === 'vpsmgr_term_close') {
      resetSession(chatId, userId);
      try { await BOT.deleteMessage(chatId, query.message.message_id); } catch (_) {}
      return BOT.answerCallbackQuery(query.id, { text: 'Terminal ditutup.' }).catch(() => {});
    }

    return BOT.answerCallbackQuery(query.id).catch(() => {});
  }));

  // ---- Pesan masuk: dokumen (upload) & input terminal ----
  BOT.on('message', safe(async (msg) => {
    // (a) Upload ZIP dari Owner
    if (msg.document) {
      const uid = String(msg.from?.id ?? msg.chat?.id ?? '');
      if (isOwnerId(uid)) {
        await handleUploadDocument(msg, msg.document);
      }
      return;
    }

    // (b) Input command terminal
    const text = msg.text ? msg.text.trim() : '';
    if (!text) return;
    // Command bot (diawali '/') tetap diproses handler normal -> jangan dianggap shell.
    if (text.startsWith('/')) return;

    const chatId = String(msg.chat.id);
    const userId = String(msg.from?.id ?? chatId);
    if (!isOwnerId(userId)) return;

    const skey = userKey(chatId, userId);
    if (SESSIONS.get(skey) !== INPUT_SESSION) return;

    // Hapus pesan command agar chat tetap rapi (opsional, aman bila gagal).
    try { await BOT.deleteMessage(chatId, msg.message_id); } catch (_) {}

    const res = await runShell(text, {
      cwd: PROJECT_DIR && fs.existsSync(PROJECT_DIR) ? PROJECT_DIR : undefined,
      timeout: COMMAND_TIMEOUT,
      maxBuffer: 8 * 1024 * 1024
    });
    await sendCommandResult(chatId, text, combinedOutput(res));
  }));

  // ---- 🤖 Pribadi Asisten (VPS remote via SSH) ----
  try {
    PA_API = require('./personal-assistant.js').register({
      bot: BOT, isOwner: isOwnerId, sessions: SESSIONS, sessionKey: SESSION_KEY,
      helpers: {
        escapeHtml, redactSecrets, fmtBytes, fmtUptime, downloadToFile, looksLikeZip, inspectZip,
        writeTempText, safeUnlink, TEMP_DIR, MAX_ZIP_BYTES, COMMAND_TIMEOUT,
        DEFAULT_PROJECT_DIR: PROJECT_DIR,
        getToken: () => BOT.__token || setting.BOT_TOKEN,
        clearLocalUpload: (uid) => {
          for (const k of [...LOCAL_ARMED.keys()]) if (k.endsWith(`:${uid}`)) LOCAL_ARMED.delete(k);
        }
      }
    });
  } catch (e) {
    console.error('[server-manager] Pribadi Asisten gagal dimuat:', e && e.message ? e.message : e);
  }

  console.log('[server-manager] VPS/Server Manager aktif — PROJECT_DIR:', PROJECT_DIR, '| TEMP_DIR:', TEMP_DIR);
}

module.exports = {
  registerServerManager,
  // diekspor untuk keperluan test:
  _internal: {
    safeExtractZip, inspectZip, redactSecrets, looksLikeZip, escapeHtml, truncate,
    sanitizedEnv, carryOverData, swapProjectDir, diffDepMaps, createProjectBackup, pm2TargetName, PROJECT_DIR, TEMP_DIR
  }
};
