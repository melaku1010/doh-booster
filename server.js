const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// Optimized Upstream Resolvers (Using primary high-performance low-latency nodes)
const UPSTREAMS = (process.env.UPSTREAMS ||
  'https://cloudflare-dns.com/dns-query,https://dns.google/dns-query'
).split(',').map(u => u.trim()).filter(Boolean);

const RACE = process.env.RACE !== 'false';
const UPSTREAM_TIMEOUT_MS = 2000; // Reduced timeout for faster failover/response

// ---------- Expanded In-Memory DNS Cache for Zero-Lag Gaming ----------
const CACHE_MAX = 10000; // Expanded cache size to remember game server IPs longer
const MIN_TTL = 60;      // Minimum cache time increased to 60s to prevent constant re-querying
const MAX_TTL = 3600;  // Max cache time up to 1 hour for stable session mapping
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

function responseTtl(buf) {
  try {
    if (buf.length < 12) return 0;
    const rcode = buf[3] & 0x0f;
    if (rcode !== 0 && rcode !== 3) return 0;
    const qd = buf.readUInt16BE(4);
    const records = buf.readUInt16BE(6) + buf.readUInt16BE(8);
    let o = 12;
    for (let i = 0; i < qd; i++) o = skipName(buf, o) + 4;
    let min = Infinity;
    for (let i = 0; i < records; i++) {
      o = skipName(buf, o);
      const ttl = buf.readUInt32BE(o + 4);
      const rdlen = buf.readUInt16BE(o + 8);
      min = Math.min(min, ttl);
      o += 10 + rdlen;
    }
    if (min === Infinity) min = 60;
    return Math.max(MIN_TTL, Math.min(MAX_TTL, min));
  } catch {
    return 0;
  }
}

function cacheGet(query) {
  const hit = cache.get(cacheKey(query));
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(cacheKey(query));
    return null;
  }
  const out = Buffer.from(hit.buf);
  out[0] = query[0]; 
  out[1] = query[1];
  return out;
}

function cacheSet(query, response) {
  const ttl = responseTtl(response);
  if (!ttl) return;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(cacheKey(query), { buf: Buffer.from(response), expires: Date.now() + ttl * 1000 });
}

async function askUpstream(url, query, ctrl) {
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/dns-message',
        'Content-Type': 'application/dns-message',
      },
      body: query,
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Upstream ${url} returned ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function resolve(query) {
  const cached = cacheGet(query);
  if (cached) return cached;

  let buf;
  if (RACE) {
    const ctrls = UPSTREAMS.map(() => new AbortController());
    try {
      buf = await Promise.any(UPSTREAMS.map((u, i) => askUpstream(u, query, ctrls[i])));
    } finally {
      ctrls.forEach(c => c.abort());
    }
  } else {
    let lastErr;
    for (const url of UPSTREAMS) {
      try {
        buf = await askUpstream(url, query, new AbortController());
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!buf) throw lastErr;
  }
  cacheSet(query, buf);
  return buf;
}

app.use(express.raw({ type: 'application/dns-message', limit: '1mb' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('Stable eFootball DoH Booster is active!');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', cached: cache.size, uptime: process.uptime() });
});

async function handleDoh(req, res) {
  let query = null;

  if (req.method === 'POST' && Buffer.isBuffer(req.body) && req.body.length > 0) {
    query = req.body; 
  } else if (req.method === 'GET' && typeof req.query.dns === 'string') {
    query = Buffer.from(req.query.dns, 'base64url'); 
  }

  if (!query || query.length < 12) {
    return res.status(200).json({
      status: 'active',
      booster: req.params.id || null,
      message: 'Stable routing endpoint is live.',
    });
  }

  try {
    const answer = await resolve(query);
    res.set({
      'Content-Type': 'application/dns-message',
      'Cache-Control': 'max-age=60',
      'Access-Control-Allow-Origin': '*',
    });
    return res.status(200).send(answer);
  } catch (err) {
    console.error('[-] Upstream failed:', err.message);
    return res.status(502).send('Bad Gateway');
  }
}

app.all('/b/:id', (req, res) => {
  handleDoh(req, res);
});
app.all('/dns-query', handleDoh);

app.listen(PORT, () => {
  console.log(`Stable server listening on port ${PORT}`);
});
