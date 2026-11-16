const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;
const UPSTREAM = 'https://cloudflare-dns.com/dns-query';
const TIMEOUT_MS = 2000;

// Massive local cache to lock session routes for hours
const cache = new Map();
const TTL_LOCK = 14400; // 4 hours hard lock to prevent any mid-match re-resolution

function parseQueryDomain(buf) {
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
    return parts.join('.').toLowerCase();
  } catch {
    return '';
  }
}

function modifyTtlAndCache(query, response) {
  try {
    if (response.length < 12) return;
    const rcode = response[3] & 0x0f;
    if (rcode !== 0 && rcode !== 3) return;

    const qd = response.readUInt16BE(4);
    const records = response.readUInt16BE(6) + response.readUInt16BE(8);
    let o = 12;
    for (let i = 0; i < qd; i++) {
      while (o < response.length) {
        const len = response[o];
        if (len === 0) { o += 1; break; }
        if ((len & 0xc0) === 0xc0) { o += 2; break; }
        o += len + 1;
      }
      o += 4; // skip QTYPE/QCLASS
    }

    // Force every returned DNS record to carry our max locked TTL
    for (let i = 0; i < records; i++) {
      while (o < response.length) {
        const len = response[o];
        if (len === 0) { o += 1; break; }
        if ((len & 0xc0) === 0xc0) { o += 2; break; }
        o += len + 1;
      }
      if (o + 10 <= response.length) {
        response.writeUInt32BE(TTL_LOCK, o + 4); // Overwrite TTL
        const rdlen = response.readUInt16BE(o + 8);
        o += 10 + rdlen;
      } else {
        break;
      }
    }

    const key = Buffer.from(query);
    key[0] = 0; key[1] = 0; // ignore transaction ID for caching
    cache.set(key.toString('base64'), { buf: Buffer.from(response), expires: Date.now() + TTL_LOCK * 1000 });
  } catch (err) {
    console.error('TTL modification error:', err.message);
  }
}

async function resolveDoh(query) {
  const key = Buffer.from(query);
  key[0] = 0; key[1] = 0;
  const cacheKeyStr = key.toString('base64');
  
  const cached = cache.get(cacheKeyStr);
  if (cached && cached.expires > Date.now()) {
    const out = Buffer.from(cached.buf);
    out[0] = query[0]; // restore client transaction ID
    out[1] = query[1];
    return out;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        Accept: 'application/dns-message',
        'Content-Type': 'application/dns-message',
      },
      body: query,
      signal: ctrl.signal,
    });

    if (!res.ok) throw new Error(`Upstream error: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    const domain = parseQueryDomain(query);
    if (domain.includes('konami') || domain.includes('efootball')) {
      console.log(`[STABLE PIN] Locked game domain target: ${domain}`);
    }

    modifyTtlAndCache(query, buf);

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
  res.status(200).send('Deep-Pinned DoH Booster Online');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', pinnedSessions: cache.size, uptime: process.uptime() });
});

async function handleDoh(req, res) {
  let query = null;

  if (req.method === 'POST' && Buffer.isBuffer(req.body) && req.body.length > 0) {
    query = req.body;
  } else if (req.method === 'GET' && typeof req.query.dns === 'string') {
    query = Buffer.from(req.query.dns, 'base64url');
  }

  if (!query || query.length < 12) {
    return res.status(200).json({ status: 'active', profile: req.params.id || 'default' });
  }

  try {
    const answer = await resolveDoh(query);
    res.set({
      'Content-Type': 'application/dns-message',
      'Cache-Control': 'public, max-age=14400',
      'Access-Control-Allow-Origin': '*',
    });
    return res.status(200).send(answer);
  } catch (err) {
    console.error('Resolution failed:', err.message);
    return res.status(502).send('Bad Gateway');
  }
}

app.all('/b/:id', handleDoh);
app.all('/dns-query', handleDoh);

app.listen(PORT, () => {
  console.log(`Deep-pinned DoH server listening on port ${PORT}`);
});