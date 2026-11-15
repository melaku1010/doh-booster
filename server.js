const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;
const PRIMARY_UPSTREAM = 'https://cloudflare-dns.com/dns-query';
const UPSTREAM_TIMEOUT_MS = 2000;

const CACHE_MAX = 20000;
const LOCKED_TTL = 7200; // 2 hours locked session
const cache = new Map();

function cacheKey(query) {
  const copy = Buffer.from(query);
  copy[0] = 0;
  copy[1] = 0;
  return copy.toString('base64');
}

function skipName(buf, o) {
  while (o < buf.length) {
    const len = buf[o];
    if (len === 0) return o + 1;
    if ((len & 0xc0) === 0xc0) return o + 2;
    o += len + 1;
  }
  return o;
}

// Force overwrite TTLs to maximum stability
function lockTtl(response) {
  try {
    if (response.length < 12) return;
    const rcode = response[3] & 0x0f;
    if (rcode !== 0 && rcode !== 3) return;

    const qd = response.readUInt16BE(4);
    const records = response.readUInt16BE(6) + response.readUInt16BE(8);
    let o = 12;
    for (let i = 0; i < qd; i++) o = skipName(response, o) + 4;

    for (let i = 0; i < records; i++) {
      o = skipName(response, o);
      response.writeUInt32BE(LOCKED_TTL, o + 4);
      const rdlen = response.readUInt16BE(o + 8);
      o += 10 + rdlen;
    }
  } catch (e) {}
}

async function resolve(query) {
  const key = cacheKey(query);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    const out = Buffer.from(cached.buf);
    out[0] = query[0];
    out[1] = query[1];
    return out;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  
  try {
    const r = await fetch(PRIMARY_UPSTREAM, {
      method: 'POST',
      headers: {
        Accept: 'application/dns-message',
        'Content-Type': 'application/dns-message',
      },
      body: query,
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());

    lockTtl(buf);

    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { buf: Buffer.from(buf), expires: Date.now() + LOCKED_TTL * 1000 });

    buf[0] = query[0];
    buf[1] = query[1];
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

app.use(express.raw({ type: 'application/dns-message', limit: '1mb' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('Locked Node DoH Active');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', cacheSize: cache.size, uptime: process.uptime() });
});

async function handleDoh(req, res) {
  let query = null;

  if (req.method === 'POST' && Buffer.isBuffer(req.body) && req.body.length > 0) {
    query = req.body;
  } else if (req.method === 'GET' && typeof req.query.dns === 'string') {
    query = Buffer.from(req.query.dns, 'base64url');
  }

  if (!query || query.length < 12) {
    return res.status(200).json({ status: 'active' });
  }

  try {
    const answer = await resolve(query);
    res.set({
      'Content-Type': 'application/dns-message',
      'Cache-Control': 'public, max-age=7200',
      'Access-Control-Allow-Origin': '*',
    });
    return res.status(200).send(answer);
  } catch (err) {
    return res.status(502).send('Bad Gateway');
  }
}

app.all('/b/:id', handleDoh);
app.all('/dns-query', handleDoh);

app.listen(PORT, () => {
  console.log(`Locked DoH running on port ${PORT}`);
});
