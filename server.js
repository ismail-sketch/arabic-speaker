/**
 * Локальный прокси для тренажёра арабского языка (AnyModel → OpenAI-совместимый API).
 *
 * Держит API-ключ у себя (в .env, не в браузере) и обходит CORS,
 * чтобы страница index.html могла обращаться к модели.
 *
 * Запуск:
 *   1) скопируйте .env.example в .env и вставьте ключ AnyModel
 *   2) node server.js
 *   3) откройте http://localhost:8787/
 */

const http = require('http');
const https = require('https');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

// На Windows Node/undici иногда падает с "fetch failed" из-за IPv6-резолва
// или разорванных keep-alive соединений. Форсируем IPv4.
dns.setDefaultResultOrder('ipv4first');

/* ---------- загрузка .env без внешних зависимостей ---------- */
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv();

const ANYMODEL_BASE = process.env.ANYMODEL_BASE || 'https://anymodel.org/v1';
const ANYMODEL_KEY = process.env.ANYMODEL_KEY || '';
// Модель для диалога. Чем быстрее — тем живее разговор:
//   gc/gemini-2.5-flash  ~1 c   (по умолчанию)
//   ag/gemini-2.5-flash  ~2 c
//   glm/glm-5.3-flash    ~2.7 c
//   ds/deepseek-v4-flash ~6-9 c (reasoning, медленно для диалога)
const MODEL = process.env.MODEL || 'gc/gemini-2.5-flash';

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Файлы, которые нельзя отдавать в браузер.
const BLOCKED = new Set(['server.js', 'package.json', 'package-lock.json', 'README.md']);

/* ---------- статика ---------- */
function serveStatic(req, res) {
  let file = req.url.split('?')[0];
  if (!file || file === '/') file = '/index.html';

  const base = path.basename(file);
  if (base.startsWith('.') || BLOCKED.has(base)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  const full = path.join(ROOT, decodeURIComponent(file));
  if (!full.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  const ext = path.extname(full);
  if (!MIME[ext]) { res.writeHead(404).end('Not found'); return; }

  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(data);
  });
}

/* ---------- надёжный HTTPS-клиент с повторами ---------- */
function httpsFetch(url, options, retries = 2) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const req = https.request(url, {
        ...options,
        agent: new https.Agent({ keepAlive: false }),
        timeout: 30000,
      }, (res) => {
        res.setEncoding('utf8');           // строки, а не Buffer: иначе русские/арабские
        let data = '';                     // буквы рвутся на границе чанков и превращаются в «?»
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, text: data }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => {
        if (left > 0) setTimeout(() => attempt(left - 1), 400);
        else reject(e);
      });
      if (options.body) req.write(options.body);
      req.end();
    };
    attempt(retries);
  });
}

/* ---------- прокси к AnyModel ---------- */
function handleChat(req, res) {
  let body = '';
  req.setEncoding('utf8');             // тело тоже декодируем как UTF-8 целиком,
  req.on('data', c => body += c);      // иначе кириллица/арабица может испортиться
  req.on('end', async () => {
    if (!ANYMODEL_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Не задан ANYMODEL_KEY. Создайте файл .env (см. .env.example) и перезапустите сервер.' }));
      return;
    }

    let payload;
    try { payload = JSON.parse(body); }
    catch { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Bad JSON' })); return; }

    // принудительно фиксируем модель на сервере
    payload.model = MODEL;
    const payloadStr = JSON.stringify(payload);

    try {
      const upstream = await httpsFetch(`${ANYMODEL_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payloadStr),
          'Authorization': `Bearer ${ANYMODEL_KEY}`,
        },
        body: payloadStr,
      });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(upstream.text);
    } catch (e) {
      console.error('[upstream error]', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Не удалось связаться с AnyModel: ' + e.message + '. Попробуйте ещё раз.' }));
    }
  });
}

/* ---------- распознавание речи через AnyModel (любой браузер) ---------- */
const MODEL_TRANSCRIBE = process.env.MODEL_TRANSCRIBE || 'gc/gemini-2.5-flash';
const MAX_AUDIO_B64 = 12 * 1024 * 1024;

const AUDIO_FORMATS = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/ogg': 'ogg', 'audio/webm': 'webm',
  'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac',
};

function handleTranscribe(req, res) {
  let body = '';
  let size = 0;
  let tooBig = false;
  req.setEncoding('utf8');
  req.on('data', c => {
    size += Buffer.byteLength(c);
    if (size > MAX_AUDIO_B64) { tooBig = true; body = ''; return; }
    if (!tooBig) body += c;
  });
  req.on('end', async () => {
    if (!ANYMODEL_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Не задан ANYMODEL_KEY.' }));
      return;
    }
    if (tooBig) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Аудио слишком длинное. Говорите короче (до минуты).' }));
      return;
    }

    let payload;
    try { payload = JSON.parse(body); }
    catch { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Bad JSON' })); return; }

    const audio = String(payload.audio || '');
    if (!audio) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Нет аудио.' }));
      return;
    }

    const format = AUDIO_FORMATS[String(payload.mime || 'audio/wav').toLowerCase()] || 'wav';
    const langHint = payload.lang === 'ru'
      ? 'Скорее всего говорят по-русски, но могут вставлять арабские слова.'
      : 'Скорее всего говорят по-арабски (фусха), но могут вставлять русские слова.';

    const instruction = `Ты — точный распознаватель речи. Расшифруй аудио дословно на том языке, на котором говорят. ${langHint} Смешанную речь сохраняй как есть, ничего не переводи и не исправляй. Верни ТОЛЬКО распознанный текст, без кавычек, пояснений и markdown. Если речи нет или она неразборчива — верни ровно [EMPTY].`;

    const upstreamBody = JSON.stringify({
      model: MODEL_TRANSCRIBE,
      temperature: 0,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          { type: 'input_audio', input_audio: { data: audio, format } },
        ],
      }],
    });

    try {
      const upstream = await httpsFetch(`${ANYMODEL_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(upstreamBody),
          'Authorization': `Bearer ${ANYMODEL_KEY}`,
        },
        body: upstreamBody,
      }, 0);   // без ретраев: аудио большое, повтор не нужен

      if (upstream.status < 200 || upstream.status >= 300) {
        console.error('[transcribe error]', upstream.status, upstream.text.slice(0, 300));
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Модель не смогла распознать аудио (' + upstream.status + ').' }));
        return;
      }

      const data = JSON.parse(upstream.text);
      let text = String(data.choices?.[0]?.message?.content || '').trim();
      text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim();
      text = text.replace(/^["'«]+|["'»]+$/g, '').trim();
      if (/^\[?empty\]?$/i.test(text)) text = '';

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ text }));
    } catch (e) {
      console.error('[transcribe error]', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Не удалось распознать речь: ' + e.message }));
    }
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (req.method === 'POST' && pathname === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && pathname === '/api/transcribe') return handleTranscribe(req, res);
  if (req.method === 'GET' && pathname === '/api/stt') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: !!ANYMODEL_KEY, model: MODEL_TRANSCRIBE }));
    return;
  }
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405).end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`\n  Тренажёр арабского запущен:  http://localhost:${PORT}/`);
  console.log(`  Модель диалога: ${MODEL} (через AnyModel)`);
  console.log(`  Распознавание речи: ${MODEL_TRANSCRIBE} (через AnyModel)`);
  if (!ANYMODEL_KEY) console.log('  ВНИМАНИЕ: ANYMODEL_KEY не задан — создайте .env (см. .env.example).');
  console.log('');
});
