const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// High-speed enterprise DoH resolvers with zero-latency European edge routing
const UPSTREAMS = (process.env.UPSTREAMS ||
  'https://cloudflare-dns.com/dns-query,https://dns.google/dns-query,https://dns.quad9.net/dns-query'
).split(',').map(u => u.trim()).filter(Boolean);

const RACE = process.env.RACE !== 'false';
const UPSTREAM_TIMEOUT_MS = 1200; // Extremely tight timeout to drop lagging packets instantly

// ---------- Advanced Jitter-Free Memory Cache ----------
const CACHE_MAX = 20000;
const FIXED_GAMING_TTL = 900; // Locked 15-minute TTL to prevent mid-match IP shifting
const cache = new Map();

function cacheKey(query) {
  const copy = Buffer.from(query);
  copy[0] = 0; // Strip transaction ID for deep cache pooling
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

// Overwrite all incoming packet TTLs to enforce a strict, uniform session duration
function overrideTtlAndCache(query, response) {
  try {
    if (response.length < 12) return null;
    const rcode = response[3] & 0x0f;
    if (rcode !== 0 && rcode !== 3) return null;

    const qd = response.readUInt16BE(4);
    const records = response.readUInt16BE(6) + response.readUInt16BE(8);
    let o = 12;
    for (let i = 0; i < qd; i++) o = skipName(response, o) + 4;

    // Force every record's TTL bytes to our locked gaming value
    for (let i = 0; i < records; i++) {
      o = skipName(response, o);
      response.writeUInt32BE(FIXED_GAMING_TTL, o + 4);
      const rdlen = response.readUInt16BE(o + 8);
      o += 10 + rdlen;
    }

    const key = cacheKey(query);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { buf: Buffer.from(response), expires: Date.now() + FIXED_GAMING_TTL * 1000 });
  } catch (e) {
    // Fallback silently if packet structure is complex
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
  out[0] = query[0]; // Restore original transaction ID for the client
  out[1] = query[1];
  return out;
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
    if (!r.ok) throw new Error(`Status ${r.status}`);
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
    for (const url of UPSTREAMS) {
      try {
        buf = await askUpstream(url, query, new AbortController());
        break;
      } catch (err) {}
    }
  }

  if (!buf) throw new Error('All upstreams failed');
  overrideTtlAndCache(query, buf);
  return buf;
}

app.use(express.raw({ type: 'application/dns-message', limit: '1mb' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('Ultra-Stable Gaming DoH Active');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', cachedEntries: cache.size, uptime: process.uptime() });
});

async function handleDoh(req, res) {
  let query = null;

  if (req.method === 'POST' && Buffer.isBuffer(req.body) && req.body.length > 0) {
    query = req.body;
  } else if (req.method === 'GET' && typeof req.query.dns === 'string') {
    query = Buffer.from(req.query.dns, 'base64url');
  }

  if (!query || query.length < 12) {
    return res.status(200).json({ status: 'active', endpoint: req.params.id || 'default' });
  }

  try {
    const answer = await resolve(query);
    res.set({
      'Content-Type': 'application/dns-message',
      'Cache-Control': 'public, max-age=900',
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
  console.log(`High-stability DoH engine online on port ${PORT}`);
});