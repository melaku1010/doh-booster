const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// Optimized Upstream Resolvers
const UPSTREAMS = (process.env.UPSTREAMS ||
  'https://cloudflare-dns.com/dns-query,https://dns.google/dns-query'
).split(',').map(u => u.trim()).filter(Boolean);

const RACE = process.env.RACE !== 'false';
const UPSTREAM_TIMEOUT_MS = 2000;

// ---------- In-Memory DNS Cache ----------
const CACHE_MAX = 10000;
const MIN_TTL = 60;
const MAX_TTL = 3600;
const cache = new Map();
const domainStats = new Map();

function cacheKey(query) {
  const copy = Buffer.from(query);
  copy[0] = 0;
  copy[1] = 0;
  return copy.toString('base64');
}

function extractDomain(buf) {
  try {
    let o = 12;
    const labels = [];
    while (o < buf.length) {
      const len = buf[o];
      if (len === 0) break;
      if ((len & 0xc0) === 0xc0) break;
      labels.push(buf.toString('utf8', o + 1, o + 1 + len));
      o += len + 1;
    }
    return labels.join('.').toLowerCase() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function recordDomainHit(query, fromCache) {
  const domain = extractDomain(query);
  const current = domainStats.get(domain) || {
    queries: 0,
    cacheHits: 0,
    lastSeen: null,
  };
  current.queries += 1;
  if (fromCache) current.cacheHits += 1;
  current.lastSeen = new Date().toISOString();
  domainStats.set(domain, current);
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
  if (cached) {
    recordDomainHit(query, true);
    return cached;
  }

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

  recordDomainHit(query, false);
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

app.get('/stats', (req, res) => {
  const topDomains = Array.from(domainStats.entries())
    .sort((a, b) => b[1].queries - a[1].queries)
    .slice(0, 50)
    .map(([domain, info]) => ({ domain, ...info }));

  res.status(200).json({
    cachedEntries: cache.size,
    trackedDomains: domainStats.size,
    uptimeSeconds: Math.floor(process.uptime()),
    topDomains,
  });
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
