'use strict';
/**
 * personal-assistant.js — menu 🤖 PRIBADI ASISTEN (VPS remote via SSH).
 *
 * Modul tambahan (additive): dipasang dari server-manager.js. Tidak mengubah
 * fitur lama. Semua callback memakai prefix `pa_` dan SEMUA wajib OWNER +
 * chat pribadi (secret tidak boleh dikirim di grup).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./ssh-core.js');
const { shQuote } = core;

let BOT = null, IS_OWNER = null, SESSIONS = null, SESSION_KEY = null, H = null;

const STATE = new Map();          // userId -> { type, step, data, ts }
const STATE_TTL_MS = 15 * 60 * 1000;
const LOCKS = new Set();          // profile-level lock untuk operasi yang mengubah server
const LISTS = new Map();          // userId -> { kind, items, ts } (cache index tombol)
const HISTORY = new Map();        // userId -> string[] (tanpa secret, hanya memori)
const CWD = new Map();            // profileId -> folder aktif terminal (cd tetap nyambung seperti Termius)
const FAILS = new Map();          // profileId -> number[] (timestamp gagal start)
const MAX_HISTORY = 10;
const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024; // batas getFile Bot API publik

// Backup AMAN (default): tanpa .env / credential / database. Backup LENGKAP: semua file kecuali yang bisa dibuat ulang.
const BACKUP_EXCLUDES_BASE = ['node_modules', '.npm', 'npm-cache', '.cache', '.git', 'tmp', '.tmp', '*.log'];
const BACKUP_EXCLUDES_SECRET = [
  '.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*',
  '*.sqlite', '*.sqlite3', '*.db', 'vps-store.json', 'railway-token.json',
  'vps-profiles.enc.json', '*.enc.json'
];
const BACKUP_NAME_RE = /^backup-[0-9-]+(-full)?\.tar\.gz$/;
const CWD_MARK = '__CVPS_CWD__';
const INTERACTIVE_RE = /^\s*(sudo\s+)?(vim?|nano|emacs|top|htop|less|more|man|watch|tmux|screen|ssh|ftp|telnet|passwd|mysql|psql|python3?|node|irb)\s*$/i;

// ============================================================ util umum
const esc = (v) => H.escapeHtml(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const btn = (text, data) => ({ text, callback_data: data });

function redact(text) {
  let s = String(text ?? '');
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]');
  return H.redactSecrets(s);
}
const safeErr = (e) => redact(String((e && e.message) || e || 'error')).slice(0, 300);
const tailText = (t, n = 600) => { const s = String(t || '').trim(); return s.length > n ? '…' + s.slice(-n) : s; };

function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}

async function send(chatId, text, rows) {
  try {
    return await BOT.sendMessage(chatId, String(text).slice(0, 4000), {
      parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: rows ? { inline_keyboard: rows } : undefined
    });
  } catch (e) { console.error('[personal-assistant] send gagal:', safeErr(e)); return null; }
}
async function edit(msg, text, rows) {
  if (!msg) return null;
  try {
    await BOT.editMessageText(String(text).slice(0, 4000), {
      chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: 'HTML',
      disable_web_page_preview: true, reply_markup: rows ? { inline_keyboard: rows } : undefined
    });
    return msg;
  } catch (e) {
    if (/not modified/i.test(String(e && e.message))) return msg;
    return send(msg.chat.id, text, rows);
  }
}
/** Edit pesan callback; bila tidak bisa (mis. pesan foto /start) kirim pesan baru. */
async function ui(q, text, rows) {
  const chatId = q.message.chat.id;
  try {
    await BOT.editMessageText(String(text).slice(0, 4000), {
      chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML',
      disable_web_page_preview: true, reply_markup: rows ? { inline_keyboard: rows } : undefined
    });
  } catch (e) {
    if (/not modified/i.test(String(e && e.message))) return;
    await send(chatId, text, rows);
  }
}

/** Kirim output panjang: potong aman di pesan + SELALU file TXT bila terpotong. */
async function sendOutput(chatId, header, raw, o = {}) {
  const clean = redact(raw || '(tidak ada output)');
  const LIM = o.limit || 2600;
  const shown = clean.length > LIM ? clean.slice(0, LIM) + `\n…(dipotong, ${clean.length - LIM} karakter lagi → lihat file TXT)` : clean;
  const text = `${header}\n\n<pre>${esc(shown)}</pre>` + (o.footer ? `\n\n${o.footer}` : '');
  const sent = await send(chatId, text, o.rows);
  if (!sent) await send(chatId, `${header}\n\n${esc(shown)}`, o.rows);
  if (clean.length > LIM) {
    let file = null;
    try {
      file = H.writeTempText(`${o.filePrefix || 'output'}-${Date.now()}.txt`, clean.slice(0, 2 * 1024 * 1024));
      await BOT.sendDocument(chatId, file, { caption: '📄 Output lengkap (TXT)' });
    } catch (e) { await send(chatId, `⚠️ Gagal mengirim TXT: ${esc(safeErr(e))}`); }
    finally { H.safeUnlink(file); }
  }
}

function dropLegacySession(chatId, userId) {
  try { SESSIONS.delete(SESSION_KEY(String(chatId), String(userId))); } catch (_) {}
}
function setState(uid, type, step, data, chatId) {
  STATE.set(String(uid), { type, step, data: data || {}, ts: Date.now(), chatId });
}
function clearState(uid) {
  const st = STATE.get(String(uid));
  if (st && st.data) { for (const k of Object.keys(st.data)) st.data[k] = null; }
  STATE.delete(String(uid));
}
function getState(uid, type) {
  const st = STATE.get(String(uid));
  if (!st) return null;
  if (Date.now() - st.ts > STATE_TTL_MS) { clearState(uid); return null; }
  if (type && st.type !== type) return null;
  return st;
}

async function withLock(profileId, chatId, fn) {
  const key = `p:${profileId}`;
  if (LOCKS.has(key)) { await send(chatId, '⏳ Masih ada proses lain yang berjalan di VPS ini. Tunggu sampai selesai.'); return undefined; }
  LOCKS.add(key);
  try { return await fn(); } finally { LOCKS.delete(key); }
}

/** Ticker "⏳ ... (Ns)" untuk operasi panjang; selalu dihentikan lewat stop(). */
function ticker(msg, render, everyMs = 15000) {
  const started = Date.now();
  const t = setInterval(() => { edit(msg, render(Math.floor((Date.now() - started) / 1000))).catch(() => {}); }, everyMs);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

// ============================================================ profil aktif & koneksi
function statusLabel(p) {
  if (!p.lastTest) return '⚪ Belum dites';
  return p.lastTest.ok ? `🟢 Connected (${ago(Date.now() - p.lastTest.ts)})` : `🔴 Gagal (${ago(Date.now() - p.lastTest.ts)})`;
}
function activePublic() {
  const id = core.getActiveId();
  return id ? core.getPublicProfile(id) : null;
}
const notConnectedRows = [[btn('🔐 Connect VPS', 'pa_conn')]];

async function needProfile(chatId) {
  let p = null;
  try {
    const id = core.getActiveId();
    p = id ? core.getProfile(id) : null;
  } catch (_) {
    await send(chatId, '❌ <b>Profil VPS tidak bisa dibuka.</b>\n\nKunci enkripsi berubah/hilang. Hapus profil lalu tambah ulang.', [[btn('🔐 VPS Connection', 'pa_conn')]]);
    return null;
  }
  if (!p) { await send(chatId, '❌ <b>VPS belum terhubung.</b>', notConnectedRows); return null; }
  return p;
}
function markTest(id, ok) { try { core.updateProfile(id, { lastTest: { ok, ts: Date.now() } }); } catch (_) {} }

async function reportSshFail(chatId, p, e) {
  markTest(p.id, false);
  await send(chatId,
    `❌ <b>SSH CONNECTION FAILED</b>\n\nHost: <code>${esc(p.host)}</code>\nPort: <code>${p.port}</code>\nUser: <code>${esc(p.username)}</code>\n\nPenyebab: ${esc(e.safeMessage || 'koneksi gagal')}`,
    [...(e.kind === 'hostkey' ? [[btn('🔓 Percayai host key baru', `pa_repin:${p.id}`)]] : []), [btn('🔄 Test Connection', `pa_test:${p.id}`), btn('🔐 VPS Connection', 'pa_conn')]]);
}

/** Buka koneksi ke profil aktif, jalankan fn(conn, profile), tutup koneksi. */
async function withConn(chatId, fn) {
  const p = await needProfile(chatId);
  if (!p) return undefined;
  let conn;
  try { conn = await core.openConnection(p); }
  catch (e) { await reportSshFail(chatId, p, e); return undefined; }
  markTest(p.id, true);
  try { return await fn(conn, p); }
  catch (e) {
    console.error('[personal-assistant] operasi gagal:', safeErr(e));
    await send(chatId, `❌ <b>Operasi gagal</b>\n\n<code>${esc(safeErr(e))}</code>`);
    return undefined;
  } finally { try { conn.end(); } catch (_) {} }
}

const R = (conn, cmd, opts) => core.runOnConn(conn, cmd, opts);
async function readRemoteFile(conn, file, max = 262144) {
  const r = await R(conn, `[ -f ${shQuote(file)} ] && head -c ${max} ${shQuote(file)}`, { timeout: 20000, maxBytes: max + 1024 });
  return r.ok ? r.stdout : null;
}
const parseJson = (t) => { try { return JSON.parse(t); } catch (_) { return null; } };
const baseOf = (dir) => path.posix.basename(dir) || 'project';

// ============================================================ PM2 helpers
function parseJlist(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('[')) continue;
    try {
      const arr = JSON.parse(l);
      if (!Array.isArray(arr)) continue;
      return arr.map((x) => ({
        name: String(x.name || ''), pm_id: x.pm_id, pid: x.pid,
        status: x.pm2_env && x.pm2_env.status, restarts: (x.pm2_env && x.pm2_env.restart_time) || 0,
        since: x.pm2_env && x.pm2_env.pm_uptime, cwd: x.pm2_env && x.pm2_env.pm_cwd,
        errLog: x.pm2_env && x.pm2_env.pm_err_log_path, outLog: x.pm2_env && x.pm2_env.pm_out_log_path,
        mem: (x.monit && x.monit.memory) || 0, cpu: (x.monit && x.monit.cpu) || 0
      }));
    } catch (_) { /* coba baris sebelumnya */ }
  }
  return [];
}
async function pm2List(conn) {
  const r = await R(conn, 'command -v pm2 >/dev/null 2>&1 || { echo NOPM2; exit 127; }; pm2 jlist 2>/dev/null', { timeout: 40000, maxBytes: 4 * 1024 * 1024 });
  if (/NOPM2/.test(r.stdout)) return { installed: false, list: [] };
  return { installed: true, list: parseJlist(r.stdout) };
}
const projectProcs = (list, dir) => list.filter((x) => x.cwd && (x.cwd === dir || x.cwd.startsWith(dir + '/')));
const pmIcon = (s) => (s === 'online' ? '🟢' : s === 'launching' ? '🟡' : s === 'stopped' ? '⚪' : '🔴');
function procLine(x) {
  const up = x.status === 'online' && x.since ? ` • up ${H.fmtUptime((Date.now() - x.since) / 1000)}` : '';
  return `${pmIcon(x.status)} <b>${esc(x.name)}</b> [${x.pm_id}] — ${esc(x.status)}${up} • ♻️ ${x.restarts} • ${H.fmtBytes(x.mem)}`;
}
const noPm2Rows = [[btn('📦 Install PM2', 'pa_pm2_install')], [btn('🔙 Kembali', 'pa_menu')]];

async function tailLog(conn, file, lines = 40, maxBytes = 9000) {
  if (!file) return '';
  const r = await R(conn, `[ -f ${shQuote(file)} ] && tail -n ${Number(lines)} ${shQuote(file)} | tail -c ${Number(maxBytes)}`, { timeout: 20000, maxBytes: maxBytes + 1024 });
  return r.ok ? r.stdout : '';
}

function diagnose(text) {
  const t = String(text || '');
  if (/Cannot find module|MODULE_NOT_FOUND/i.test(t)) return { cause: 'package dependency missing (modul tidak ditemukan).', npm: true };
  if (/Missing script/i.test(t)) return { cause: 'package.json tidak punya script "start".' };
  if (/EADDRINUSE/i.test(t)) return { cause: 'port sudah dipakai proses lain (EADDRINUSE).' };
  if (/SyntaxError/i.test(t)) return { cause: 'error sintaks pada source code.' };
  if (/EACCES|permission denied/i.test(t)) return { cause: 'izin akses file/folder (permission denied).' };
  if (/ENOMEM|heap out of memory|Killed/i.test(t)) return { cause: 'memori server tidak cukup.' };
  if (/ENOENT|no such file/i.test(t)) return { cause: 'file/path tidak ditemukan (ENOENT).' };
  if (/command not found|not found/i.test(t)) return { cause: 'tool yang dibutuhkan belum terpasang.' };
  return { cause: 'belum teridentifikasi — cek error log.' };
}

// ============================================================ health / preflight
function probeScript(dir) {
  return `D=${shQuote(dir)}
echo "node=$(node -v 2>/dev/null)"
echo "npm=$(npm -v 2>/dev/null)"
echo "pm2=$(pm2 -v 2>/dev/null | tail -n1)"
if [ -d "$D" ]; then echo "project=1"; else echo "project=0"; fi
if [ -f "$D/package.json" ]; then echo "package=1"; else echo "package=0"; fi
if [ -d "$D/node_modules" ]; then echo "modules=1"; else echo "modules=0"; fi
if [ -d "$D" ] && [ -w "$D" ]; then echo "writable=1"; else echo "writable=0"; fi
for f in ecosystem.config.js ecosystem.config.cjs ecosystem.config.json ecosystem.config.mjs; do if [ -f "$D/$f" ]; then echo "eco=$f"; break; fi; done
if [ -d "$D" ]; then P="$D"; else P="$(dirname "$D")"; fi
df -PB1 "$P" 2>/dev/null | awk 'NR==2{print "disk_total="$2"\\ndisk_used="$3"\\ndisk_avail="$4"\\ndisk_pct="$5}'
free -b 2>/dev/null | awk '/^Mem:/{print "mem_total="$2"\\nmem_used="$3"\\nmem_avail="$7}'
echo "load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"
echo "cores=$(nproc 2>/dev/null)"
`;
}

async function collectHealth(conn, p) {
  const r = await R(conn, probeScript(p.projectDir), { timeout: 30000 });
  const kv = core.parseKv(r.stdout);
  const pkgText = kv.package === '1' ? await readRemoteFile(conn, `${p.projectDir}/package.json`) : null;
  const pkg = pkgText ? parseJson(pkgText) : null;
  const pm = await pm2List(conn);
  return { kv, pkg, pm, procs: pm.installed ? projectProcs(pm.list, p.projectDir) : [] };
}
const depMap = (pkg) => {
  const m = {};
  for (const sec of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [k, v] of Object.entries((pkg && pkg[sec]) || {})) m[k] = String(v);
  }
  return m;
};

/** -> { items:[{label,icon,text}], blockers:[string] } */
function evaluateHealth(h, p) {
  const { kv, pkg, pm, procs } = h;
  const items = [], blockers = [];
  const add = (label, icon, text) => items.push({ label, icon, text });
  const block = (label, why) => blockers.push(`${label}: ${why}`);

  if (kv.node) add('Node', '✅', kv.node); else { add('Node', '❌', 'tidak terpasang'); block('Node.js', 'belum terpasang'); }
  const needNpm = kv.package === '1';
  if (kv.npm) add('NPM', '✅', kv.npm); else { add('NPM', needNpm ? '❌' : '⚠️', 'tidak terpasang'); if (needNpm) block('NPM', 'belum terpasang'); }
  if (kv.pm2) add('PM2', '✅', kv.pm2); else { add('PM2', '❌', 'tidak terpasang'); block('PM2', 'belum terpasang'); }
  if (kv.project === '1') add('Project', '✅', p.projectDir); else { add('Project', '❌', `${p.projectDir} tidak ada`); block('PROJECT_DIR', `${p.projectDir} tidak ditemukan`); }
  if (kv.package === '1' && pkg) add('Package', '✅', 'package.json valid');
  else if (kv.package === '1') { add('Package', '❌', 'package.json rusak'); block('package.json', 'bukan JSON valid'); }
  else if (kv.eco) add('Package', '⚠️', `tanpa package.json (pakai ${kv.eco})`);
  else { add('Package', '❌', 'package.json tidak ada'); if (kv.project === '1') block('package.json', 'tidak ditemukan dan tidak ada ecosystem config'); }
  const declared = Object.keys(depMap(pkg)).length;
  if (kv.package === '1') {
    if (declared === 0 || kv.modules === '1') add('Deps', '✅', declared ? `${declared} dependency terpasang` : 'tanpa dependency');
    else { add('Deps', '❌', 'node_modules belum ada'); block('Dependencies', 'belum terpasang (jalankan npm install)'); }
  }
  const pct = parseInt(String(kv.disk_pct || '').replace('%', ''), 10);
  if (Number.isFinite(pct)) {
    const txt = `${pct}% terpakai • sisa ${H.fmtBytes(kv.disk_avail)}`;
    if (pct >= 97) { add('Disk', '❌', txt); block('Disk', `hampir penuh (${pct}%)`); }
    else if (pct >= 90) add('Disk', '⚠️', txt); else add('Disk', '✅', txt);
  } else add('Disk', '⚠️', 'tidak terbaca');
  const mt = Number(kv.mem_total), ma = Number(kv.mem_avail);
  if (mt > 0) {
    const free = ma / mt;
    add('Memory', free < 0.05 ? '⚠️' : '✅', `${H.fmtBytes(mt - ma)} / ${H.fmtBytes(mt)} terpakai`);
  } else add('Memory', '⚠️', 'tidak terbaca');
  const cores = Number(kv.cores) || 1, load = Number(kv.load);
  if (Number.isFinite(load)) add('CPU', load / cores > 2 ? '⚠️' : '✅', `load ${load} / ${cores} core`); else add('CPU', '⚠️', 'tidak terbaca');
  if (kv.writable === '1') add('Permission', '✅', 'folder project bisa ditulis');
  else { add('Permission', '❌', 'folder project tidak bisa ditulis'); if (kv.project === '1') block('Permission', 'PROJECT_DIR tidak writable oleh user SSH'); }
  if (!pm.installed) add('Process', '⚪', 'PM2 belum ada');
  else if (!procs.length) add('Process', '⚪', 'belum ada proses project');
  else {
    const online = procs.filter((x) => x.status === 'online').length;
    add('Process', online === procs.length ? '🟢' : '🔴', `${online}/${procs.length} ${online === procs.length ? 'RUNNING' : 'ada yang mati'}`);
  }
  return { items, blockers };
}

async function preflight(conn, p) {
  const h = await collectHealth(conn, p);
  const ev = evaluateHealth(h, p);
  return { ...h, ...ev, ok: ev.blockers.length === 0 };
}
function healthText(title, ev) {
  const w = Math.max(...ev.items.map((i) => i.label.length));
  return `${title}\n\n<pre>${esc(ev.items.map((i) => `${i.label.padEnd(w)}  ${i.icon} ${i.text}`).join('\n'))}</pre>`;
}
const blockedText = (what, blockers) => `❌ <b>PROJECT ${what} BLOCKED</b>\n\nReason:\n${blockers.map((b) => `• ${esc(b)}`).join('\n')}`;

// ============================================================ dependency diff
function diffDeps(oldPkg, newPkg) {
  const a = depMap(oldPkg), b = depMap(newPkg);
  const added = [], removed = [], changed = [];
  for (const k of Object.keys(b)) {
    if (!(k in a)) added.push(`${k}@${b[k]}`);
    else if (a[k] !== b[k]) changed.push(`${k}: ${a[k]} → ${b[k]}`);
  }
  for (const k of Object.keys(a)) if (!(k in b)) removed.push(`${k}@${a[k]}`);
  return { added, removed, changed, total: added.length + removed.length + changed.length };
}
function fmtDiff(d) {
  const sec = (title, arr) => (arr.length ? `\n<b>${title}</b>\n${arr.slice(0, 15).map((x) => `• ${esc(x)}`).join('\n')}${arr.length > 15 ? `\n…+${arr.length - 15} lainnya` : ''}\n` : '');
  return `⚠️ <b>DEPENDENCY CHANGED</b>\n${sec('Dependencies baru:', d.added)}${sec('Dependencies dihapus:', d.removed)}${sec('Dependencies berubah:', d.changed)}`;
}
const snapshotJson = (pkg) => JSON.stringify({
  dependencies: (pkg && pkg.dependencies) || {}, devDependencies: (pkg && pkg.devDependencies) || {},
  optionalDependencies: (pkg && pkg.optionalDependencies) || {}
});

// ============================================================ MENU
function actionRows() {
  return [
    [btn('📦 Upload Source', 'pa_upload'), btn('⌨️ Terminal VPS', 'pa_term')],
    [btn('📊 Server Status', 'pa_status'), btn('📜 Logs & Error', 'pa_logs')],
    [btn('⚙️ PM2 Manager', 'pa_pm2'), btn('🩺 Health Check', 'pa_health')],
    [btn('💾 Backup', 'pa_backup'), btn('📦 NPM Manager', 'pa_npm')]
  ];
}
function connLine() {
  const a = activePublic();
  return a
    ? `🔐 Koneksi aktif: <b>${esc(a.label)}</b> — <code>${esc(a.host)}</code> (${esc(a.username)}) ${statusLabel(a)}`
    : '🔐 Koneksi aktif: <b>belum ada</b> — buka 🔐 VPS Connection';
}
async function showMain(q) {
  await ui(q,
    `🤖 <b>PRIBADI ASISTEN</b>\n\nAsisten pribadi untuk mengelola project dan server VPS langsung dari Telegram.\n` +
    `<i>Kelola VPS, source project, terminal, logs, PM2, dan health server via SSH.</i>\n\n${connLine()}\n\n<i>Hanya Owner • gunakan di chat pribadi.</i>`,
    [[btn('🖥️ VPS Manager', 'pa_vps')], ...actionRows(), [btn('🔐 VPS Connection', 'pa_conn')], [btn('🏠 Manager Lokal (host bot)', 'vpsmgr_menu')], [btn('🔙 Kembali', 'pa_back')]]);
}
async function showVps(q) {
  const a = activePublic();
  if (!a) {
    return ui(q, '🖥️ <b>VPS MANAGER</b>\n\n❌ <b>VPS belum terhubung.</b>', [...notConnectedRows, [btn('🔙 Kembali', 'pa_menu')]]);
  }
  await ui(q,
    `🖥️ <b>VPS MANAGER</b>\n\n<b>${esc(a.label)}</b>\nHost: <code>${esc(a.host)}</code>\nPort: <code>${a.port}</code>\nUser: <code>${esc(a.username)}</code>\n` +
    `Project: <code>${esc(a.projectDir)}</code>\nStatus: ${statusLabel(a)}`,
    [[btn('🔄 Test Connection', `pa_test:${a.id}`), btn('📁 Project Dir', `pa_pdir:${a.id}`)], [btn('🧰 Install Base (Node, PM2, unzip)', 'pa_installbase')], ...actionRows(), [btn('🔐 VPS Connection', 'pa_conn'), btn('🔙 Kembali', 'pa_menu')]]);
}

// ============================================================ VPS CONNECTION
async function showConn(q) {
  const list = core.listProfiles();
  const activeId = core.getActiveId();
  const text = list.length
    ? `🔐 <b>VPS CONNECTION</b>\n\n` + list.map((p) =>
        `🖥️ <b>${esc(p.label)}</b>${p.id === activeId ? ' ⭐' : ''}\nHost: <code>${esc(p.host)}</code>\nUser: <code>${esc(p.username)}</code>\nStatus: ${statusLabel(p)}`).join('\n\n')
    : '🔐 <b>VPS CONNECTION</b>\n\nBelum ada profil VPS. Tambahkan VPS pertama kamu.';
  await ui(q, text, [
    [btn('➕ Tambah VPS', 'pa_add')],
    ...list.map((p) => [btn(`🖥️ ${p.label}${p.id === activeId ? ' ⭐' : ''} · ${p.host}`.slice(0, 60), `pa_prof:${p.id}`)]),
    [btn('🔙 Kembali', 'pa_menu')]
  ]);
}
async function showProfile(q, id) {
  const p = core.getPublicProfile(id);
  if (!p) return ui(q, '❌ Profil tidak ditemukan.', [[btn('🔙 Kembali', 'pa_conn')]]);
  await ui(q,
    `🖥️ <b>${esc(p.label)}</b>${id === core.getActiveId() ? ' ⭐ (aktif)' : ''}\nHost: <code>${esc(p.host)}</code>\nPort: <code>${p.port}</code>\nUser: <code>${esc(p.username)}</code>\n` +
    `Auth: ${p.authType === 'key' ? '🔑 SSH Private Key' : '🔒 Password'}\nProject: <code>${esc(p.projectDir)}</code>\n` +
    `Host key: <code>${esc(p.hostFingerprint || '(belum dipin)')}</code>\nStatus: ${statusLabel(p)}`,
    [[btn('🔌 Connect', `pa_connect:${id}`), btn('🔄 Test Connection', `pa_test:${id}`)],
     [btn('📁 Project Dir', `pa_pdir:${id}`), btn('🗑️ Remove', `pa_rm:${id}`)],
     [btn('🔙 Kembali', 'pa_conn')]]);
}

function wizHeader(d) {
  return `🔐 <b>VPS CONNECTION</b>\n\nHost: <code>${esc(d.host)}</code>\nPort: <code>${d.port}</code>\nUser: <code>${esc(d.username)}</code>`;
}
const cancelRow = [[btn('❌ Batal', 'pa_cancel')]];

async function startWizard(q) {
  const chatId = q.message.chat.id, uid = String(q.from.id);
  dropLegacySession(chatId, uid);
  setState(uid, 'wiz', 'host', {}, chatId);
  await ui(q, '➕ <b>TAMBAH VPS</b> (1/4)\n\nKirim <b>Host / IP</b> VPS, <b>atau tempel perintah SSH-nya</b> (seperti di Termius):\n<code>ssh root@autorack.proxy.rlwy.net -p 33291</code>', cancelRow);
}

async function runWizardTest(chatId, uid) {
  const st = getState(uid, 'wiz');
  if (!st) return;
  const d = st.data;
  st.step = 'testing';
  const msg = await send(chatId, `${wizHeader(d)}\n\n⏳ Testing SSH connection...`);
  const res = await core.testConnection({
    host: d.host, port: d.port, username: d.username, authType: d.authType,
    privateKey: d.privateKey, passphrase: d.passphrase, password: d.password
  });
  if (!res.ok) {
    st.step = 'retry'; st.ts = Date.now();
    return edit(msg, `❌ <b>SSH CONNECTION FAILED</b>\n\nHost: <code>${esc(d.host)}</code>\nPort: <code>${d.port}</code>\nUser: <code>${esc(d.username)}</code>\n\nPenyebab: ${esc(res.message)}`,
      [[btn('🔁 Coba Lagi', 'pa_wretry'), btn('❌ Batal', 'pa_cancel')]]);
  }
  let prof;
  try {
    prof = core.addProfile({
      host: d.host, port: d.port, username: d.username, authType: d.authType,
      privateKey: d.privateKey, passphrase: d.passphrase, password: d.password,
      projectDir: core.defaultProjectDir(d.username, H.DEFAULT_PROJECT_DIR), hostFingerprint: res.fingerprint
    });
    core.setActive(prof.id);
    markTest(prof.id, true);
  } catch (e) {
    clearState(uid);
    return edit(msg, `❌ <b>Gagal menyimpan profil</b>\n\n<code>${esc(safeErr(e))}</code>`);
  }
  let railwayNote = '';
  if (/\.rlwy\.net$/i.test(prof.host)) {
    try { // Railway: hanya Volume yang persisten (umumnya /data)
      const vol = await core.execRemote({ host: d.host, port: d.port, username: d.username, authType: d.authType, privateKey: d.privateKey, passphrase: d.passphrase, password: d.password, hostFingerprint: res.fingerprint }, '[ -d /data ] && [ -w /data ] && echo yes', { timeout: 15000 });
      if (vol.stdout.includes('yes')) { prof = core.updateProfile(prof.id, { projectDir: '/data/project' }) || prof; railwayNote = '\n📦 Terdeteksi Volume <code>/data</code> → project dir otomatis <code>/data/project</code> (tahan redeploy).'; }
      else railwayNote = '\n⚠️ Railway: file di luar <b>Volume</b> hilang saat redeploy. Pasang Volume lalu ubah 📁 Project Dir ke folder volume.';
    } catch (_) { /* abaikan: hanya saran */ }
  }
  clearState(uid);
  return edit(msg,
    `✅ <b>VPS CONNECTED</b>\n\nHost: <code>${esc(prof.host)}</code>\nPort: <code>${prof.port}</code>\nUser: <code>${esc(prof.username)}</code>\nStatus: Online\n` +
    `OS: ${esc(res.os || '-')}\nLatency: ${res.latencyMs} ms\nHost key: <code>${esc(res.fingerprint)}</code>\n\n` +
    `🔒 Kredensial disimpan <b>terenkripsi</b> (tidak pernah ditampilkan kembali).\n📁 Project dir: <code>${esc(prof.projectDir)}</code>${railwayNote}`,
    [[btn('🖥️ VPS Manager', 'pa_vps'), btn('🔐 VPS Connection', 'pa_conn')]]);
}

async function wizardText(msg, st, text) {
  const chatId = msg.chat.id, uid = String(msg.from.id);
  const d = st.data;
  const sensitive = ['key', 'pass', 'pw'].includes(st.step);
  if (sensitive) { try { await BOT.deleteMessage(chatId, msg.message_id); } catch (_) {} }
  st.ts = Date.now();

  if (st.step === 'host') {
    const parsed = core.parseSshCommand(text);
    if (parsed) { // contoh: ssh root@autorack.proxy.rlwy.net -p 33291
      d.host = parsed.host; d.port = parsed.port; d.username = parsed.username; st.step = 'auth';
      return void send(chatId, `✅ Terbaca dari perintah SSH:\n\nHost: <code>${esc(d.host)}</code>\nPort: <code>${d.port}</code>\nUser: <code>${esc(d.username)}</code>\n\nPilih <b>metode autentikasi</b>:`,
        [[btn('🔒 Password (Railway SSH)', 'pa_auth:pw')], [btn('🔑 SSH Private Key', 'pa_auth:key')], [btn('❌ Batal', 'pa_cancel')]]);
    }
    if (/^\s*[$>]?\s*ssh\b/i.test(text)) { // jelas perintah ssh tapi tidak terbaca -> kasih tahu formatnya
      return void send(chatId, '⚠️ Perintah SSH tidak terbaca. Format yang diterima:\n<code>ssh root@host.com -p 2222</code>\n<code>ssh -p 2222 root@1.2.3.4</code>\n<code>root@host.com:2222</code>\n\nCek host &amp; port, lalu kirim ulang.', cancelRow);
    }
    const v = core.validateHost(text);
    if (!v.ok) return void send(chatId, `⚠️ ${esc(v.error)} Kirim ulang Host/IP atau perintah SSH-nya.`, cancelRow);
    d.host = v.value; st.step = 'port';
    return void send(chatId, `➕ <b>TAMBAH VPS</b> (2/4)\n\nKirim <b>Port SSH</b> (kirim <code>22</code> untuk default).`, cancelRow);
  }
  if (st.step === 'port') {
    const v = core.validatePort(text === '-' ? '22' : text);
    if (!v.ok) return void send(chatId, `⚠️ ${esc(v.error)}`, cancelRow);
    d.port = v.value; st.step = 'user';
    return void send(chatId, `➕ <b>TAMBAH VPS</b> (3/4)\n\nKirim <b>Username SSH</b>. Contoh: <code>root</code>`, cancelRow);
  }
  if (st.step === 'user') {
    const v = core.validateUsername(text);
    if (!v.ok) return void send(chatId, `⚠️ ${esc(v.error)}`, cancelRow);
    d.username = v.value; st.step = 'auth';
    return void send(chatId, `➕ <b>TAMBAH VPS</b> (4/4)\n\nPilih <b>metode autentikasi</b>:`,
      [[btn('🔑 SSH Private Key (disarankan)', 'pa_auth:key')], [btn('🔒 Password (fallback)', 'pa_auth:pw')], [btn('❌ Batal', 'pa_cancel')]]);
  }
  if (st.step === 'key') {
    if (!core.looksLikePrivateKey(text)) {
      return void send(chatId, '⚠️ Teks itu bukan private key (harus diawali <code>-----BEGIN ... PRIVATE KEY-----</code>). Kirim ulang, atau kirim file key (.pem).', cancelRow);
    }
    return void (await acceptKey(chatId, uid, st, text));
  }
  if (st.step === 'pass') {
    const insp = core.inspectPrivateKey(d.privateKey, text);
    if (!insp.ok) {
      d.tries = (d.tries || 0) + 1;
      if (d.tries >= 3) { clearState(uid); return void send(chatId, '❌ Passphrase salah 3x. Proses dibatalkan.', [[btn('🔐 VPS Connection', 'pa_conn')]]); }
      return void send(chatId, `⚠️ ${esc(insp.error)} Kirim passphrase lagi.`, cancelRow);
    }
    d.passphrase = text;
    return void (await runWizardTest(chatId, uid));
  }
  if (st.step === 'pw') {
    if (!text) return;
    d.password = text;
    return void (await runWizardTest(chatId, uid));
  }
  if (st.type === 'wiz' && st.step === 'pdir') return void (await applyProjectDir(chatId, uid, st, text));
}

async function acceptKey(chatId, uid, st, rawKey) {
  const d = st.data;
  const key = core.normalizeKey(rawKey);
  const insp = core.inspectPrivateKey(key);
  if (insp.needsPassphrase) {
    d.privateKey = key; st.step = 'pass';
    return void send(chatId, '🔑 Private key diterima (pesan sudah dihapus).\n\nKey ini dilindungi passphrase. Kirim <b>passphrase</b>-nya.', cancelRow);
  }
  if (!insp.ok) return void send(chatId, `⚠️ ${esc(insp.error)} Kirim ulang.`, cancelRow);
  d.privateKey = key; d.passphrase = '';
  await send(chatId, '🔑 Private key diterima &amp; pesan dihapus dari chat.');
  await runWizardTest(chatId, uid);
}

async function wizardDocument(msg, st) {
  const chatId = msg.chat.id, uid = String(msg.from.id);
  const doc = msg.document;
  if (!doc || Number(doc.file_size || 0) > 32 * 1024) return void send(chatId, '⚠️ File key terlalu besar / tidak valid (maks 32 KB).', cancelRow);
  const tmp = path.join(H.TEMP_DIR, `key-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    const info = await BOT.getFile(doc.file_id);
    await H.downloadToFile(`https://api.telegram.org/file/bot${H.getToken()}/${info.file_path}`, tmp, 64 * 1024);
    const text = fs.readFileSync(tmp, 'utf8');
    try { await BOT.deleteMessage(chatId, msg.message_id); } catch (_) {}
    if (!core.looksLikePrivateKey(text)) return void send(chatId, '⚠️ File itu bukan private key.', cancelRow);
    await acceptKey(chatId, uid, st, text);
  } catch (e) { await send(chatId, `❌ Gagal membaca file key: ${esc(safeErr(e))}`, cancelRow); }
  finally { H.safeUnlink(tmp); }
}

async function applyProjectDir(chatId, uid, st, text) {
  const v = core.validateProjectDir(text);
  if (!v.ok) return void send(chatId, `⚠️ ${esc(v.error)}`, cancelRow);
  core.updateProfile(st.data.profileId, { projectDir: v.value });
  clearState(uid);
  await send(chatId, `✅ Project dir diubah ke <code>${esc(v.value)}</code>`, [[btn('🖥️ VPS Manager', 'pa_vps')]]);
}

async function testProfile(q, id, makeActive) {
  const chatId = q.message.chat.id;
  let p;
  try { p = core.getProfile(id); } catch (_) { return send(chatId, '❌ Profil tidak bisa dibuka (kunci enkripsi berubah).'); }
  if (!p) return send(chatId, '❌ Profil tidak ditemukan.');
  const msg = await send(chatId, `🔐 <b>VPS CONNECTION</b>\n\nHost: <code>${esc(p.host)}</code>\nPort: <code>${p.port}</code>\nUser: <code>${esc(p.username)}</code>\n\n⏳ Testing SSH connection...`);
  const res = await core.testConnection(p);
  markTest(id, res.ok);
  if (res.ok && !p.hostFingerprint && res.fingerprint) core.updateProfile(id, { hostFingerprint: res.fingerprint });
  if (res.ok && makeActive) core.setActive(id);
  if (res.ok) {
    return edit(msg, `✅ <b>VPS CONNECTED</b>\n\nHost: <code>${esc(p.host)}</code>\nUser: <code>${esc(p.username)}</code>\nStatus: Online${makeActive ? ' (aktif)' : ''}\nLatency: ${res.latencyMs} ms`,
      [[btn('🖥️ VPS Manager', 'pa_vps'), btn('🔐 VPS Connection', 'pa_conn')]]);
  }
  return edit(msg, `❌ <b>SSH CONNECTION FAILED</b>\n\nHost: <code>${esc(p.host)}</code>\nUser: <code>${esc(p.username)}</code>\n\nPenyebab: ${esc(res.message)}`,
    [...(res.kind === 'hostkey' ? [[btn('🔓 Percayai host key baru', `pa_repin:${id}`)]] : []), [btn('🔄 Test Connection', `pa_test:${id}`), btn('🔐 VPS Connection', 'pa_conn')]]);
}

// ============================================================ SERVER STATUS & HEALTH
const STATUS_SCRIPT = `. /etc/os-release 2>/dev/null; echo "os=\${PRETTY_NAME:-$(uname -sr)}"
echo "host=$(hostname)"
echo "uptime=$(cut -d. -f1 /proc/uptime 2>/dev/null)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
echo "cores=$(nproc 2>/dev/null)"
free -b 2>/dev/null | awk '/^Mem:/{print "mem_total="$2"\\nmem_used="$3}'
df -PB1 / 2>/dev/null | awk 'NR==2{print "disk_total="$2"\\ndisk_used="$3"\\ndisk_pct="$5}'
echo "node=$(node -v 2>/dev/null)"
echo "npm=$(npm -v 2>/dev/null)"
echo "pm2=$(pm2 -v 2>/dev/null | tail -n1)"`;

async function cmdStatus(chatId) {
  await withConn(chatId, async (conn, p) => {
    const r = await R(conn, STATUS_SCRIPT, { timeout: 30000 });
    const k = core.parseKv(r.stdout);
    const lines = [
      `🖥 Host    : ${k.host || p.host}`, `💿 OS      : ${k.os || '-'}`,
      `⏱ Uptime  : ${H.fmtUptime(Number(k.uptime) || 0)}`,
      `⚙️ CPU     : load ${k.load || '-'} (${k.cores || '?'} core)`,
      `🧠 RAM     : ${H.fmtBytes(k.mem_used)} / ${H.fmtBytes(k.mem_total)}`,
      `💾 Disk /  : ${H.fmtBytes(k.disk_used)} / ${H.fmtBytes(k.disk_total)} (${k.disk_pct || '-'})`,
      `🟢 Node    : ${k.node || 'tidak ada'}`, `📦 NPM     : ${k.npm || 'tidak ada'}`, `⚙️ PM2     : ${k.pm2 || 'tidak ada'}`
    ];
    await send(chatId, `📊 <b>SERVER STATUS</b> — ${esc(p.label)}\n\n<pre>${esc(lines.join('\n'))}</pre>`, [[btn('🔄 Refresh', 'pa_status'), btn('🔙 Kembali', 'pa_menu')]]);
  });
}
async function cmdHealth(chatId) {
  await withConn(chatId, async (conn, p) => {
    const h = await collectHealth(conn, p);
    const ev = evaluateHealth(h, p);
    await send(chatId, healthText(`🩺 <b>VPS HEALTH</b> — ${esc(p.label)}`, ev), [...(ev.blockers.length ? [[btn('🧰 Install Base (Node, PM2, unzip)', 'pa_installbase')]] : []), [btn('🔄 Refresh', 'pa_health'), btn('🔙 Kembali', 'pa_menu')]]);
  });
}

// ============================================================ INSTALL BASE (Node, npm, unzip, PM2)
async function installBase(chatId) {
  await withConn(chatId, async (conn, p) => withLock(p.id, chatId, async () => {
    const uidRes = await R(conn, 'id -u', { timeout: 15000 });
    if (uidRes.stdout.trim() !== '0') return void send(chatId, '⚠️ Install Base butuh user <b>root</b> di VPS.', [[btn('🔙 Kembali', 'pa_vps')]]);
    const msg = await send(chatId, '⏳ <b>Install Base</b>: curl, unzip, git, Node.js LTS, PM2 ...');
    const stop = ticker(msg, (s) => `⏳ <b>Install Base</b> berjalan... (${s}s)`);
    let r;
    try {
      r = await R(conn, `export DEBIAN_FRONTEND=noninteractive
command -v apt-get >/dev/null 2>&1 || { echo "Hanya Debian/Ubuntu (apt) yang didukung" >&2; exit 90; }
apt-get update -y
apt-get install -y curl ca-certificates unzip git
if ! command -v node >/dev/null 2>&1; then
  if curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; then apt-get install -y nodejs; else apt-get install -y nodejs npm; fi
fi
command -v pm2 >/dev/null 2>&1 || npm install -g pm2
echo "node=$(node -v 2>/dev/null)"; echo "npm=$(npm -v 2>/dev/null)"; echo "pm2=$(pm2 -v 2>/dev/null | tail -n1)"; echo "unzip=$(command -v unzip)"
`, { timeout: 1200000, maxBytes: 4 * 1024 * 1024 });
    } finally { stop(); }
    const kv = core.parseKv(r.stdout);
    if (r.ok && kv.node && kv.pm2) {
      return void edit(msg, `✅ <b>Install Base selesai</b>\n\nNode: <code>${esc(kv.node)}</code>\nNPM: <code>${esc(kv.npm)}</code>\nPM2: <code>${esc(kv.pm2)}</code>`, [[btn('🩺 Health Check', 'pa_health'), btn('📦 Upload Source', 'pa_upload')]]);
    }
    await edit(msg, `❌ <b>Install Base gagal</b>\n\n<pre>${esc(redact(tailText(r.stdout + '\n' + r.stderr, 1500)))}</pre>`, [[btn('🔙 Kembali', 'pa_vps')]]);
  }));
}

// ============================================================ TERMINAL VPS
const termRows = [
  [btn('⌨️ Input Command', 'pa_term_in'), btn('🕘 History', 'pa_term_hist')],
  [btn('📊 Server Status', 'pa_status'), btn('❌ Tutup', 'pa_term_close')]
];
async function showTerminal(q) {
  if (!(await needProfile(q.message.chat.id))) return;
  await ui(q, `🖥️ <b>VPS TERMINAL</b>\n\n${connLine()}\n\nPilih <b>⌨️ Input Command</b> lalu kirim command seperti di Termius. <code>cd</code> diingat antar-command.\n📤 Kirim file ke chat = upload ke folder aktif • 📥 <code>download file.txt</code> = ambil file dari VPS.\n<i>Tanpa TTY: <code>vim</code>/<code>top</code> tidak didukung.</i>`, termRows);
}
function pushHistory(uid, cmd) {
  if (redact(cmd) !== cmd || /(passw|secret|token|api[_-]?key|private)/i.test(cmd)) return; // jangan simpan yang berpotensi secret
  const list = HISTORY.get(uid) || [];
  const next = [cmd, ...list.filter((c) => c !== cmd)].slice(0, MAX_HISTORY);
  HISTORY.set(uid, next);
}
const curCwd = (p) => CWD.get(p.id) || p.projectDir;

/** Builtin: `download <path>` -> kirim file dari VPS ke chat Telegram (SFTP). */
async function terminalDownload(chatId, conn, p, arg) {
  if (!arg) return void send(chatId, '⚠️ Format: <code>download /path/file</code> (path relatif dihitung dari folder aktif).');
  const r = await R(conn, `cd ${shQuote(curCwd(p))} 2>/dev/null || cd ~; F="$(readlink -f -- ${shQuote(arg)} 2>/dev/null)"; [ -f "$F" ] || { echo "NOFILE"; exit 3; }; echo "path=$F"; echo "size=$(stat -c %s "$F")"`, { timeout: 20000 });
  if (!r.ok) return void send(chatId, `❌ File tidak ditemukan: <code>${esc(arg.slice(0, 200))}</code>`);
  const kv = core.parseKv(r.stdout);
  const size = Number(kv.size) || 0;
  if (size > 45 * 1024 * 1024) return void send(chatId, `⚠️ File ${H.fmtBytes(size)} terlalu besar untuk Telegram (maks 50 MB).`);
  const local = path.join(H.TEMP_DIR, `dl-${crypto.randomBytes(6).toString('hex')}-${path.posix.basename(kv.path).replace(/[^A-Za-z0-9._-]/g, '_')}`);
  try {
    await core.sftpDownload(conn, kv.path, local);
    await BOT.sendDocument(chatId, local, { caption: `📥 ${kv.path} (${H.fmtBytes(size)})` });
  } finally { H.safeUnlink(local); }
}

async function runTerminal(chatId, uid, cmd) {
  cmd = String(cmd || '').trim();
  if (!cmd) return;
  if (cmd.length > 2000) return void send(chatId, '⚠️ Command terlalu panjang (maks 2000 karakter).');
  if (INTERACTIVE_RE.test(cmd)) return void send(chatId, '⚠️ Command interaktif tidak didukung (tidak ada TTY).');
  const dl = cmd.match(/^(?:\/)?(?:download|dl)\s+(.+)$/i);
  if (!dl) pushHistory(uid, cmd);
  await withConn(chatId, async (conn, p) => {
    if (dl) return terminalDownload(chatId, conn, p, dl[1].trim());
    const before = curCwd(p);
    // Folder aktif diingat: setelah command, `pwd` dibaca lewat penanda lalu dipakai command berikutnya.
    const wrapped = `cd ${shQuote(before)} 2>/dev/null || cd ~; ${cmd}\n__rc=$?; printf '\\n${CWD_MARK}%s\\n' "$(pwd)"; exit $__rc`;
    const r = await R(conn, wrapped, { timeout: H.COMMAND_TIMEOUT, maxBytes: 2 * 1024 * 1024 });
    let stdout = r.stdout;
    const mi = stdout.lastIndexOf(`\n${CWD_MARK}`);
    if (mi >= 0) {
      const dir = stdout.slice(mi + 1 + CWD_MARK.length).trim();
      stdout = stdout.slice(0, mi);
      if (dir.startsWith('/')) CWD.set(p.id, dir);
    }
    const after = curCwd(p);
    let body = stdout.replace(/\s+$/, '');
    if (r.stderr.trim()) body += (body ? '\n' : '') + (body ? '--- stderr ---\n' : '') + r.stderr.replace(/\s+$/, '');
    if (r.truncated) body += '\n…(output dibatasi 2 MB)';
    const status = r.timedOut ? '⏱️ TIMEOUT' : (r.ok ? '✅ SUCCESS' : '❌ FAILED');
    await sendOutput(chatId, `🖥️ <b>VPS TERMINAL</b>\n📂 <code>${esc(before)}</code>\n<code>$ ${esc(redact(cmd.length > 200 ? cmd.slice(0, 200) + '…' : cmd))}</code>`, body || '(tidak ada output)', {
      footer: `Exit Code: <b>${r.code}</b>\nStatus: ${status}${after !== before ? `\n📂 Sekarang di: <code>${esc(after)}</code>` : ''}`, filePrefix: 'terminal', limit: 2500
    });
  });
}

/** Kirim file APA PUN dari Telegram ke VPS (SFTP) -> folder aktif terminal / project dir. */
async function uploadRawFile(msg, toCwd) {
  const chatId = msg.chat.id;
  const doc = msg.document;
  const name = path.basename(String(doc.file_name || 'file')).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';
  const size = Number(doc.file_size || 0);
  if (size > H.MAX_ZIP_BYTES) return void send(chatId, `⚠️ File ${H.fmtBytes(size)} melebihi batas ${H.fmtBytes(H.MAX_ZIP_BYTES)}.`);
  if (size > TG_DOWNLOAD_LIMIT && !process.env.TELEGRAM_LOCAL_API) return void send(chatId, '⚠️ Telegram Bot API membatasi download bot sampai 20 MB.');
  await withConn(chatId, async (conn, p) => withLock(p.id, chatId, async () => {
    const dir = toCwd ? curCwd(p) : p.projectDir;
    const local = path.join(H.TEMP_DIR, `raw-${crypto.randomBytes(6).toString('hex')}.tmp`);
    const msg2 = await send(chatId, `⏳ Mengirim <b>${esc(name)}</b> ke VPS → <code>${esc(dir)}</code> ...`);
    try {
      const chk = await R(conn, `mkdir -p ${shQuote(dir)} && [ -w ${shQuote(dir)} ]`, { timeout: 20000 });
      if (!chk.ok) throw new Error(`Folder ${dir} tidak bisa ditulis oleh user SSH.`);
      const info = await BOT.getFile(doc.file_id);
      await H.downloadToFile(`https://api.telegram.org/file/bot${H.getToken()}/${info.file_path}`, local, H.MAX_ZIP_BYTES);
      const dest = `${dir.replace(/\/+$/, '')}/${name}`;
      await core.sftpUpload(conn, local, dest);
      const v = await R(conn, `stat -c %s ${shQuote(dest)}`, { timeout: 20000 });
      await edit(msg2, `✅ <b>File terkirim ke VPS</b>\n📄 <code>${esc(dest)}</code>\nUkuran: ${H.fmtBytes(Number(v.stdout.trim()) || 0)}`, [[btn('⌨️ Terminal VPS', 'pa_term')]]);
    } catch (e) {
      await edit(msg2, `❌ <b>Upload file gagal</b>\n\n<code>${esc(safeErr(e))}</code>`);
    } finally { H.safeUnlink(local); }
  }));
}

// ============================================================ LOGS & ERROR CENTER
async function showLogsCenter(chatId) {
  await withConn(chatId, async (conn, p) => {
    const pm = await pm2List(conn);
    if (!pm.installed) return void send(chatId, '⚠️ <b>PM2 belum tersedia.</b>', noPm2Rows);
    const procs = projectProcs(pm.list, p.projectDir);
    if (!procs.length) {
      return void send(chatId, `📜 <b>LOGS &amp; ERROR</b>\n\nBelum ada proses PM2 untuk <code>${esc(p.projectDir)}</code>.`, [[btn('⚙️ PM2 Manager', 'pa_pm2'), btn('🔙 Kembali', 'pa_menu')]]);
    }
    const restarts = procs.reduce((s, x) => s + x.restarts, 0);
    const bad = procs.find((x) => x.status !== 'online');
    const errTail = (await tailLog(conn, (bad || procs[0]).errLog, 8, 1500)).trim();
    const lastErr = redact(errTail.split('\n').filter(Boolean).pop() || '-').slice(0, 200);
    const statusBlock = `🟢 <b>Process Status</b>\n${procs.map(procLine).join('\n')}\n\n🔄 <b>Restart Count:</b> ${restarts}\n🔴 <b>Last Error:</b> <code>${esc(lastErr)}</code>`;
    const rows = [[btn('📜 Recent Logs', 'pa_logs_recent'), btn('🔴 Recent Errors', 'pa_logs_err')], [btn('📄 Full Logs (TXT)', 'pa_logs_full'), btn('🔄 Restart', 'pa_proj_restart')], [btn('🔙 Kembali', 'pa_menu')]];
    if (!bad) return void send(chatId, `📜 <b>LOGS &amp; ERROR CENTER</b>\n\n${statusBlock}`, rows);
    await send(chatId,
      `🔴 <b>PROJECT ERROR DETECTED</b>\n\nProcess: <b>${esc(bad.name)}</b>\nStatus: ${esc(bad.status)}\nLast Error: <code>${esc(lastErr)}</code>\n` +
      `Last Restart: ${bad.since ? ago(Date.now() - bad.since) : '-'}\n\n${statusBlock}`,
      [[btn('🔄 Restart', 'pa_proj_restart'), btn('📜 Full Logs', 'pa_logs_full')], [btn('📜 Recent Logs', 'pa_logs_recent'), btn('🔴 Recent Errors', 'pa_logs_err')], [btn('🔙 Kembali', 'pa_menu')]]);
  });
}
async function sendLogs(chatId, kind) {
  await withConn(chatId, async (conn, p) => {
    const pm = await pm2List(conn);
    if (!pm.installed) return void send(chatId, '⚠️ <b>PM2 belum tersedia.</b>', noPm2Rows);
    const procs = projectProcs(pm.list, p.projectDir).slice(0, 3);
    if (!procs.length) return void send(chatId, '⚠️ Tidak ada proses PM2 untuk project ini.');
    let out = '';
    for (const x of procs) {
      if (kind === 'full') {
        const o = await tailLog(conn, x.outLog, 400, 400000);
        const e = await tailLog(conn, x.errLog, 400, 400000);
        out += `===== ${x.name} (out) =====\n${o}\n===== ${x.name} (error) =====\n${e}\n`;
      } else {
        const f = kind === 'err' ? x.errLog : x.outLog;
        out += `===== ${x.name} (${kind === 'err' ? 'error' : 'out'}) =====\n${await tailLog(conn, f, 40, 7000)}\n`;
      }
    }
    if (kind === 'full') {
      let file = null;
      try {
        file = H.writeTempText(`full-logs-${Date.now()}.txt`, redact(out).slice(0, 5 * 1024 * 1024));
        await BOT.sendDocument(chatId, file, { caption: `📄 Full logs — ${p.label}` });
      } finally { H.safeUnlink(file); }
      return;
    }
    await sendOutput(chatId, kind === 'err' ? '🔴 <b>RECENT ERRORS</b>' : '📜 <b>RECENT LOGS</b>', out.trim() || '(log kosong)', { filePrefix: `logs-${kind}`, rows: [[btn('🔙 Logs &amp; Error', 'pa_logs')]] });
  });
}

// ============================================================ PM2 MANAGER
const pm2Rows = [
  [btn('📋 Process List', 'pa_pm2_list')],
  [btn('▶️ Start', 'pa_pm2_sel:start'), btn('🔄 Restart', 'pa_pm2_sel:restart')],
  [btn('⛔ Stop', 'pa_pm2_sel:stop'), btn('📜 Logs', 'pa_pm2_sel:logs')],
  [btn('🗑️ Delete Process', 'pa_pm2_sel:delete')],
  [btn('🔙 Kembali', 'pa_menu')]
];
async function showPm2(q) {
  if (!(await needProfile(q.message.chat.id))) return;
  await ui(q, `⚙️ <b>PM2 MANAGER</b>\n\n${connLine()}\n\nProses dideteksi otomatis dari PM2 (tanpa nama hardcode).`, pm2Rows);
}
async function pm2ListCmd(chatId) {
  await withConn(chatId, async (conn, p) => {
    const pm = await pm2List(conn);
    if (!pm.installed) return void send(chatId, '⚠️ <b>PM2 belum tersedia.</b>', noPm2Rows);
    const mine = new Set(projectProcs(pm.list, p.projectDir).map((x) => x.pm_id));
    const text = pm.list.length
      ? pm.list.map((x) => procLine(x) + (mine.has(x.pm_id) ? ' 📁' : '')).join('\n')
      : 'Belum ada proses PM2.';
    await send(chatId, `📋 <b>PM2 PROCESS LIST</b>\n\n${text}\n\n<i>📁 = proses di project dir</i>`, [[btn('🔄 Refresh', 'pa_pm2_list'), btn('🔙 PM2 Manager', 'pa_pm2')]]);
  });
}
async function pm2Select(chatId, uid, action) {
  await withConn(chatId, async (conn, p) => {
    const pm = await pm2List(conn);
    if (!pm.installed) return void send(chatId, '⚠️ <b>PM2 belum tersedia.</b>', noPm2Rows);
    LISTS.set(uid, { kind: 'pm2', items: pm.list.map((x) => ({ pm_id: x.pm_id, name: x.name })), ts: Date.now() });
    const rows = pm.list.map((x, i) => [btn(`${pmIcon(x.status)} ${x.name} [${x.pm_id}]`.slice(0, 60), `pa_pm2_do:${action}:${i}`)]);
    if (action === 'start') rows.unshift([btn('🚀 Start Project (dari project dir)', 'pa_proj_start')]);
    if (!rows.length) return void send(chatId, 'Belum ada proses PM2.', [[btn('🚀 Start Project', 'pa_proj_start')], [btn('🔙 PM2 Manager', 'pa_pm2')]]);
    rows.push([btn('🔙 PM2 Manager', 'pa_pm2')]);
    const title = { start: '▶️ Start', restart: '🔄 Restart', stop: '⛔ Stop', logs: '📜 Logs', delete: '🗑️ Delete' }[action];
    await send(chatId, `${title} — pilih proses:`, rows);
  });
}
function recordFail(pid) {
  const now = Date.now();
  const arr = (FAILS.get(pid) || []).filter((t) => now - t < 10 * 60 * 1000);
  arr.push(now); FAILS.set(pid, arr);
}
const failCount = (pid) => (FAILS.get(pid) || []).filter((t) => Date.now() - t < 10 * 60 * 1000).length;

async function failurePanel(chatId, conn, p, title, info) {
  recordFail(p.id);
  const parts = [info.stderr || ''];
  for (const x of (info.procs || []).slice(0, 2)) parts.push(await tailLog(conn, x.errLog, 25, 2500));
  const blob = redact(parts.join('\n').trim());
  const dg = diagnose(blob);
  const rows = [[]];
  if (dg.npm) rows[0].push(btn('📦 npm install', 'pa_rec_npm'));
  rows[0].push(btn('📜 View Error', 'pa_rec_err'), btn('🔄 Retry Start', 'pa_rec_retry'));
  const n = failCount(p.id);
  await send(chatId,
    `🔴 <b>${esc(title)} FAILED</b>\n\n${info.code !== undefined ? `Exit Code: <b>${info.code}</b>\n` : ''}${info.status ? `Status: ${esc(info.status)}\n` : ''}Possible cause:\n${esc(dg.cause)}\n\n` +
    `<pre>${esc(tailText(blob, 1200) || '(tidak ada output error)')}</pre>` +
    (n >= 3 ? '\n⛔ Sudah gagal 3x dalam 10 menit — auto-retry dinonaktifkan. Perbaiki penyebabnya dulu.' : ''), rows);
}

/** start / restart / stop satu atau beberapa proses PM2 + verifikasi hasil. */
async function pm2Control(chatId, conn, p, action, targets) {
  if (action !== 'stop') {
    const pf = await preflight(conn, p);
    const inProject = targets.some((x) => x.cwd && (x.cwd === p.projectDir || x.cwd.startsWith(p.projectDir + '/')));
    const projectOnly = /^(package\.json|Dependencies|PROJECT_DIR|NPM)/;
    const relevant = pf.blockers.filter((b) => inProject || !projectOnly.test(b));
    if (relevant.length) return void send(chatId, blockedText(action === 'start' ? 'START' : 'RESTART', relevant), [[btn('🩺 Health Check', 'pa_health')]]);
  }
  const before = new Map(targets.map((x) => [x.pm_id, x.restarts]));
  let last = { ok: true, code: 0, stderr: '' };
  for (const x of targets) {
    last = await R(conn, `pm2 ${action} ${Number(x.pm_id)}`, { timeout: 120000 });
    if (!last.ok) break;
  }
  if (action === 'stop') {
    const pm = await pm2List(conn);
    return void send(chatId, `${last.ok ? '⛔ <b>STOP OK</b>' : '❌ <b>STOP GAGAL</b>'}\n\n${pm.list.filter((x) => before.has(x.pm_id)).map(procLine).join('\n') || esc(tailText(last.stderr))}`, [[btn('⚙️ PM2 Manager', 'pa_pm2')]]);
  }
  await sleep(3500);
  const pm = await pm2List(conn);
  const now = pm.list.filter((x) => before.has(x.pm_id));
  const bad = now.filter((x) => x.status !== 'online' || x.restarts - (before.get(x.pm_id) || 0) >= 2);
  if (!last.ok || bad.length || !now.length) {
    return failurePanel(chatId, conn, p, action === 'start' ? 'START' : 'RESTART', {
      code: last.ok ? undefined : last.code, stderr: last.stderr, procs: bad.length ? bad : now,
      status: bad[0] ? (bad[0].status === 'online' ? 'crash loop (restart berulang)' : bad[0].status) : undefined
    });
  }
  await send(chatId, `${action === 'start' ? '🚀 <b>START OK</b>' : '🔄 <b>RESTART OK</b>'}\n\n${now.map(procLine).join('\n')}`, [[btn('📜 Logs & Error', 'pa_logs'), btn('⚙️ PM2 Manager', 'pa_pm2')]]);
}

async function projectStart(chatId, mode) { // mode: 'start' | 'restart'
  await withConn(chatId, async (conn, p) => withLock(p.id, chatId, async () => {
    const pm = await pm2List(conn);
    const procs = pm.installed ? projectProcs(pm.list, p.projectDir) : [];
    if (mode === 'restart') {
      if (!pm.installed) return void send(chatId, '⚠️ <b>PM2 belum tersedia.</b>', noPm2Rows);
      if (!procs.length) return void send(chatId, 'ℹ️ Belum ada proses project. Gunakan <b>Start Project</b>.', [[btn('🚀 Start Project', 'pa_proj_start')]]);
      return pm2Control(chatId, conn, p, 'restart', procs);
    }
    const pf = await preflight(conn, p);
    if (!pf.ok) return void send(chatId, blockedText('START', pf.blockers), [[btn('🩺 Health Check', 'pa_health'), btn('📦 NPM Manager', 'pa_npm')]]);
    const stopped = procs.filter((x) => x.status !== 'online');
    if (procs.length && !stopped.length) return void send(chatId, `ℹ️ Project sudah berjalan:\n\n${procs.map(procLine).join('\n')}`, [[btn('🔄 Restart', 'pa_proj_restart')]]);
    if (stopped.length) return pm2Control(chatId, conn, p, 'start', stopped);

    const kv = pf.kv, pkg = pf.pkg, base = baseOf(p.projectDir);
    let cmd = null;
    if (kv.eco) cmd = `pm2 start ${shQuote(kv.eco)}`;
    else if (pkg && pkg.scripts && pkg.scripts.start) cmd = `pm2 start npm --name ${shQuote(base)} -- start`;
    else if (pkg && pkg.main) cmd = `pm2 start ${shQuote(pkg.main)} --name ${shQuote(base)}`;
    if (!cmd) return void send(chatId, blockedText('START', ['tidak ada ecosystem config, script "start", maupun "main" di package.json']), [[btn('📦 NPM Manager', 'pa_npm')]]);
    const r = await R(conn, cmd, { cwd: p.projectDir, timeout: 120000 });
    await sleep(3500);
    const after = await pm2List(conn);
    const mine = projectProcs(after.list, p.projectDir);
    const bad = mine.filter((x) => x.status !== 'online');
    if (!r.ok || !mine.length || bad.length) {
      return failurePanel(chatId, conn, p, 'START', { code: r.code, stderr: r.stderr || r.stdout, procs: bad.length ? bad : mine, status: bad[0] && bad[0].status });
    }
    await send(chatId, `🚀 <b>START OK</b>\n\n${mine.map(procLine).join('\n')}`, [[btn('📜 Logs & Error', 'pa_logs')]]);
  }));
}

async function pm2Do(chatId, uid, action, idx) {
  const cache = LISTS.get(uid);
  const item = cache && cache.kind === 'pm2' ? cache.items[idx] : null;
  if (!item) return void send(chatId, '⚠️ Daftar proses kedaluwarsa. Buka ulang menu PM2.', [[btn('⚙️ PM2 Manager', 'pa_pm2')]]);
  await withConn(chatId, async (conn, p) => {
    const pm = await pm2List(conn);
    const x = pm.list.find((y) => y.pm_id === item.pm_id && y.name === item.name);
    if (!x) return void send(chatId, '⚠️ Proses sudah berubah/hilang. Buka ulang menu PM2.', [[btn('⚙️ PM2 Manager', 'pa_pm2')]]);
    if (action === 'logs') {
      const o = await tailLog(conn, x.outLog, 40, 5000), e = await tailLog(conn, x.errLog, 20, 3000);
      return sendOutput(chatId, `📜 <b>PM2 LOGS</b> — ${esc(x.name)}`, `--- out ---\n${o}\n--- error ---\n${e}`, { filePrefix: 'pm2-logs' });
    }
    if (action === 'delete') {
      return void send(chatId, `🗑️ <b>Hapus proses PM2?</b>\n\n${procLine(x)}\n\nProses akan dihentikan &amp; dihapus dari PM2 (file project tidak dihapus).`,
        [[btn('✅ Ya, hapus', `pa_pm2_delyes:${idx}`), btn('❌ Batal', 'pa_pm2')]]);
    }
    await withLock(p.id, chatId, () => pm2Control(chatId, conn, p, action, [x]));
  });
}
async function pm2DeleteYes(chatId, uid, idx) {
  const cache = LISTS.get(uid);
  const item = cache && cache.kind === 'pm2' ? cache.items[idx] : null;
  if (!item) return void send(chatId, '⚠️ Daftar proses kedaluwarsa.', [[btn('⚙️ PM2 Manager', 'pa_pm2')]]);
  await withConn(chatId, async (conn, p) => withLock(p.id, chatId, async () => {
    const pm = await pm2List(conn);
    const x = pm.list.find((y) => y.pm_id === item.pm_id && y.name === item.name);
    if (!x) return void send(chatId, '⚠️ Proses sudah tidak ada.');
    const r = await R(conn, `pm2 delete ${Number(x.pm_id)}`, { timeout: 60000 });
    await send(chatId, r.ok ? `🗑️ Proses <b>${esc(x.name)}</b> dihapus dari PM2.` : `❌ Gagal menghapus: <code>${esc(redact(tailText(r.stderr || r.stdout)))}</code>`, [[btn('⚙️ PM2 Manager', 'pa_pm2')]]);
  }));
}
async function installPm2(chatId) {
  await withConn(chatId, async (conn, p) => withLock(p.id, chatId, async () => {
    const msg = await send(chatId, '⏳ Menginstall PM2 (<code>npm install -g pm2</code>)...');
    const stop = ticker(msg, (s) => `⏳ Menginstall PM2... (${s}s)`);
    let r;
    try { r = await R(conn, 'command -v npm >/dev/null 2>&1 || { echo "npm tidak ditemukan" >&2; exit 127; }; npm install -g pm2 2>&1', { timeout: 300000 }); }
    finally { stop(); }
    const v = await R(conn, 'pm2 -v 2>/dev/null | tail -n1', { timeout: 20000 });
    if (r.ok && v.stdout.trim()) return void edit(msg, `✅ <b>PM2 terpasang</b> (v${esc(v.stdout.trim())})`, [[btn('⚙️ PM2 Manager', 'pa_pm2')]]);
    await edit(msg, `❌ <b>Install PM2 gagal</b>\n\n<pre>${esc(redact(tailText(r.stdout + r.stderr, 1500)))}</pre>\n${/EACCES|permission/i.test(r.stdout + r.stderr) ? '💡 User SSH butuh hak akses global npm (root/sudo).' : ''}`, [[btn('🔙 Kembali', 'pa_pm2')]]);
  }));
}

// ============================================================ NPM MANAGER
const npmRows = [
  [btn('📋 Check package.json', 'pa_npm_chk')],
  [btn('📦 npm install', 'pa_npm_i'), btn('🔄 npm update', 'pa_npm_up')],
  [btn('🔍 npm audit', 'pa_npm_aud'), btn('📋 npm outdated', 'pa_npm_out')],
  [btn('🔙 Kembali', 'pa_menu')]
];
async function showNpm(q) {
  if (!(await needProfile(q.message.chat.id))) return;
  await ui(q, `📦 <b>NPM MANAGER</b>\n\n${connLine()}\n\nSemua perintah dijalankan di <b>project dir</b> VPS (bukan di folder lain).`, npmRows);
}
/** Pastikan project dir valid & punya package.json. Return {pkg, snapshot} atau null (sudah melapor). */
async function npmContext(chatId, conn, p) {
  const text = await readRemoteFile(conn, `${p.projectDir}/package.json`);
  if (text === null) { await send(chatId, `❌ <b>package.json tidak ditemukan.</b>\n\n📁 <code>${esc(p.projectDir)}</code>`, [[btn('📦 Upload Source', 'pa_upload')]]); return null; }
  const pkg = parseJson(text);
  if (!pkg) { await send(chatId, '❌ <b>package.json bukan JSON valid.</b>'); return null; }
  const npmOk = (await R(conn, 'command -v npm', { timeout: 15000 })).ok;
  if (!npmOk) { await send(chatId, '❌ <b>npm belum terpasang di VPS.</b>\n\nInstall Node.js/npm di VPS terlebih dulu.'); return null; }
  const snap = parseJson((await readRemoteFile(conn, `${p.projectDir}/node_modules/.cvps-deps.json`)) || 'null');
  return { pkg, snap };
}
async function npmCheck(chatId) {
  await withConn(chatId, async (conn, p) => {
    const c = await npmContext(chatId, conn, p);
    if (!c) return;
    const h = await collectHealth(conn, p);
    const d = c.snap ? diffDeps(c.snap, c.pkg) : null;
    const m = depMap(c.pkg);
    const dev = Object.keys(c.pkg.devDependencies || {}).length;
    const lines = [
      `Nama      : ${c.pkg.name || '-'}@${c.pkg.version || '-'}`,
      `Main      : ${c.pkg.main || '-'}`,
      `Scripts   : ${Object.keys(c.pkg.scripts || {}).join(', ') || '-'}`,
      `Deps      : ${Object.keys(m).length - dev} (+${dev} dev)`,
      `Node (eng): ${(c.pkg.engines && c.pkg.engines.node) || '-'}`,
      `node_mod  : ${h.kv.modules === '1' ? 'ada' : 'BELUM ADA'}`
    ];
    let text = `📋 <b>PACKAGE.JSON</b>\n📁 <code>${esc(p.projectDir)}</code>\n\n<pre>${esc(lines.join('\n'))}</pre>`;
    if (d && d.total) text += `\n${fmtDiff(d)}`;
    else if (!c.snap) text += '\nℹ️ Belum ada baseline dependency (jalankan npm install sekali lewat menu ini).';
    else text += '\n✅ Dependency sama dengan install terakhir.';
    await send(chatId, text, npmRows);
  });
}
async function npmRun(chatId, kind) {
  await withConn(chatId, async (conn, p) => {
    const run = async () => {
      const c = await npmContext(chatId, conn, p);
      if (!c) return;
      const spec = {
        install: { cmd: 'npm install --no-audit --no-fund', title: 'NPM INSTALL', timeout: 900000, snap: true },
        update: { cmd: 'npm update --no-audit --no-fund', title: 'NPM UPDATE', timeout: 900000, snap: true },
        audit: { cmd: 'npm audit', title: 'NPM AUDIT', timeout: 120000, info: true },
        outdated: { cmd: 'npm outdated', title: 'NPM OUTDATED', timeout: 120000, info: true }
      }[kind];
      if (spec.snap) {
        const d = diffDeps(c.snap, c.pkg);
        if (c.snap && d.total) await send(chatId, fmtDiff(d));
        else if (!c.snap) await send(chatId, `ℹ️ Baseline dependency belum ada — menjalankan <b>${esc(spec.title.toLowerCase())}</b> penuh.`);
      }
      const msg = await send(chatId, `⏳ Menjalankan <code>${esc(spec.cmd)}</code>\n📁 <code>${esc(p.projectDir)}</code>`);
      const stop = ticker(msg, (s) => `⏳ <code>${esc(spec.cmd)}</code> berjalan... (${s}s)`);
      let r;
      try { r = await R(conn, spec.cmd, { cwd: p.projectDir, timeout: spec.timeout, maxBytes: 4 * 1024 * 1024 }); }
      finally { stop(); }
      const good = spec.info ? r.code <= 1 : r.ok;
      if (spec.snap && r.ok) {
        const pkgNow = parseJson((await readRemoteFile(conn, `${p.projectDir}/package.json`)) || 'null') || c.pkg;
        await R(conn, 'mkdir -p node_modules && cat > node_modules/.cvps-deps.json', { cwd: p.projectDir, stdin: snapshotJson(pkgNow), timeout: 20000 });
      }
      await edit(msg, `${good ? '✅' : '❌'} <b>${esc(spec.title)}${good ? (spec.info ? ' selesai' : ' berhasil') : ' gagal'}</b>${r.timedOut ? ' (timeout)' : ''}`);
      await sendOutput(chatId, `<code>$ ${esc(spec.cmd)}</code>`, (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim() || '(tidak ada output)', { filePrefix: `npm-${kind}`, rows: [[btn('📦 NPM Manager', 'pa_npm')]] });
    };
    if (kind === 'install' || kind === 'update') return withLock(p.id, chatId, run);
    return run();
  });
}

// ============================================================ BACKUP / RESTORE
const bkRows = [[btn('💾 Backup Aman', 'pa_bk_new'), btn('🔐 Backup Lengkap (+.env)', 'pa_bk_newf')], [btn('📋 Backup List', 'pa_bk_list')], [btn('🔙 Kembali', 'pa_menu')]];
async function showBackup(q) {
  if (!(await needProfile(q.message.chat.id))) return;
  await ui(q, `💾 <b>BACKUP &amp; RESTORE</b>\n\n${connLine()}\n\n💾 <b>Aman</b>: tanpa <code>.env</code>, key, credential, database.\n🔐 <b>Lengkap</b>: SEMUA file termasuk <code>.env</code>, key &amp; database (tanpa <code>node_modules</code>, cache, log) — berisi secret, simpan hati-hati.`, bkRows);
}
async function remoteHome(conn) { return (await R(conn, 'printf %s "$HOME"', { timeout: 15000 })).stdout.trim(); }
const bkDirOf = (home, p) => `${home}/.cvps-backups/${baseOf(p.projectDir).replace(/[^A-Za-z0-9._-]/g, '_')}`;
const excludeArgs = (full) => (full ? BACKUP_EXCLUDES_BASE : [...BACKUP_EXCLUDES_BASE, ...BACKUP_EXCLUDES_SECRET]).map((e) => `--exclude=${shQuote(e)}`).join(' ');

async function createBackup(conn, p, full = false) {
  const home = await remoteHome(conn);
  if (!home.startsWith('/')) throw new Error('HOME di VPS tidak terbaca.');
  const BK = bkDirOf(home, p);
  const script = `set -e
P=${shQuote(p.projectDir)}; BK=${shQuote(BK)}
[ -d "$P" ] || { echo "PROJECT_DIR tidak ada" >&2; exit 90; }
mkdir -p "$BK"; chmod 700 "$HOME/.cvps-backups" "$BK" 2>/dev/null || true
F="$BK/backup-$(date +%Y%m%d-%H%M%S)${full ? '-full' : ''}.tar.gz"
set +e
(umask 077; tar -czf "$F" -C "$(dirname "$P")" ${excludeArgs(full)} "$(basename "$P")")
rc=$?
set -e
if [ "$rc" -gt 1 ]; then rm -f "$F"; echo "tar gagal (kode $rc)" >&2; exit "$rc"; fi
tar -tzf "$F" >/dev/null
echo "file=$F"; echo "size=$(stat -c %s "$F")"
ls -1t "$BK"/backup-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm -f --
`;
  const r = await R(conn, script, { timeout: 600000 });
  if (!r.ok) throw new Error(`Backup gagal: ${redact(tailText(r.stderr || r.stdout, 300))}`);
  const kv = core.parseKv(r.stdout);
  return { file: kv.file, size: Number(kv.size) || 0, dir: BK };
}
async function backupNow(chatId, full = false) {
  await withConn(chatId, async (conn, p) => withLock(p.id, chatId, async () => {
    const msg = await send(chatId, full ? '🔐 Membuat backup LENGKAP (termasuk .env)...' : '💾 Membuat backup project...');
    try {
      const b = await createBackup(conn, p, full);
      await edit(msg, `✅ <b>Backup ${full ? 'LENGKAP' : 'selesai'}</b>\n\n📦 <code>${esc(path.posix.basename(b.file))}</code>\nUkuran: ${H.fmtBytes(b.size)}\n📁 <code>${esc(b.dir)}</code>\n\n<i>Disimpan di VPS (10 backup terbaru, izin 600). ${full ? '⚠️ Berisi .env, key &amp; database.' : 'Tanpa .env/credential.'}</i>`, bkRows);
    } catch (e) { await edit(msg, `❌ <b>Backup gagal</b>\n\n<code>${esc(safeErr(e))}</code>`, bkRows); }
  }));
}
async function listBackups(conn, p) {
  const home = await remoteHome(conn);
  const BK = bkDirOf(home, p);
  const r = await R(conn, `cd ${shQuote(BK)} 2>/dev/null || exit 0; for f in $(ls -1t backup-*.tar.gz 2>/dev/null | head -n 15); do echo "$f|$(stat -c %s "$f")|$(stat -c %Y "$f")"; done`, { timeout: 30000 });
  const items = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, size, mtime] = l.split('|');
    return { name, size: Number(size) || 0, mtime: (Number(mtime) || 0) * 1000 };
  }).filter((x) => BACKUP_NAME_RE.test(x.name));
  return { BK, items };
}
async function showBackupList(chatId, uid) {
  await withConn(chatId, async (conn, p) => {
    const { BK, items } = await listBackups(conn, p);
    LISTS.set(uid, { kind: 'bk', items, BK, ts: Date.now() });
    if (!items.length) return void send(chatId, '📋 <b>BACKUP LIST</b>\n\nBelum ada backup.', bkRows);
    await send(chatId, `📋 <b>BACKUP LIST</b>\n📁 <code>${esc(BK)}</code>\n\nPilih backup:`, [
      ...items.map((x, i) => [btn(`${/-full\.tar/.test(x.name) ? '🔐' : '🗂'} ${new Date(x.mtime).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} • ${H.fmtBytes(x.size)}`.slice(0, 60), `pa_bk_i:${i}`)]),
      [btn('🔙 Kembali', 'pa_backup')]
    ]);
  });
}
function bkItem(uid, idx) {
  const c = LISTS.get(uid);
  return c && c.kind === 'bk' && c.items[idx] ? { it: c.items[idx], BK: c.BK } : null;
}
async function showBackupItem(chatId, uid, idx) {
  const b = bkItem(uid, idx);
  if (!b) return void send(chatId, '⚠️ Daftar kedaluwarsa. Buka Backup List lagi.', bkRows);
  await send(chatId, `${/-full\.tar/.test(b.it.name) ? '🔐 <b>LENGKAP (+.env)</b>\n' : '🗂 '}<b>${esc(b.it.name)}</b>\nUkuran: ${H.fmtBytes(b.it.size)}\nDibuat: ${esc(new Date(b.it.mtime).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }))}`,
    [[btn('📥 Kirim ke Telegram', `pa_bk_get:${idx}`)], [btn('♻️ Restore', `pa_bk_rs:${idx}`), btn('🗑️ Delete', `pa_bk_del:${idx}`)], [btn('🔙 Backup List', 'pa_bk_list')]]);
}
async function sendBackupFile(chatId, uid, idx) {
  const b = bkItem(uid, idx);
  if (!b) return void send(chatId, '⚠️ Daftar kedaluwarsa.', bkRows);
  if (b.it.size > 45 * 1024 * 1024) return void send(chatId, `⚠️ Backup ${H.fmtBytes(b.it.size)} terlalu besar untuk Telegram (maks 50 MB). Ambil via SFTP: <code>${esc(b.BK + '/' + b.it.name)}</code>`);
  await withConn(chatId, async (conn) => {
    const local = path.join(H.TEMP_DIR, `dl-${crypto.randomBytes(6).toString('hex')}-${b.it.name}`);
    try {
      await core.sftpDownload(conn, `${b.BK}/${b.it.name}`, local);
      await BOT.sendDocument(chatId, local, { caption: `💾 ${b.it.name}` });
    } finally { H.safeUnlink(local); }
  });
}
async function restoreBackup(chatId, uid, idx) {
  const b = bkItem(uid, idx);
  if (!b || !BACKUP_NAME_RE.test(b.it.name)) return void send(chatId, '⚠️ Daftar kedaluwarsa.', bkRows);
  await withConn(chatId, async (conn, p) => withLock(p.id, chatId, async () => {
    const prog = makeProgress(chatId, '♻️ RESTORE BACKUP', ['Backup kondisi saat ini', 'Validasi & ekstrak backup', 'Memasang & cek dependency', 'Health check']);
    await prog.start();
    const F = `${b.BK}/${b.it.name}`;
    const T = `/tmp/cvps-rs-${crypto.randomBytes(6).toString('hex')}`;
    try {
      const existsDir = (await R(conn, `[ -d ${shQuote(p.projectDir)} ] && echo yes`, { timeout: 15000 })).stdout.includes('yes');
      if (existsDir) { await prog.set(0, 'run'); await createBackup(conn, p, true); } // pengaman LENGKAP: bisa di-undo termasuk .env
      await prog.set(0, 'ok');
      await prog.set(1, 'run');
      const base = baseOf(p.projectDir);
      const x = await R(conn, `set -e
F=${shQuote(F)}; T=${shQuote(T)}; BASE=${shQuote(base)}
tar -tzf "$F" >/dev/null
if tar -tzf "$F" | grep -Eq '(^/|(^|/)\\.\\.(/|$))'; then echo "path berbahaya di arsip" >&2; exit 91; fi
mkdir -m 700 "$T"; tar -xzf "$F" -C "$T"
[ -d "$T/$BASE" ] || { echo "folder $BASE tidak ada di arsip" >&2; exit 92; }
if [ -n "$(find "$T" -type l -print -quit)" ]; then echo "symlink di arsip" >&2; exit 93; fi
`, { timeout: 600000 });
      if (!x.ok) throw new Error(`Restore gagal: ${redact(tailText(x.stderr, 300))}`);
      await prog.set(1, 'ok');
      const res = await applyTree(conn, p, { src: `${T}/${baseOf(p.projectDir)}`, stg: T, onStage: (s) => prog.set(2, 'run', s === 'install' ? 'npm install...' : '') });
      if (!res.ok) { await prog.set(2, 'fail'); await prog.finish(`❌ <b>Restore dibatalkan</b>\n\n${esc(res.error)}${res.rolledBack ? '\n\n↩️ Kondisi sebelumnya dipulihkan.' : ''}`); return; }
      await prog.set(2, 'ok');
      await prog.set(3, 'run');
      const ev = evaluateHealth(await collectHealth(conn, p), p);
      await prog.set(3, 'ok');
      await prog.finish(`✅ <b>Restore selesai</b> dari <code>${esc(b.it.name)}</code>\n<i>.env &amp; data yang tidak ada di backup tetap dipertahankan. Restart project untuk menerapkan.</i>`,
        [[btn('🔄 Restart Project', 'pa_proj_restart'), btn('🩺 Health', 'pa_health')]], healthText('🩺 <b>HEALTH</b>', ev));
    } catch (e) {
      await prog.finish(`❌ <b>Restore gagal</b>\n\n<code>${esc(safeErr(e))}</code>`);
    } finally { await R(conn, `rm -rf ${shQuote(T)}`, { timeout: 60000 }).catch(() => {}); }
  }));
}
async function deleteBackup(chatId, uid, idx) {
  const b = bkItem(uid, idx);
  if (!b || !BACKUP_NAME_RE.test(b.it.name)) return void send(chatId, '⚠️ Daftar kedaluwarsa.', bkRows);
  await withConn(chatId, async (conn) => {
    const r = await R(conn, `rm -f -- ${shQuote(b.BK + '/' + b.it.name)}`, { timeout: 30000 });
    LISTS.delete(uid);
    await send(chatId, r.ok ? `🗑️ Backup <code>${esc(b.it.name)}</code> dihapus.` : '❌ Gagal menghapus backup.', bkRows);
  });
}

// ============================================================ PROGRESS UI
function makeProgress(chatId, title, labels) {
  const icons = { wait: '⏳', run: '🔄', ok: '✅', fail: '❌', skip: '⏭️' };
  const st = labels.map(() => ({ s: 'wait', note: '' }));
  let msg = null, last = 0, tail = '';
  const text = () => `<b>${title}</b>\n\n` + labels.map((l, i) => `${icons[st[i].s]} ${esc(l)}${st[i].note ? ` <i>${esc(st[i].note)}</i>` : ''}`).join('\n') + tail;
  const render = async (force) => {
    if (!force && Date.now() - last < 1500) return;
    last = Date.now();
    msg = msg ? await edit(msg, text()) : await send(chatId, text());
  };
  return {
    start: () => render(true),
    set: async (i, s, note = '') => { st[i] = { s, note }; await render(s !== 'run'); },
    async finish(finalText, rows, extra) {
      tail = '';
      const body = `${finalText}\n\n${labels.map((l, i) => `${icons[st[i].s]} ${esc(l)}`).join('\n')}${extra ? `\n\n${extra}` : ''}`;
      msg = msg ? await edit(msg, body, rows) : await send(chatId, body, rows);
    }
  };
}

// ============================================================ APPLY TREE (upload & restore)
/**
 * Pasang pohon source baru (`src`, di dalam `stg`) ke PROJECT_DIR:
 *  - bangun P.next = source baru + data lama yang TIDAK ada di source baru (overlay; .env ikut terjaga)
 *  - swap atomik (P -> P.prev, P.next -> P); P.prev disimpan untuk rollback
 *  - dependency sama -> pindahkan node_modules lama; beda -> npm install (gagal => rollback otomatis)
 */
async function applyTree(conn, p, { src, stg, onStage }) {
  const P = p.projectDir;
  const oldText = await readRemoteFile(conn, `${P}/package.json`);
  const oldPkg = oldText ? parseJson(oldText) : null;
  const newText = await readRemoteFile(conn, `${src}/package.json`);
  const newPkg = newText ? parseJson(newText) : null;
  if (newText && !newPkg) return { ok: false, error: 'package.json di sumber bukan JSON valid.' };
  onStage && onStage('check');
  const diff = newPkg ? diffDeps(oldPkg, newPkg) : null;
  const declared = newPkg ? Object.keys(depMap(newPkg)).length : 0;
  if (newPkg && declared > 0) {
    const npmOk = (await R(conn, 'command -v npm', { timeout: 15000 })).ok;
    if (!npmOk) return { ok: false, error: 'npm belum terpasang di VPS (project butuh install dependency). Install Node.js/npm dulu.' };
  }
  const hasOldProject = (await R(conn, `[ -d ${shQuote(P)} ] && echo 1`, { timeout: 15000 })).stdout.includes('1');
  const sw = await R(conn, `set -e
P=${shQuote(P)}; SRC=${shQuote(src)}; STG=${shQuote(stg)}; NEXT=${shQuote(P + '.next')}; PREV=${shQuote(P + '.prev')}
(set -o pipefail) 2>/dev/null && set -o pipefail
mkdir -p "$(dirname "$P")"
rm -rf "$NEXT"
mv "$SRC" "$NEXT"
if [ -d "$P" ]; then
  ( cd "$P" && tar -cf - --exclude=./node_modules --exclude=./.git . ) | ( cd "$NEXT" && tar -xf - --skip-old-files )
  echo "hadold=1"
fi
rm -rf "$PREV"
if [ -d "$P" ]; then mv "$P" "$PREV"; fi
if ! mv "$NEXT" "$P"; then
  if [ -d "$PREV" ]; then mv "$PREV" "$P"; fi
  echo "swap gagal" >&2; exit 92
fi
rm -rf "$STG"
echo "swapped=1"
`, { timeout: 600000 });
  if (!sw.ok) return { ok: false, error: `Gagal memasang project baru: ${redact(tailText(sw.stderr, 300))}` };
  const hadOld = hasOldProject && /hadold=1/.test(sw.stdout);

  const rollback = async () => {
    if (!hadOld) return false;
    const r = await R(conn, `set -e; P=${shQuote(P)}; rm -rf "$P.failed"; mv "$P" "$P.failed"; mv "$P.prev" "$P"; rm -rf "$P.failed"`, { timeout: 300000 });
    return r.ok;
  };

  let carried = false, npmRan = false, npmOut = '';
  if (newPkg) {
    if (hadOld && oldPkg && diff.total === 0) {
      const mv = await R(conn, `if [ -d ${shQuote(P + '.prev/node_modules')} ] && [ ! -e ${shQuote(P + '/node_modules')} ]; then mv ${shQuote(P + '.prev/node_modules')} ${shQuote(P + '/node_modules')} && echo carried=1; fi`, { timeout: 120000 });
      carried = /carried=1/.test(mv.stdout);
    }
    if (!carried && declared > 0) {
      onStage && onStage('install');
      const r = await R(conn, 'npm install --no-audit --no-fund', { cwd: P, timeout: 900000, maxBuffer: 4 * 1024 * 1024 });
      npmRan = true; npmOut = (r.stdout + '\n' + r.stderr).trim();
      if (!r.ok) {
        const rolledBack = await rollback();
        return { ok: false, rolledBack, diff, npmOut, error: `npm install gagal (exit ${r.code})${r.timedOut ? ' — timeout' : ''}: ${redact(tailText(npmOut, 500))}` };
      }
    }
    await R(conn, 'mkdir -p node_modules && cat > node_modules/.cvps-deps.json', { cwd: P, stdin: snapshotJson(newPkg), timeout: 20000 });
  }
  return { ok: true, hadOld, diff, carried, npmRan, npmOut, hasPackage: Boolean(newPkg) };
}

// ============================================================ UPLOAD SOURCE
async function armUpload(q) {
  const chatId = q.message.chat.id, uid = String(q.from.id);
  const p = await needProfile(chatId);
  if (!p) return;
  dropLegacySession(chatId, uid);
  if (H.clearLocalUpload) H.clearLocalUpload(uid);
  setState(uid, 'upload', 'wait', { profileId: p.id }, chatId);
  await send(chatId,
    `📦 <b>SOURCE UPLOAD</b>\n\nsilakan kirim file <b>.zip</b> source.\n\nTarget: <b>${esc(p.label)}</b> — <code>${esc(p.host)}</code>\n📁 <code>${esc(p.projectDir)}</code>\n\n` +
    `<i>ZIP = deploy source (extract ke project dir). File lain = dikirim apa adanya ke project dir. Backup project lama dibuat otomatis. .env &amp; data lama yang tidak ada di ZIP dipertahankan. File dari ZIP tidak dijalankan otomatis (hanya npm install bila dependency berubah).</i>`,
    [[btn('❌ Batal', 'pa_cancel')]]);
}

async function handleUpload(msg, st) {
  const chatId = msg.chat.id, uid = String(msg.from.id);
  const doc = msg.document;
  const name = doc.file_name || 'upload.zip';
  if (!/\.zip$/i.test(name) && !/zip/.test(doc.mime_type || '')) {
    return void send(chatId, '⚠️ File harus berformat <b>.zip</b>. Kirim ulang atau batalkan.', [[btn('❌ Batal', 'pa_cancel')]]);
  }
  const profileId = st.data.profileId;
  clearState(uid); // satu kali pakai: cegah upload ganda tidak sengaja

  let p;
  try { p = core.getProfile(profileId); } catch (_) { p = null; }
  if (!p) return void send(chatId, '❌ VPS belum terhubung.', notConnectedRows);

  await withLock(p.id, chatId, async () => {
    const prog = makeProgress(chatId, '📦 SOURCE UPLOAD', [
      'Downloading...', 'Validating ZIP...', 'Uploading to VPS...', 'Extracting...',
      'Backing up old project...', 'Checking project...', 'Installing dependencies...', 'Health check...'
    ]);
    await prog.start();
    const rnd = crypto.randomBytes(6).toString('hex');
    const localZip = path.join(H.TEMP_DIR, `up-${rnd}.zip`);
    const remoteDir = `/tmp/cvps-up-${rnd}`;
    const stg = `${p.projectDir}.staging-${rnd}`;
    let conn = null;
    try {
      // 1) download
      await prog.set(0, 'run');
      const size = Number(doc.file_size || 0);
      if (size > H.MAX_ZIP_BYTES) throw new Error(`Ukuran ZIP (${H.fmtBytes(size)}) melebihi batas ${H.fmtBytes(H.MAX_ZIP_BYTES)}.`);
      if (size > TG_DOWNLOAD_LIMIT && !process.env.TELEGRAM_LOCAL_API) throw new Error('Telegram Bot API membatasi download bot sampai 20 MB. Kecilkan ZIP (tanpa node_modules) atau pakai Local Bot API server.');
      const info = await BOT.getFile(doc.file_id);
      await H.downloadToFile(`https://api.telegram.org/file/bot${H.getToken()}/${info.file_path}`, localZip, H.MAX_ZIP_BYTES);
      await prog.set(0, 'ok');

      // 2) validasi ZIP (signature + isi: Zip Slip, symlink, batas ukuran/jumlah)
      await prog.set(1, 'run');
      if (!H.looksLikeZip(localZip)) throw new Error('File bukan ZIP yang valid (signature PK tidak ditemukan).');
      const zi = await H.inspectZip(localZip);
      await prog.set(1, 'ok', `${zi.entryCount} entri`);

      // 3) upload via SFTP
      await prog.set(2, 'run');
      conn = await core.openConnection(p);
      markTest(p.id, true);
      const pre = await R(conn, `set -e
mkdir -p ${shQuote(path.posix.dirname(p.projectDir))}
mkdir -m 700 ${shQuote(remoteDir)}
AV=$(df -PB1 ${shQuote(path.posix.dirname(p.projectDir))} | awk 'NR==2{print $4}')
echo "avail=$AV"
if command -v unzip >/dev/null 2>&1; then echo "unzip=1"; fi
if command -v python3 >/dev/null 2>&1; then echo "py=1"; fi
`, { timeout: 30000 });
      if (!pre.ok) throw new Error(`VPS tidak siap menerima upload: ${redact(tailText(pre.stderr, 200))}`);
      const pk = core.parseKv(pre.stdout);
      const need = Math.max(Number(doc.file_size || 0), fs.statSync(localZip).size) * 3 + 50 * 1024 * 1024;
      if (Number(pk.avail) && Number(pk.avail) < need) throw new Error(`Ruang disk VPS tidak cukup (sisa ${H.fmtBytes(pk.avail)}, butuh ±${H.fmtBytes(need)}).`);
      if (!pk.unzip && !pk.py) {
        await prog.set(2, 'run', 'memasang unzip...');
        const ins = await R(conn, '[ "$(id -u)" = 0 ] && command -v apt-get >/dev/null 2>&1 && (export DEBIAN_FRONTEND=noninteractive; apt-get update -y >/dev/null 2>&1; apt-get install -y unzip >/dev/null 2>&1); command -v unzip >/dev/null 2>&1', { timeout: 300000 });
        if (!ins.ok) throw new Error('VPS tidak punya `unzip` maupun `python3`, dan install otomatis gagal (butuh root + apt). Jalankan manual: apt-get install -y unzip');
      }
      let lastPct = -1;
      await core.sftpUpload(conn, localZip, `${remoteDir}/src.zip`, (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; prog.set(2, 'run', `${pct}%`).catch(() => {}); }
      });
      await prog.set(2, 'ok');

      // 4) extract ke staging di VPS (+ cek symlink)
      await prog.set(3, 'run');
      const ex = await R(conn, `set -e
ZIP=${shQuote(remoteDir + '/src.zip')}; STG=${shQuote(stg)}
mkdir -p "$STG"
if command -v unzip >/dev/null 2>&1; then
  unzip -tqq "$ZIP" >/dev/null
  unzip -qq -o "$ZIP" -d "$STG"
else
  python3 - "$ZIP" "$STG" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
z.extractall(sys.argv[2])
PY
fi
if [ -n "$(find "$STG" -type l -print -quit)" ]; then echo "symlink terdeteksi di ZIP" >&2; exit 91; fi
chmod -R go-w "$STG"
find "$STG" -type f -perm /6000 -exec chmod ug-s {} + 2>/dev/null || true
`, { timeout: 600000 });
      if (!ex.ok) throw new Error(`Ekstraksi gagal: ${redact(tailText(ex.stderr || ex.stdout, 300))}`);
      await prog.set(3, 'ok');
      const src = zi.singleRoot ? `${stg}/${zi.singleRoot}` : stg;

      // 5) backup project lama
      await prog.set(4, 'run');
      const hasOld = (await R(conn, `[ -d ${shQuote(p.projectDir)} ] && [ -n "$(ls -A ${shQuote(p.projectDir)} 2>/dev/null)" ] && echo yes`, { timeout: 15000 })).stdout.includes('yes');
      let backup = null;
      if (hasOld) { backup = await createBackup(conn, p); await prog.set(4, 'ok', path.posix.basename(backup.file)); }
      else await prog.set(4, 'skip', 'project belum ada');

      // 6-7) cek project, deteksi dependency, pasang
      await prog.set(5, 'run');
      const res = await applyTree(conn, p, {
        src, stg,
        onStage: (s) => { if (s === 'check') prog.set(5, 'ok').catch(() => {}); if (s === 'install') { prog.set(6, 'run', 'npm install...').catch(() => {}); } }
      });
      if (!res.ok) {
        await prog.set(5, res.diff ? 'ok' : 'fail');
        await prog.set(6, 'fail');
        await prog.finish(`❌ <b>Upload dibatalkan</b>\n\n<code>${esc(res.error)}</code>\n\n${res.rolledBack ? '↩️ Project lama sudah <b>dipulihkan otomatis</b>.' : 'Project lama tidak diubah.'}${backup ? `\n💾 Backup: <code>${esc(path.posix.basename(backup.file))}</code>` : ''}`,
          [[btn('📜 Logs', 'pa_logs'), btn('🖥️ VPS Manager', 'pa_vps')]]);
        return;
      }
      if (res.diff && res.diff.total && res.hadOld) await send(chatId, fmtDiff(res.diff));
      await prog.set(5, 'ok', res.hasPackage ? 'package.json OK' : 'tanpa package.json');
      await prog.set(6, res.npmRan ? 'ok' : 'skip', res.npmRan ? 'selesai' : (res.carried ? 'dependency sama, node_modules dipakai ulang' : 'tidak perlu'));

      // 8) health check
      await prog.set(7, 'run');
      const ev = evaluateHealth(await collectHealth(conn, p), p);
      await prog.set(7, 'ok');
      await prog.finish(
        `✅ <b>Upload berhasil</b>\n📁 <code>${esc(p.projectDir)}</code>\n📄 ${zi.entryCount} entri • ${H.fmtBytes(zi.totalSize)}${backup ? `\n💾 Backup: <code>${esc(path.posix.basename(backup.file))}</code>` : ''}` +
        `${res.hadOld ? `\n↩️ Versi sebelumnya: <code>${esc(path.posix.basename(p.projectDir) + '.prev')}</code> (disimpan untuk rollback)` : ''}\n\n<i>Project belum di-restart otomatis.</i>`,
        [[btn('🚀 Start', 'pa_proj_start'), btn('🔄 Restart', 'pa_proj_restart')], [btn('📦 NPM Manager', 'pa_npm'), btn('🩺 Health', 'pa_health')]],
        healthText('🩺 <b>HEALTH</b>', ev));
    } catch (e) {
      console.error('[personal-assistant] upload gagal:', safeErr(e));
      await prog.finish(`❌ <b>Upload gagal</b>\n\n<code>${esc(safeErr(e))}</code>\n\n<i>Project lama tidak diubah.</i>`, [[btn('🔄 Coba lagi', 'pa_upload'), btn('🔐 VPS Connection', 'pa_conn')]]);
    } finally {
      H.safeUnlink(localZip);
      if (conn) {
        await R(conn, `rm -rf ${shQuote(remoteDir)} ${shQuote(stg)} ${shQuote(p.projectDir + '.next')}`, { timeout: 60000 }).catch(() => {});
        try { conn.end(); } catch (_) {}
      }
    }
  });
}

// ============================================================ CALLBACK ROUTER
async function onCallback(q) {
  const data = String(q.data || '');
  if (!data.startsWith('pa_')) return;
  const uid = String(q.from && q.from.id);
  const answer = (text, alert) => BOT.answerCallbackQuery(q.id, text ? { text, show_alert: Boolean(alert) } : undefined).catch(() => {});

  if (!q.message || !IS_OWNER(uid)) return void (await answer('⛔ Hanya Owner.', true));
  if (q.message.chat.type !== 'private') {
    await answer('🔒 Gunakan di chat pribadi.', true);
    return void (await send(q.message.chat.id, '🔒 Menu <b>Pribadi Asisten</b> hanya bisa dipakai di <b>chat pribadi</b> dengan bot (kredensial &amp; output server tidak boleh tampil di grup).'));
  }
  const chatId = q.message.chat.id;
  const [cmd, a1, a2] = data.split(':');
  await answer();

  switch (cmd) {
    case 'pa_menu': clearState(uid); return showMain(q);
    case 'pa_back': try { await BOT.deleteMessage(chatId, q.message.message_id); } catch (_) {} clearState(uid); return;
    case 'pa_cancel': clearState(uid); return showMain(q);
    case 'pa_vps': return showVps(q);
    case 'pa_conn': clearState(uid); return showConn(q);
    case 'pa_add': return startWizard(q);
    case 'pa_prof': return showProfile(q, a1);
    case 'pa_connect': return void (await testProfile(q, a1, true));
    case 'pa_test': return void (await testProfile(q, a1, false));
    case 'pa_pdir': {
      const prof = core.getPublicProfile(a1);
      if (!prof) return;
      dropLegacySession(chatId, uid);
      setState(uid, 'wiz', 'pdir', { profileId: a1 }, chatId);
      return void (await send(chatId, `📁 Project dir saat ini: <code>${esc(prof.projectDir)}</code>\n\nKirim path <b>absolut</b> baru di VPS (mis. <code>/root/project</code> atau <code>/opt/app</code>).`, cancelRow));
    }
    case 'pa_rm': {
      const prof = core.getPublicProfile(a1);
      if (!prof) return;
      return void (await ui(q, `🗑️ <b>Hapus profil ${esc(prof.label)}?</b>\n\nKredensial terenkripsi akan dihapus dari bot. VPS sendiri tidak terpengaruh.`, [[btn('✅ Ya, hapus', `pa_rmy:${a1}`), btn('❌ Batal', `pa_prof:${a1}`)]]));
    }
    case 'pa_rmy': core.removeProfile(a1); return showConn(q);
    case 'pa_repin': {
      const prof = core.getPublicProfile(a1);
      if (!prof) return;
      return void (await ui(q, `🔓 <b>Percayai host key baru?</b>\n\n<code>${esc(prof.host)}:${prof.port}</code>\n\nHost key berubah. Di <b>Railway</b> ini normal setelah service di-redeploy. Kalau kamu TIDAK baru redeploy/mengganti server, batalkan (bisa MITM).`,
        [[btn('✅ Ya, percayai', `pa_repiny:${a1}`), btn('❌ Batal', `pa_prof:${a1}`)]]));
    }
    case 'pa_repiny': core.updateProfile(a1, { hostFingerprint: null }); return void (await testProfile(q, a1, true));
    case 'pa_auth': {
      const st = getState(uid, 'wiz');
      if (!st || st.step !== 'auth') return void (await send(chatId, '⚠️ Sesi kedaluwarsa. Mulai ulang dari 🔐 VPS Connection.', [[btn('🔐 VPS Connection', 'pa_conn')]]));
      st.ts = Date.now();
      if (a1 === 'key') {
        st.data.authType = 'key'; st.step = 'key';
        return void (await ui(q, `${wizHeader(st.data)}\n\n🔑 <b>SSH Private Key</b>\n\nPaste isi private key (diawali <code>-----BEGIN ... PRIVATE KEY-----</code>) atau kirim file key (.pem).\n🔒 Pesan akan <b>langsung dihapus</b> dan key disimpan terenkripsi.`, cancelRow));
      }
      st.data.authType = 'password'; st.step = 'pw';
      return void (await ui(q, `${wizHeader(st.data)}\n\n🔒 <b>Password SSH</b> (fallback — key lebih aman)\n\nKirim password. Pesan akan <b>langsung dihapus</b> dan password disimpan terenkripsi.`, cancelRow));
    }
    case 'pa_wretry': {
      const st = getState(uid, 'wiz');
      if (!st || st.step !== 'retry') return void (await send(chatId, '⚠️ Sesi kedaluwarsa. Mulai ulang dari 🔐 VPS Connection.', [[btn('🔐 VPS Connection', 'pa_conn')]]));
      return void (await runWizardTest(chatId, uid));
    }

    case 'pa_status': return cmdStatus(chatId);
    case 'pa_health': return cmdHealth(chatId);
    case 'pa_installbase': return installBase(chatId);

    case 'pa_term': return showTerminal(q);
    case 'pa_term_in': {
      if (!(await needProfile(chatId))) return;
      dropLegacySession(chatId, uid);
      setState(uid, 'term', 'input', {}, chatId);
      return void (await send(chatId, '⌨️ <b>INPUT COMMAND</b>\n\nKirim command untuk dijalankan di VPS. Folder aktif diingat (<code>cd</code> nyambung).\n📤 Kirim file ke chat ini = upload ke folder aktif.\n📥 <code>download path/file</code> = ambil file dari VPS.\nMode aktif sampai ❌ Tutup / 15 menit idle.', [[btn('🕘 History', 'pa_term_hist'), btn('❌ Tutup', 'pa_term_close')]]));
    }
    case 'pa_term_hist': {
      const list = HISTORY.get(uid) || [];
      LISTS.set(uid, { kind: 'hist', items: list, ts: Date.now() });
      if (!list.length) return void (await send(chatId, '🕘 History kosong.', [[btn('🔙 Terminal', 'pa_term')]]));
      return void (await send(chatId, '🕘 <b>HISTORY</b> (tanpa secret) — ketuk untuk jalankan ulang:', [...list.map((c, i) => [btn(`$ ${c}`.slice(0, 55), `pa_hrun:${i}`)]), [btn('🔙 Terminal', 'pa_term')]]));
    }
    case 'pa_hrun': {
      const c = LISTS.get(uid);
      const cmdText = c && c.kind === 'hist' ? c.items[Number(a1)] : null;
      if (!cmdText) return void (await send(chatId, '⚠️ History kedaluwarsa.'));
      return runTerminal(chatId, uid, cmdText);
    }
    case 'pa_term_close': clearState(uid); try { await BOT.deleteMessage(chatId, q.message.message_id); } catch (_) {} return void (await send(chatId, '✅ Terminal ditutup.'));

    case 'pa_logs': return showLogsCenter(chatId);
    case 'pa_logs_recent': return sendLogs(chatId, 'out');
    case 'pa_logs_err': return sendLogs(chatId, 'err');
    case 'pa_logs_full': return sendLogs(chatId, 'full');
    case 'pa_proj_restart': return projectStart(chatId, 'restart');
    case 'pa_proj_start': return projectStart(chatId, 'start');

    case 'pa_pm2': return showPm2(q);
    case 'pa_pm2_list': return pm2ListCmd(chatId);
    case 'pa_pm2_install': return installPm2(chatId);
    case 'pa_pm2_sel': if (['start', 'restart', 'stop', 'logs', 'delete'].includes(a1)) return pm2Select(chatId, uid, a1); return;
    case 'pa_pm2_do': if (['start', 'restart', 'stop', 'logs', 'delete'].includes(a1)) return pm2Do(chatId, uid, a1, Number(a2)); return;
    case 'pa_pm2_delyes': return pm2DeleteYes(chatId, uid, Number(a1));

    case 'pa_rec_npm': return npmRun(chatId, 'install');
    case 'pa_rec_err': return sendLogs(chatId, 'err');
    case 'pa_rec_retry': {
      const pid = core.getActiveId();
      if (pid && failCount(pid) >= 3) return void (await send(chatId, '⛔ Sudah gagal 3x dalam 10 menit. Perbaiki penyebab (lihat error) lalu coba lagi nanti — tidak ada restart otomatis tanpa batas.'));
      return projectStart(chatId, 'start');
    }

    case 'pa_npm': return showNpm(q);
    case 'pa_npm_chk': return npmCheck(chatId);
    case 'pa_npm_i': return npmRun(chatId, 'install');
    case 'pa_npm_up': return void (await ui(q, '🔄 <b>npm update</b>\n\nMemperbarui dependency ke versi terbaru yang cocok dengan semver di package.json. Bisa mengubah perilaku project.\n\nLanjutkan?', [[btn('✅ Ya, update', 'pa_npm_upy'), btn('❌ Batal', 'pa_npm')]]));
    case 'pa_npm_upy': return npmRun(chatId, 'update');
    case 'pa_npm_aud': return npmRun(chatId, 'audit');
    case 'pa_npm_out': return npmRun(chatId, 'outdated');

    case 'pa_backup': return showBackup(q);
    case 'pa_bk_new': return backupNow(chatId);
    case 'pa_bk_list': return showBackupList(chatId, uid);
    case 'pa_bk_i': return showBackupItem(chatId, uid, Number(a1));
    case 'pa_bk_get': {
      const b = bkItem(uid, Number(a1));
      if (b && /-full\.tar/.test(b.it.name)) {
        return void (await send(chatId, '⚠️ <b>Backup LENGKAP berisi .env, key &amp; database.</b>\n\nMengirimnya ke Telegram menyimpan secret di cloud Telegram. Lanjutkan?', [[btn('✅ Ya, kirim', `pa_bk_gety:${a1}`), btn('❌ Batal', `pa_bk_i:${a1}`)]]));
      }
      return sendBackupFile(chatId, uid, Number(a1));
    }
    case 'pa_bk_gety': return sendBackupFile(chatId, uid, Number(a1));
    case 'pa_bk_newf': return backupNow(chatId, true);
    case 'pa_bk_rs': {
      const b = bkItem(uid, Number(a1));
      if (!b) return void (await send(chatId, '⚠️ Daftar kedaluwarsa.', bkRows));
      return void (await ui(q, `♻️ <b>RESTORE BACKUP?</b>\n\n<code>${esc(b.it.name)}</code>\n\nKondisi saat ini akan di-backup LENGKAP dulu, lalu source diganti dengan isi backup. ${/-full\.tar/.test(b.it.name) ? '<b>.env</b> dari backup ini AKAN MENIMPA .env saat ini.' : '<b>.env</b> &amp; data yang tidak ada di backup tetap dipertahankan.'}`, [[btn('✅ Ya, Restore', `pa_bk_rsy:${a1}`), btn('❌ Batal', `pa_bk_i:${a1}`)]]));
    }
    case 'pa_bk_rsy': return restoreBackup(chatId, uid, Number(a1));
    case 'pa_bk_del': {
      const b = bkItem(uid, Number(a1));
      if (!b) return void (await send(chatId, '⚠️ Daftar kedaluwarsa.', bkRows));
      return void (await ui(q, `🗑️ <b>Hapus backup?</b>\n\n<code>${esc(b.it.name)}</code>`, [[btn('✅ Ya, hapus', `pa_bk_dely:${a1}`), btn('❌ Batal', `pa_bk_i:${a1}`)]]));
    }
    case 'pa_bk_dely': return deleteBackup(chatId, uid, Number(a1));

    case 'pa_upload': return armUpload(q);
    default: return;
  }
}

// ============================================================ MESSAGE ROUTER
const BOT_CMD_RE = /^\/[A-Za-z0-9_]+(@\w+)?(\s|$)/;
async function onMessage(msg) {
  if (!msg || !msg.from) return;
  const uid = String(msg.from.id);
  const st = getState(uid);
  if (!st) return;
  if (!IS_OWNER(uid) || msg.chat.type !== 'private') return;

  if (msg.document) {
    if (st.type === 'term') { st.ts = Date.now(); return uploadRawFile(msg, true); }
    if (st.type === 'upload' && !/\.zip$/i.test(msg.document.file_name || '') && !/zip/.test(msg.document.mime_type || '')) {
      clearState(uid); return uploadRawFile(msg, false);
    }
    if (st.type === 'upload') return handleUpload(msg, st);
    if (st.type === 'wiz' && st.step === 'key') return wizardDocument(msg, st);
    return;
  }
  const text = msg.text;
  if (typeof text !== 'string' || !text.trim()) return;

  const t = text.trim();
  // Saat menjawab Project Dir, path satu segmen seperti "/opt" bukan command bot.
  const pathAnswer = st.type === 'wiz' && st.step === 'pdir' && !/^\/(start|cancel|menu|help)(@\w+)?$/i.test(t);
  if (BOT_CMD_RE.test(t) && !pathAnswer) { // command bot: batalkan wizard/upload, biarkan handler lain memprosesnya
    if (st.type !== 'term') clearState(uid);
    return;
  }
  if (st.type === 'wiz') return wizardText(msg, st, text.trim());
  if (st.type === 'term') {
    st.ts = Date.now();
    try { await BOT.deleteMessage(msg.chat.id, msg.message_id); } catch (_) {}
    return runTerminal(msg.chat.id, uid, text);
  }
}

// ============================================================ REGISTER
function register(ctx) {
  BOT = ctx.bot; IS_OWNER = ctx.isOwner; SESSIONS = ctx.sessions; SESSION_KEY = ctx.sessionKey; H = ctx.helpers;
  const safe = (fn) => async (...args) => {
    try { await fn(...args); } catch (e) { console.error('[personal-assistant] handler error:', safeErr(e)); }
  };
  BOT.on('callback_query', safe(onCallback));
  BOT.on('message', safe(onMessage));

  const gc = setInterval(() => {
    const now = Date.now();
    for (const [uid, st] of STATE) if (now - st.ts > STATE_TTL_MS) clearState(uid);
    for (const [uid, l] of LISTS) if (now - l.ts > STATE_TTL_MS) LISTS.delete(uid);
  }, 60 * 1000);
  if (gc.unref) gc.unref();

  console.log('[personal-assistant] Pribadi Asisten aktif (SSH remote, profil terenkripsi).');
  return { clearState };
}

module.exports = {
  register,
  _internal: { diffDeps, diagnose, parseJlist, evaluateHealth, probeScript, redact: (t) => (H ? redact(t) : t), BACKUP_EXCLUDES_BASE, BACKUP_EXCLUDES_SECRET }
};
