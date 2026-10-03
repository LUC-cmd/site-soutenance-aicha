/* =====================================================================
   Serveur du site de soutenance (Railway)
   - sert le site (index.html, assets, docs)
   - API : documents, fichiers, informations de soutenance, connexion
   - données dans PostgreSQL (variable DATABASE_URL fournie par Railway)
   Variables Railway à définir :
     DATABASE_URL    -> référence à la base PostgreSQL du projet
     ADMIN_EMAIL     -> adresse de connexion de l'autrice
     ADMIN_PASSWORD  -> mot de passe de connexion (8 caractères minimum)
   ===================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const MAX_UPLOAD = 50 * 1024 * 1024;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_DAYS = 7;

/* ---------------- base de données ---------------- */
let pool = null;
let dbReady = false;
let SECRET = process.env.SESSION_SECRET || '';

async function initDb() {
  if (!process.env.DATABASE_URL) { console.log('DATABASE_URL absente : espace privé désactivé.'); return; }
  const { Pool } = require('pg');
  const url = process.env.DATABASE_URL;
  const internal = /\.railway\.internal|localhost|127\.0\.0\.1/.test(url);
  pool = new Pool({ connectionString: url, ssl: internal ? false : { rejectUnauthorized: false }, max: 5 });
  try { await pool.query('create extension if not exists pgcrypto'); } catch (e) { /* gen_random_uuid() est natif depuis PostgreSQL 13 */ }
  await pool.query(`
    create table if not exists files (
      id uuid primary key default gen_random_uuid(),
      name text, mime text, size bigint, content bytea not null,
      created_at timestamptz not null default now());
    create table if not exists documents (
      id uuid primary key default gen_random_uuid(),
      title text not null, description text not null default '', category text not null default 'Document',
      file_path text not null, file_name text, mime text, size_bytes bigint,
      visible boolean not null default true, position integer not null default 0,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table if not exists site_settings (id integer primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
    create table if not exists app_kv (key text primary key, value text not null);
  `);
  if (!SECRET) {
    const r = await pool.query(`select value from app_kv where key='session_secret'`);
    if (r.rows.length) SECRET = r.rows[0].value;
    else {
      SECRET = crypto.randomBytes(32).toString('hex');
      await pool.query(`insert into app_kv(key,value) values('session_secret',$1) on conflict (key) do nothing`, [SECRET]);
      const again = await pool.query(`select value from app_kv where key='session_secret'`); SECRET = again.rows[0].value;
    }
  }
  dbReady = true;
  console.log('Base de données prête.');
}
const adminConfigured = () => !!(ADMIN_EMAIL && ADMIN_PASSWORD.length >= 8);

/* ---------------- sessions (jeton signé dans un cookie) ---------------- */
const b64 = (s) => Buffer.from(s).toString('base64url');
function sign(payload) { const body = b64(JSON.stringify(payload)); const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url'); return body + '.' + mac; }
function verify(token) {
  if (!token || !SECRET) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); if (p.exp < Date.now() || p.email !== ADMIN_EMAIL) return null; return p; } catch { return null; }
}
function cookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); }); return o; }
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
function setSession(req, res, value, maxAge) {
  res.setHeader('Set-Cookie', `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`);
}
const currentAdmin = (req) => (adminConfigured() ? verify(cookies(req).sid) : null);
const sameText = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(); const y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

// limite les essais de connexion : 8 par 15 minutes et par adresse IP
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(), win = 15 * 60 * 1000;
  const a = (attempts.get(ip) || []).filter((t) => now - t < win);
  attempts.set(ip, a);
  return a.length >= 8;
}
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

/* ---------------- utilitaires HTTP ---------------- */
function send(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}
const fail = (res, status, error) => send(res, status, { error });
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Fichier trop volumineux (50 Mo maximum).'), { status: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) { const b = await readBody(req, 256 * 1024); try { return JSON.parse(b.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Requête invalide.'), { status: 400 }); } }
function sameOrigin(req) {
  const o = req.headers.origin; if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATS = ['Rapport', 'Présentation', 'Annexe', 'Autre', 'Document'];
const ALLOWED_EXT = /\.(pdf|pptx?|docx?)$/i;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const DOC_COLS = 'id,title,description,category,file_path,file_name,mime,size_bytes,visible,position,created_at,updated_at';

/* ---------------- API ---------------- */
async function api(req, res, p) {
  const m = req.method;
  if (p === '/api/status') return send(res, 200, { db: dbReady, admin: adminConfigured() });
  if (!dbReady) return fail(res, 503, 'L’espace privé n’est pas encore activé (base de données absente).');

  const admin = currentAdmin(req);
  if (m !== 'GET' && m !== 'HEAD') {
    if (!sameOrigin(req) || req.headers['x-requested-with'] !== 'fetch') return fail(res, 403, 'Requête refusée.');
  }

  if (p === '/api/login' && m === 'POST') {
    if (!adminConfigured()) return fail(res, 503, 'Compte administrateur non configuré : ajoutez ADMIN_EMAIL et ADMIN_PASSWORD dans Railway.');
    const ip = clientIp(req);
    if (tooMany(ip)) return fail(res, 429, 'Trop de tentatives. Patientez quelques minutes puis réessayez.');
    const { email, password } = await readJson(req);
    const ok = sameText(String(email || '').trim().toLowerCase(), ADMIN_EMAIL) & sameText(String(password || ''), ADMIN_PASSWORD);
    if (!ok) { attempts.get(ip).push(Date.now()); return fail(res, 401, 'E-mail ou mot de passe incorrect.'); }
    attempts.delete(ip);
    setSession(req, res, sign({ email: ADMIN_EMAIL, exp: Date.now() + SESSION_DAYS * 864e5 }), SESSION_DAYS * 86400);
    return send(res, 200, { email: ADMIN_EMAIL });
  }
  if (p === '/api/logout' && m === 'POST') { setSession(req, res, '', 0); return send(res, 200, { ok: true }); }
  if (p === '/api/me' && m === 'GET') return admin ? send(res, 200, { email: admin.email }) : fail(res, 401, 'Non connectée.');

  if (p === '/api/documents' && m === 'GET') {
    const r = await pool.query(`select ${DOC_COLS} from documents ${admin ? '' : 'where visible'} order by position, created_at`);
    return send(res, 200, r.rows);
  }
  if (p === '/api/settings' && m === 'GET') {
    const r = await pool.query('select data from site_settings where id=1');
    return send(res, 200, r.rows.length ? r.rows[0].data : {});
  }

  // ---- tout ce qui suit est réservé à l'administratrice ----
  if (!admin) return fail(res, 401, 'Action refusée : connectez-vous d’abord.');

  if (p === '/api/settings' && m === 'PUT') {
    const s = await readJson(req);
    const data = { date: clean(s.date, 10), time: clean(s.time, 5), place: clean(s.place, 120), message: clean(s.message, 280) };
    await pool.query(`insert into site_settings(id,data,updated_at) values(1,$1,now()) on conflict (id) do update set data=excluded.data, updated_at=now()`, [data]);
    return send(res, 200, data);
  }
  if (p === '/api/files' && m === 'POST') {
    const name = clean(decodeURIComponent(req.headers['x-file-name'] || 'fichier'), 160);
    if (!ALLOWED_EXT.test(name)) return fail(res, 415, 'Format non accepté : PDF, PowerPoint ou Word uniquement.');
    const buf = await readBody(req, MAX_UPLOAD);
    if (!buf.length) return fail(res, 400, 'Fichier vide.');
    const mime = clean(req.headers['content-type'] || 'application/octet-stream', 120);
    const r = await pool.query('insert into files(name,mime,size,content) values($1,$2,$3,$4) returning id', [name, mime, buf.length, buf]);
    return send(res, 201, { path: 'file:' + r.rows[0].id });
  }
  let mm = p.match(/^\/api\/files\/([^/]+)$/);
  if (mm && m === 'DELETE') {
    if (!UUID.test(mm[1])) return fail(res, 404, 'Introuvable.');
    const used = await pool.query('select 1 from documents where file_path=$1 limit 1', ['file:' + mm[1]]);
    if (!used.rows.length) await pool.query('delete from files where id=$1', [mm[1]]);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/documents' && m === 'POST') {
    const d = await readJson(req);
    const title = clean(d.title, 120); if (!title) return fail(res, 400, 'Le titre est obligatoire.');
    const fp = String(d.file_path || '');
    if (!/^file:[0-9a-f-]{36}$/i.test(fp) && !/^static:docs\/[\w.\-]+$/.test(fp)) return fail(res, 400, 'Fichier invalide.');
    const r = await pool.query(`insert into documents(title,description,category,file_path,file_name,mime,size_bytes,visible,position)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${DOC_COLS}`,
      [title, clean(d.description, 300), CATS.includes(d.category) ? d.category : 'Document', fp, clean(d.file_name, 160), clean(d.mime, 120), Number(d.size_bytes) || null, d.visible !== false, Number.isInteger(d.position) ? d.position : 0]);
    return send(res, 201, r.rows[0]);
  }
  mm = p.match(/^\/api\/documents\/([^/]+)$/);
  if (mm) {
    if (!UUID.test(mm[1])) return fail(res, 404, 'Document introuvable.');
    if (m === 'PATCH') {
      const d = await readJson(req); const sets = [], vals = [];
      const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
      if ('title' in d) { const t = clean(d.title, 120); if (!t) return fail(res, 400, 'Le titre est obligatoire.'); add('title', t); }
      if ('description' in d) add('description', clean(d.description, 300));
      if ('category' in d) add('category', CATS.includes(d.category) ? d.category : 'Document');
      if ('visible' in d) add('visible', !!d.visible);
      if ('position' in d) add('position', parseInt(d.position, 10) || 0);
      if ('file_path' in d) {
        if (!/^file:[0-9a-f-]{36}$/i.test(String(d.file_path))) return fail(res, 400, 'Fichier invalide.');
        add('file_path', d.file_path); add('file_name', clean(d.file_name, 160)); add('mime', clean(d.mime, 120)); add('size_bytes', Number(d.size_bytes) || null);
      }
      if (!sets.length) return send(res, 200, { ok: true });
      vals.push(mm[1]);
      const r = await pool.query(`update documents set ${sets.join(',')}, updated_at=now() where id=$${vals.length} returning id`, vals);
      return r.rows.length ? send(res, 200, { ok: true }) : fail(res, 404, 'Document introuvable.');
    }
    if (m === 'DELETE') {
      const r = await pool.query('delete from documents where id=$1 returning id', [mm[1]]);
      return r.rows.length ? send(res, 200, { ok: true }) : fail(res, 404, 'Document introuvable.');
    }
  }
  return fail(res, 404, 'Introuvable.');
}

/* ---------------- fichiers déposés ---------------- */
async function serveFile(req, res, id) {
  if (!dbReady || !UUID.test(id)) { res.writeHead(404); return res.end('Fichier introuvable'); }
  const head = await pool.query('select name,mime,size from files where id=$1', [id]);
  if (!head.rows.length) { res.writeHead(404); return res.end('Fichier introuvable'); }
  const f = head.rows[0], size = Number(f.size);
  const base = { 'Content-Type': f.mime || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=300',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name || 'document')}`, 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : size - 1;
    if (isNaN(start) || start < 0 || start >= size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    end = Math.min(end, size - 1);
    const r = await pool.query('select substring(content from $2 for $3) as part from files where id=$1', [id, start + 1, end - start + 1]);
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return res.end(req.method === 'HEAD' ? undefined : r.rows[0].part);
  }
  res.writeHead(200, { ...base, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  const r = await pool.query('select content from files where id=$1', [id]);
  res.end(r.rows[0].content);
}

/* ---------------- fichiers du site ---------------- */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const HIDDEN = new Set(['server.js', 'package.json', 'package-lock.json', 'README.md', '_headers', 'railway.json']);
function serveStatic(req, res, p) {
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..') || rel.split(path.sep).some((s) => s.startsWith('.') || s === 'node_modules') || HIDDEN.has(rel)) { res.writeHead(404); return res.end('Introuvable'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Page introuvable'); }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const base = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Accept-Ranges': 'bytes',
      'Cache-Control': rel === 'index.html' || rel === 'config.js' ? 'no-cache' : 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && st.size) {
      let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
      let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
      if (isNaN(start) || start < 0 || start >= st.size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...base, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(async (req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  try {
    if (p.startsWith('/api/')) return await api(req, res, p);
    const fm = p.match(/^\/files\/([^/]+)/);
    if (fm) return await serveFile(req, res, fm[1]);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, p);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : 'Erreur du serveur. Réessayez dans un instant.');
    else res.end();
  }
}).listen(PORT, () => console.log('Site en ligne sur le port ' + PORT));

initDb().catch((e) => console.error('Base de données indisponible :', e.message));
