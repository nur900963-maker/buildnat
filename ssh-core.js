'use strict';
/**
 * ssh-core.js — lapisan SSH/SFTP untuk Pribadi Asisten (VPS remote).
 *
 * - Koneksi SSH langsung via library `ssh2` (Termius BUKAN dependency).
 * - Profil VPS disimpan terenkripsi (AES-256-GCM). Hanya field rahasia
 *   (private key / passphrase / password) yang dienkripsi; sisanya metadata.
 * - Kunci enkripsi TIDAK berada di folder project / ZIP:
 *     1) env VPS_ENC_KEY (disarankan), atau
 *     2) file kunci acak di ~/.cvps-secret/vps.key (mode 0600, di luar project).
 * - Host key di-pin (TOFU, SHA256). Bila berubah -> koneksi DITOLAK.
 * - Tidak pernah mencatat / mengembalikan secret ke pemanggil kecuali lewat
 *   getProfile() (internal, untuk membuka koneksi).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { Client, utils: sshUtils } = require('ssh2');

// ---------------------------------------------------------------- lokasi file
const STORE_FILE = process.env.VPS_PROFILE_FILE || path.join(__dirname, 'vps-profiles.enc.json');
const KEY_FILE = process.env.VPS_KEY_FILE || path.join(os.homedir(), '.cvps-secret', 'vps.key');

// ---------------------------------------------------------------- util shell
function shQuote(value) {
  const s = String(value ?? '');
  if (s.includes('\0')) throw new Error('Argumen mengandung karakter NUL.');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- validasi
const HOST_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,45}$/;
const USER_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,31}$/;
const PROTECTED_DIRS = new Set(['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/var']);

function validateHost(host) {
  // "host.com." (titik akhir = FQDN absolut) valid di DNS -> dinormalkan; kutip/backtick/kurung ikut dibuang.
  const h = String(host || '').trim().replace(/^[`'"\[]+|[`'"\]]+$/g, '').replace(/\.+$/, '');
  if (!h) return { ok: false, error: 'Host kosong.' };
  if (HOST_RE.test(h) || (h.includes(':') && IPV6_RE.test(h))) return { ok: true, value: h };
  return { ok: false, error: 'Host/IP tidak valid.' };
}
function validatePort(port) {
  const raw = String(port ?? '').trim();
  const n = raw === '' ? 22 : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: 'Port harus angka 1-65535.' };
  return { ok: true, value: n };
}
function validateUsername(user) {
  const u = String(user || '').trim();
  if (!USER_RE.test(u)) return { ok: false, error: 'Username tidak valid (huruf/angka/_ . -, maks 32).' };
  return { ok: true, value: u };
}
function validateProjectDir(dir) {
  const raw = String(dir || '').trim();
  if (!raw.startsWith('/')) return { ok: false, error: 'Path harus absolut (diawali /).' };
  if (!/^[A-Za-z0-9._\/-]+$/.test(raw)) return { ok: false, error: 'Path hanya boleh huruf, angka, . _ - /' };
  if (raw.split('/').includes('..')) return { ok: false, error: 'Path tidak boleh memuat "..".' };
  const norm = path.posix.normalize(raw).replace(/\/+$/, '') || '/';
  if (PROTECTED_DIRS.has(norm) || norm.split('/').filter(Boolean).length < 2) {
    return { ok: false, error: `Path terlalu berbahaya (${norm}). Gunakan sub-folder, mis. /root/project atau /opt/app.` };
  }
  return { ok: true, value: norm };
}
function defaultProjectDir(username, fallback) {
  const fb = validateProjectDir(fallback || '');
  if (username === 'root') return fb.ok ? fb.value : '/root/project';
  return `/home/${username}/project`;
}

/**
 * Parse perintah gaya Termius/terminal -> {host, port, username} atau null.
 * Contoh: "ssh root@autorack.proxy.rlwy.net -p 33291", "ssh -p 2222 user@1.2.3.4",
 *         "ssh://root@host:2200", "root@host:2200", "root@host".
 * Perintah dengan karakter shell berbahaya ditolak (tidak pernah dieksekusi, hanya di-parse).
 */
function parseSshCommand(text) {
  let t = String(text || '').trim();
  // Rapikan hasil copy-paste: prompt "$ ", kutip/backtick pembungkus, tanda baca di ujung kalimat.
  t = t.replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, '').replace(/^[$>#]\s+/, '').replace(/[.,;:!]+$/, '').trim();
  if (!t || t.length > 300 || /[;|&$`<>\\\n\r(){}]/.test(t)) return null;
  t = t.replace(/^ssh:\/\//i, 'ssh ');
  const tok = t.split(/\s+/);
  if (/^ssh$/i.test(tok[0])) tok.shift();
  let port = null, target = null;
  for (let i = 0; i < tok.length; i++) {
    const a = tok[i];
    if (a === '-p') { port = String(tok[++i] || '').replace(/[.,;:!]+$/, ''); continue; }
    if (/^-p\d+[.,;:!]*$/.test(a)) { port = a.slice(2).replace(/[.,;:!]+$/, ''); continue; }
    if (/^-[oiJFLRD]$/.test(a)) { i++; continue; }          // opsi ber-argumen: dilewati
    if (a.startsWith('-')) continue;                           // flag lain (-N, -v, ...)
    if (!target) target = a; else return null;                 // argumen ekstra = bukan perintah koneksi
  }
  if (!target || !target.includes('@')) return null;
  const at = target.lastIndexOf('@');
  const username = target.slice(0, at);
  let host = target.slice(at + 1);
  const m = host.match(/^(.*):(\d{1,5})$/);
  if (m && !host.includes('::')) { host = m[1]; if (!port) port = m[2]; }
  const hv = validateHost(host), uv = validateUsername(username), pv = validatePort(port == null ? '22' : port);
  if (!hv.ok || !uv.ok || !pv.ok) return null;
  return { host: hv.value, port: pv.value, username: uv.value };
}

// ---------------------------------------------------------------- enkripsi
let _key = null;
function getKey() {
  if (_key) return _key;
  const envKey = process.env.VPS_ENC_KEY;
  if (envKey && envKey.length >= 16) {
    _key = crypto.scryptSync(envKey, 'cvps-vps-profile-v1', 32);
    return _key;
  }
  try {
    if (fs.existsSync(KEY_FILE)) {
      const raw = fs.readFileSync(KEY_FILE);
      if (raw.length >= 32) { _key = raw.subarray(0, 32); return _key; }
    }
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    const fresh = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, fresh, { mode: 0o600 });
    _key = fresh;
    return _key;
  } catch (e) {
    throw new Error('Tidak bisa menyiapkan kunci enkripsi (set env VPS_ENC_KEY).');
  }
}
function encryptSecret(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decryptSecret(box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

// ---------------------------------------------------------------- store
let store = null; // { version, activeId, profiles: {id: record} }
function loadStore() {
  if (store) return store;
  store = { version: 1, activeId: null, profiles: {} };
  try {
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.profiles) {
        store = { version: 1, activeId: parsed.activeId || null, profiles: parsed.profiles };
      }
    }
  } catch (_) { /* file rusak -> mulai kosong, file lama tidak ditimpa sampai ada perubahan */ }
  return store;
}
function saveStore() {
  const tmp = `${STORE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}
function publicView(rec) {
  if (!rec) return null;
  const { secret, ...rest } = rec; // eslint-disable-line no-unused-vars
  return { ...rest, authType: rec.authType };
}

function listProfiles() { return Object.values(loadStore().profiles).map(publicView); }
function getPublicProfile(id) { return publicView(loadStore().profiles[id]); }
function getActiveId() {
  const s = loadStore();
  return s.activeId && s.profiles[s.activeId] ? s.activeId : null;
}
function setActive(id) {
  const s = loadStore();
  if (id && !s.profiles[id]) throw new Error('Profil tidak ditemukan.');
  s.activeId = id || null;
  saveStore();
}
/** Profil + secret terdekripsi. HANYA untuk membuka koneksi. */
function getProfile(id) {
  const rec = loadStore().profiles[id];
  if (!rec) return null;
  const secret = decryptSecret(rec.secret);
  return { ...publicView(rec), ...secret };
}
function addProfile({ label, host, port, username, authType, privateKey, passphrase, password, projectDir, hostFingerprint }) {
  const s = loadStore();
  const existing = Object.values(s.profiles).find(p => p.host === host && p.port === port && p.username === username);
  const id = existing ? existing.id : crypto.randomBytes(4).toString('hex');
  const secret = authType === 'key' ? { privateKey, passphrase: passphrase || '' } : { password };
  s.profiles[id] = {
    id,
    label: label || `VPS ${Object.keys(s.profiles).length + (existing ? 0 : 1)}`,
    host, port, username, authType,
    projectDir: projectDir || defaultProjectDir(username),
    hostFingerprint: hostFingerprint || null,
    createdAt: existing ? existing.createdAt : Date.now(),
    lastTest: existing ? existing.lastTest : null,
    secret: encryptSecret(secret)
  };
  if (!s.activeId) s.activeId = id;
  saveStore();
  return publicView(s.profiles[id]);
}
function updateProfile(id, patch) {
  const s = loadStore();
  const rec = s.profiles[id];
  if (!rec) return null;
  for (const k of ['label', 'projectDir', 'hostFingerprint', 'lastTest']) {
    if (patch[k] !== undefined) rec[k] = patch[k];
  }
  saveStore();
  return publicView(rec);
}
function removeProfile(id) {
  const s = loadStore();
  if (!s.profiles[id]) return false;
  delete s.profiles[id];
  if (s.activeId === id) s.activeId = null;
  saveStore();
  return true;
}

// ---------------------------------------------------------------- private key
function looksLikePrivateKey(text) {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(String(text || ''));
}
function normalizeKey(text) {
  return String(text).replace(/\r\n?/g, '\n').trim() + '\n';
}
/** -> { ok, needsPassphrase, error } tanpa membocorkan isi key. */
function inspectPrivateKey(keyText, passphrase) {
  const parsed = sshUtils.parseKey(keyText, passphrase || undefined);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first instanceof Error) {
    const m = String(first.message || '');
    if (/passphrase|encrypted/i.test(m) && !passphrase) return { ok: false, needsPassphrase: true, error: 'Private key dilindungi passphrase.' };
    if (/passphrase|decrypt|bad/i.test(m)) return { ok: false, error: 'Passphrase salah atau key tidak bisa dibuka.' };
    return { ok: false, error: 'Format private key tidak dikenali.' };
  }
  if (!first || typeof first.isPrivateKey === 'function' && !first.isPrivateKey()) {
    return { ok: false, error: 'Teks yang dikirim bukan private key (mungkin public key).' };
  }
  return { ok: true, type: first.type };
}

// ---------------------------------------------------------------- error aman
function classifyError(err, extra = {}) {
  const code = String(err && err.code || '');
  const level = String(err && err.level || '');
  const msg = String(err && err.message || err || '');
  let kind = 'unknown';
  let text = 'Koneksi SSH gagal (penyebab tidak dikenali).';
  if (extra.hostKeyMismatch) { kind = 'hostkey'; text = 'host key BERUBAH (kemungkinan server diganti / serangan MITM). Koneksi ditolak.'; }
  else if (code === 'ECONNREFUSED') { kind = 'refused'; text = 'connection refused (port SSH tertutup / service SSH mati).'; }
  else if (code === 'ETIMEDOUT' || level === 'client-timeout' || /timed out|timeout/i.test(msg)) { kind = 'timeout'; text = 'timeout (host tidak merespons / firewall memblokir).'; }
  else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') { kind = 'unreachable'; text = 'host unreachable (tidak ada rute ke host).'; }
  else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') { kind = 'dns'; text = 'host tidak ditemukan (DNS gagal).'; }
  else if (code === 'ECONNRESET' || code === 'EPIPE') { kind = 'reset'; text = 'koneksi diputus oleh server.'; }
  else if (level === 'client-authentication' || /authentication methods failed|authentication failed/i.test(msg)) { kind = 'auth'; text = 'authentication failed (user/key/password salah).'; }
  else if (/permission denied/i.test(msg)) { kind = 'permission'; text = 'permission denied.'; }
  else if (/privatekey|passphrase|parse/i.test(msg)) { kind = 'key'; text = 'private key tidak valid / passphrase salah.'; }
  else if (/handshake|KEX|no matching/i.test(msg)) { kind = 'handshake'; text = 'handshake SSH gagal (algoritma tidak cocok / bukan server SSH).'; }
  const e = new Error(text);
  e.kind = kind;
  e.safeMessage = text;
  return e;
}

// ---------------------------------------------------------------- koneksi
function fingerprintOf(hexHash) {
  return 'SHA256:' + Buffer.from(hexHash, 'hex').toString('base64').replace(/=+$/, '');
}

/**
 * Buka koneksi SSH. `profile` = hasil getProfile() ATAU objek sementara
 * {host,port,username,authType,privateKey,passphrase,password,hostFingerprint}.
 * Resolve: Client dengan properti __fingerprint.
 * Bila profile.id ada & belum punya fingerprint -> di-pin otomatis (TOFU).
 */
function openConnection(profile, opts = {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    let seenFp = null;
    let mismatch = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      reject(classifyError(err, { hostKeyMismatch: mismatch }));
    };
    conn.on('ready', () => {
      if (settled) return;
      settled = true;
      conn.__fingerprint = seenFp;
      if (profile.id && !profile.hostFingerprint && seenFp) {
        try { updateProfile(profile.id, { hostFingerprint: seenFp }); } catch (_) {}
      }
      resolve(conn);
    });
    conn.on('error', fail);
    conn.on('close', () => fail(new Error('koneksi ditutup sebelum siap')));
    conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
      finish(prompts.map(() => profile.authType === 'password' ? String(profile.password || '') : ''));
    });

    const cfg = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: opts.readyTimeout || 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 6,
      hostHash: 'sha256',
      hostVerifier: (hash) => {
        seenFp = fingerprintOf(hash);
        if (profile.hostFingerprint && profile.hostFingerprint !== seenFp) { mismatch = true; return false; }
        return true;
      }
    };
    if (profile.authType === 'key') {
      cfg.privateKey = profile.privateKey;
      if (profile.passphrase) cfg.passphrase = profile.passphrase;
    } else {
      cfg.password = profile.password;
      cfg.tryKeyboard = true;
    }
    try { conn.connect(cfg); } catch (e) { fail(e); }
  });
}

async function testConnection(profile) {
  const started = Date.now();
  let conn;
  try {
    conn = await openConnection(profile);
    const r = await runOnConn(conn, 'echo "user=$(whoami)"; echo "host=$(hostname)"; echo "os=$( . /etc/os-release 2>/dev/null; echo ${PRETTY_NAME:-$(uname -sr)} )"', { timeout: 15000 });
    const info = parseKv(r.stdout);
    return { ok: true, fingerprint: conn.__fingerprint, latencyMs: Date.now() - started, remoteUser: info.user || profile.username, hostname: info.host || '', os: info.os || '' };
  } catch (e) {
    return { ok: false, kind: e.kind || 'unknown', message: e.safeMessage || 'Koneksi SSH gagal.' };
  } finally {
    try { conn && conn.end(); } catch (_) {}
  }
}

function parseKv(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------- exec
// Sesi SSH non-interaktif sering TIDAK memuat PATH node/npm/pm2 (nvm ada di ~/.bashrc setelah
// early-return; prefix npm global kustom tidak ada di PATH). Prelude ini melengkapinya.
const REMOTE_PRELUDE =
  'export PATH="$PATH:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin"; ' +
  '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; ' +
  'command -v pm2 >/dev/null 2>&1 || { B="$(npm prefix -g 2>/dev/null)/bin"; [ -d "$B" ] && export PATH="$PATH:$B"; }; ';

/**
 * Jalankan command di koneksi yang sudah terbuka.
 * - bash -lc (login shell supaya PATH node/pm2/nvm termuat); fallback sh -c.
 * - `timeout -k 5 N` di sisi remote bila tersedia (membunuh seluruh proses).
 * - stdout/stderr dibatasi `maxBytes` (sisanya dibuang, truncated=true).
 */
function runOnConn(conn, command, opts = {}) {
  const timeoutMs = Math.max(1000, Number(opts.timeout) || 60000);
  const maxBytes = Math.max(1024, Number(opts.maxBytes) || 1024 * 1024);
  const secs = Math.ceil(timeoutMs / 1000);
  const body = REMOTE_PRELUDE + (opts.cwd ? `cd ${shQuote(opts.cwd)} || exit 97; ` : '') + command;
  const q = shQuote(body);
  const wrapped =
    `if command -v timeout >/dev/null 2>&1; then TO="timeout -k 5 ${secs}"; else TO=""; fi; ` +
    `if command -v bash >/dev/null 2>&1; then $TO bash -lc ${q}; else $TO sh -c ${q}; fi`;

  return new Promise((resolve) => {
    const decOut = new StringDecoder('utf8');
    const decErr = new StringDecoder('utf8');
    let stdout = '', stderr = '', nOut = 0, nErr = 0, truncated = false, done = false, stream = null;

    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...r, stdout, stderr, truncated });
    };
    const timer = setTimeout(() => {
      try { stream && stream.signal && stream.signal('KILL'); } catch (_) {}
      try { stream && stream.close(); } catch (_) {}
      finish({ ok: false, code: 124, timedOut: true });
    }, timeoutMs + 8000);

    conn.exec(wrapped, (err, s) => {
      if (err) return finish({ ok: false, code: 255, timedOut: false, stderr: 'Gagal membuka channel SSH.' });
      stream = s;
      s.on('data', (d) => {
        if (nOut >= maxBytes) { truncated = true; return; }
        const room = maxBytes - nOut;
        const chunk = d.length > room ? d.subarray(0, room) : d;
        if (d.length > room) truncated = true;
        nOut += chunk.length;
        stdout += decOut.write(chunk);
      });
      s.stderr.on('data', (d) => {
        if (nErr >= maxBytes) { truncated = true; return; }
        const room = maxBytes - nErr;
        const chunk = d.length > room ? d.subarray(0, room) : d;
        if (d.length > room) truncated = true;
        nErr += chunk.length;
        stderr += decErr.write(chunk);
      });
      s.on('close', (code, signal) => {
        const c = (typeof code === 'number') ? code : (signal ? 128 : 1);
        finish({ ok: c === 0, code: c, timedOut: c === 124 });
      });
      s.on('error', () => finish({ ok: false, code: 255, timedOut: false }));
      if (opts.stdin !== undefined) s.end(String(opts.stdin)); else s.end();
    });
  });
}

async function execRemote(profile, command, opts = {}) {
  const own = !opts.conn;
  const conn = opts.conn || await openConnection(profile);
  try { return await runOnConn(conn, command, opts); }
  finally { if (own) { try { conn.end(); } catch (_) {} } }
}

// ---------------------------------------------------------------- SFTP
function withSftp(conn, fn, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => { if (!finished) { finished = true; reject(new Error('SFTP timeout')); } }, timeoutMs);
    conn.sftp((err, sftp) => {
      if (err) { clearTimeout(timer); finished = true; return reject(new Error('SFTP tidak tersedia di server.')); }
      Promise.resolve().then(() => fn(sftp)).then(
        (v) => { clearTimeout(timer); if (!finished) { finished = true; resolve(v); } try { sftp.end(); } catch (_) {} },
        (e) => { clearTimeout(timer); if (!finished) { finished = true; reject(e); } try { sftp.end(); } catch (_) {} }
      );
    });
  });
}
function sftpUpload(conn, localPath, remotePath, onProgress) {
  return withSftp(conn, (sftp) => new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, {
      concurrency: 16, chunkSize: 32768, mode: 0o600,
      step: onProgress ? (done, _chunk, total) => { try { onProgress(done, total); } catch (_) {} } : undefined
    }, (e) => (e ? reject(new Error('Upload SFTP gagal.')) : resolve()));
  }));
}
function sftpDownload(conn, remotePath, localPath) {
  return withSftp(conn, (sftp) => new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, { concurrency: 16, chunkSize: 32768 }, (e) => (e ? reject(new Error('Download SFTP gagal.')) : resolve()));
  }));
}

module.exports = {
  STORE_FILE, KEY_FILE,
  shQuote, parseKv, parseSshCommand,
  validateHost, validatePort, validateUsername, validateProjectDir, defaultProjectDir,
  listProfiles, getPublicProfile, getProfile, getActiveId, setActive,
  addProfile, updateProfile, removeProfile,
  looksLikePrivateKey, normalizeKey, inspectPrivateKey,
  openConnection, testConnection, runOnConn, execRemote, sftpUpload, sftpDownload,
  classifyError,
  _internal: { encryptSecret, decryptSecret, fingerprintOf }
};
