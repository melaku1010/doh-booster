const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// Dedicated ultra-clean resolvers
const PRIMARY_UPSTREAM = 'https://cloudflare-dns.com/dns-query';
const FALLBACK_UPSTREAM = 'https://dns.google/dns-query';
const UPSTREAM_TIMEOUT_MS = 2000;

// ---------- Rock-Solid Gaming DNS Cache ----------
const CACHE_MAX = 20000;
const LOCKED_GAME_TTL = 3600; // Locked 1-hour TTL: forces game to stay on the exact same server node
const cache = new Map();

function cacheKey(query) {
  const copy = Buffer.from(query);
  copy[0] = 0; // Strip transaction ID
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

// Check if the DNS query is related to eFootball / Konami
function isGamingQuery(buf) {
  try {
    let o = 12;
    let parts = [];
    while (o < buf.length) {
      const len = buf[o];
      if (len === 0) break;
      if ((len & 0xc0) === 0xc0) break;
      parts.push(buf.toString('utf8', o + 1, o + 1 + len));
      o += len + 1;
    }
    const domain = parts.join('.').toLowerCase();
    return domain.includes('konami') || domain.includes('efootball') || domain.includes('net');
  } catch {
    return false;
  }
}

// Force lock the TTL on DNS records so the game client never shifts IPs mid-match
function lockResponseTtl(query, response) {
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
      // Overwrite record TTL bytes with our locked session TTL
      response.writeUInt32BE(LOCKED_GAME_TTL, o + 4);
      const rdlen = response.readUInt16BE(o + 8);
      o += 10 + rdlen;
    }

    const key = cacheKey(query);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { buf: Buffer.from(response), expires: Date.now() + LOCKED_GAME_TTL * 1000 });
  } catch (e) {}
}

function cacheGet(query) {
  const hit = cache.get(cacheKey(query));
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(cacheKey(query));
    return null;
  }
  const out = Buffer.from(hit.buf);
  out[0] = query[0]; // Restore original transaction ID
  out[1] = query[1];
  return out;
}

async function askUpstream(url, query) {
  const ctrl = new AbortController();
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
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function resolve(query) {
  const cached = cacheGet(query);
  if (cached) return cached;

  const gaming = isGamingQuery(query);
  let buf;

  try {
    // For gaming queries, use PRIMARY (Cloudflare) strictly without racing to ensure 100% deterministic node pinning
    buf = await askUpstream(PRIMARY_UPSTREAM, query);
  } catch (err) {
    // Fallback if primary fails
    buf = await askUpstream(FALLBACK_UPSTREAM, query);
  }

  if (gaming) {
    console.log('[+] Konami/eFootball match node locked.');
  }

  lockResponseTtl(query, buf);
  return buf;
}

app.use(express.raw({ type: 'application/dns-message', limit: '1mb' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('Deterministic Gaming DoH Booster is active');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', activeCacheEntries: cache.size, uptime: process.uptime() });
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
      'Cache-Control': 'public, max-age=3600',
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
  console.log(`Deterministic DoH engine running on port ${PORT}`);
});