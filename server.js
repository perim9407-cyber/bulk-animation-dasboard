const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const KEY = process.env.ROBLOX_API_KEY || '';
const USER_ID = process.env.ROBLOX_USER_ID || '';
const GROUP_ID = process.env.ROBLOX_GROUP_ID || '';
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const MAX_BYTES = 19 * 1024 * 1024;
const MAX_DURATION = 7 * 60;

app.disable('x-powered-by');
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!PASSWORD) return res.status(503).send('Set DASHBOARD_PASSWORD in Railway Variables first.');
  const h = req.headers.authorization || '';
  let decoded = '';
  try { if (h.startsWith('Basic ')) decoded = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch {}
  const i = decoded.indexOf(':');
  if (i < 0 || decoded.slice(0, i) !== 'admin' || decoded.slice(i + 1) !== PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Sakurayama Music Studio"');
    return res.status(401).send('Authentication required');
  }
  next();
});
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!['.mp3', '.ogg', '.wav', '.flac'].includes(ext)) {
      return cb(new Error('Format harus MP3, OGG, WAV, atau FLAC.'));
    }
    cb(null, true);
  }
});
const types = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac' };
const clean = s => String(s || 'Untitled Audio').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().slice(0, 80) || 'Untitled Audio';

function run(command, args, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', finished = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(new Error(`${command} timeout.`)); }, timeoutMs);
    const done = (err, value) => { if (finished) return; finished = true; clearTimeout(timer); err ? reject(err) : resolve(value); };
    child.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 1024 * 1024) { child.kill('SIGKILL'); done(new Error('Output terlalu besar.')); } });
    child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-12000); });
    child.on('error', err => done(new Error(`${command} tidak tersedia: ${err.message}`)));
    child.on('close', code => code === 0 ? done(null, { stdout, stderr }) : done(new Error(`${command} gagal (kode ${code}): ${stderr.slice(-2500)}`)));
  });
}
function validYouTubeUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && ['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com','youtu.be','www.youtu.be'].includes(u.hostname.toLowerCase());
  } catch { return false; }
}
async function getAudioInfo(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size === 0) throw new Error('File audio kosong atau tidak valid.');
  if (stat.size > MAX_BYTES || stat.size >= 20 * 1024 * 1024) throw new Error('Audio maksimal 19 MB pada uploader ini.');
  const { stdout } = await run('ffprobe', ['-v','error','-show_entries','format=duration:stream=codec_type,sample_rate','-of','json',filePath], 30000);
  const info = JSON.parse(stdout);
  const duration = Number(info.format && info.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Durasi audio tidak dapat dibaca.');
  if (duration > MAX_DURATION) throw new Error('Durasi audio maksimal 7 menit.');
  if (!(info.streams || []).some(s => s.codec_type === 'audio')) throw new Error('File tidak memiliki stream audio.');
  const ext = path.extname(filePath).toLowerCase();
  if (!types[ext]) throw new Error('Format audio tidak didukung.');
  return { size: stat.size, duration, ext, mime: types[ext] };
}
async function downloadYouTube(url, dir) {
  if (!validYouTubeUrl(url)) throw new Error('Masukkan URL HTTPS YouTube yang valid.');
  const output = path.join(dir, 'source.%(ext)s');
  await run('yt-dlp', ['--no-playlist','--no-warnings','--extract-audio','--audio-format','mp3','--output',output,'--',url], 240000);
  const names = await fs.promises.readdir(dir);
  const name = names.find(n => n.toLowerCase().endsWith('.mp3'));
  if (!name) throw new Error('yt-dlp tidak menghasilkan file MP3.');
  return path.join(dir, name);
}
async function publishAudio(filePath, displayName) {
  if (!KEY) throw Object.assign(new Error('ROBLOX_API_KEY belum diatur di Railway.'), { status: 503 });
  if ((!USER_ID && !GROUP_ID) || (USER_ID && GROUP_ID)) throw Object.assign(new Error('Atur tepat satu: ROBLOX_USER_ID atau ROBLOX_GROUP_ID.'), { status: 400 });
  const audio = await getAudioInfo(filePath);
  const creator = USER_ID ? { userId: String(USER_ID) } : { groupId: String(GROUP_ID) };
  const metadata = {
    assetType: 'Audio',
    displayName: clean(displayName),
    description: 'Uploaded using Sakurayama Music Studio. Uploader confirms rights to use this audio.',
    creationContext: { creator }
  };
  const form = new FormData();
  form.append('request', JSON.stringify(metadata));
  form.append('fileContent', new Blob([await fs.promises.readFile(filePath)], { type: audio.mime }), `audio${audio.ext}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let upstream;
  try {
    upstream = await fetch('https://apis.roblox.com/assets/v1/assets', {
      method: 'POST', headers: { 'x-api-key': KEY }, body: form, signal: controller.signal
    });
  } finally { clearTimeout(timer); }
  const raw = await upstream.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 1000) }; }
  if (!upstream.ok) {
    const err = new Error('Roblox menolak upload. Periksa API key, izin creator, format, dan batas upload.');
    err.status = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
    err.details = data;
    throw err;
  }
  return {
    success: true,
    message: 'Permintaan upload diterima. Aset masih dapat menjalani moderasi.',
    assetId: data.assetId || data.asset && data.asset.assetId || null,
    operationId: data.path || data.operationId || null,
    audio: { sizeBytes: audio.size, durationSeconds: audio.duration, format: audio.ext.slice(1) },
    robloxResponse: data
  };
}
app.post('/api/upload-audio', (req, res, next) => {
  upload.single('audio')(req, res, err => err ? next(err) : next());
}, async (req, res, next) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sakurayama-audio-'));
  try {
    const youtubeUrl = String(req.body.youtubeUrl || '').trim();
    const hasFile = Boolean(req.file);
    const hasUrl = Boolean(youtubeUrl);
    if (hasFile === hasUrl) return res.status(400).json({ error: 'Pilih satu sumber: file audio atau URL YouTube.' });
    let filePath, name;
    if (hasFile) {
      filePath = path.join(dir, `upload${path.extname(req.file.originalname).toLowerCase()}`);
      await fs.promises.writeFile(filePath, req.file.buffer);
      name = req.file.originalname.replace(/\.[^.]+$/, '');
    } else {
      filePath = await downloadYouTube(youtubeUrl, dir);
      name = 'YouTube Audio';
    }
    const result = await publishAudio(filePath, req.body.displayName || name);
    res.json(result);
  } catch (err) { next(err); }
  finally { await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); }
});
app.use((err, _req, res, _next) => {
  console.error(err.message);
  if (err.details) console.error('Roblox API response:', err.details);
  const status = Number(err.status) || (err instanceof multer.MulterError ? 400 : 400);
  res.status(status).json({
    error: status >= 500 ? 'Proses gagal. Periksa Railway logs untuk detail.' : err.message,
    ...(err.details ? { details: err.details } : {})
  });
});
app.listen(PORT, '0.0.0.0', () => console.log(`Sakurayama Music Studio listening on ${PORT}`));
