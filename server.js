const express = require('express');
const dnsPacket = require('dns-packet');

const app = express();
const PORT = process.env.PORT || 3000;

// Your friend's active upstream link for shared relay routing
const GAME_UPSTREAM = 'https://ebuzz-boost-production.up.railway.app/b/efb-hgxvyh';
const FALLBACK_UPSTREAM = 'https://dns.google/dns-query';
const WEB_UPSTREAM = 'https://cloudflare-dns.com/dns-query';

const LOCKED_GAME_TTL = 7200; // 2-hour hard lock
const cache = new Map();
const pinnedLog = new Map();

const GAME_KEYWORDS = [
  'konami',
  'efootball',
  'pes',
  'awsglobalaccelerator',
  'googleusercontent',
  'akamaiedge',
  'cloudfront',
  'gameserver'
];

function isGameDomain(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return GAME_KEYWORDS.some(kw => lower.includes(kw));
}

async function fetchDohUpstream(url, rawQueryBuffer, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/dns-message',
        'Content-Type': 'application/dns-message'
      },
      body: rawQueryBuffer,
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function pinSingleIpResponse(decodedResp, domain) {
  if (!decodedResp.answers || decodedResp.answers.length === 0) return decodedResp;

  const aRecords = decodedResp.answers.filter(a => a.type === 'A');
  const cnameRecords = decodedResp.answers.filter(a => a.type === 'CNAME');

  if (aRecords.length > 0) {
    const chosen = aRecords[0];
    chosen.ttl = LOCKED_GAME_TTL;
    decodedResp.answers = [...cnameRecords, chosen];
    pinnedLog.set(domain, {
      ip: chosen.data,
      lockedAt: new Date().toISOString(),
      hits: (pinnedLog.get(domain)?.hits || 0) + 1
    });
  }

  return decodedResp;
}

async function resolveQuery(rawQueryBuffer) {
  const decoded = dnsPacket.decode(rawQueryBuffer);
  const question = decoded.questions && decoded.questions[0];
  const qName = question ? question.name.toLowerCase() : '';
  const qType = question ? question.type : '';
  const gameTraffic = isGameDomain(qName);

  if (gameTraffic && qType === 'AAAA') {
    return dnsPacket.encode({
      id: decoded.id,
      type: 'response',
      flags: 384,
      questions: decoded.questions,
      answers: []
    });
  }

  const cacheKey = `${qName}:${qType}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    if (gameTraffic && pinnedLog.has(qName)) {
      pinnedLog.get(qName).hits += 1;
    }
    const resp = dnsPacket.decode(cached.buf);
    resp.id = decoded.id;
    return dnsPacket.encode(resp);
  }

  let rawResp;
  if (gameTraffic) {
    try {
      rawResp = await fetchDohUpstream(GAME_UPSTREAM, rawQueryBuffer, 2500);
    } catch {
      rawResp = await fetchDohUpstream(FALLBACK_UPSTREAM, rawQueryBuffer, 2500);
    }
  } else {
    rawResp = await fetchDohUpstream(WEB_UPSTREAM, rawQueryBuffer, 2000);
  }

  let finalBuffer = rawResp;
  if (gameTraffic) {
    let decodedResp = dnsPacket.decode(rawResp);
    decodedResp = pinSingleIpResponse(decodedResp, qName);
    decodedResp.id = decoded.id;
    finalBuffer = dnsPacket.encode(decodedResp);
  }

  cache.set(cacheKey, {
    buf: finalBuffer,
    expires: Date.now() + (gameTraffic ? LOCKED_GAME_TTL * 1000 : 300 * 1000)
  });

  return finalBuffer;
}

app.use(express.raw({ type: 'application/dns-message', limit: '1mb' }));

// --- PLACED FIRST TO FIX THE ROUTING CONFLICT ---
app.get('/stats', (req, res) => {
  res.status(200).json({
    activeCacheEntries: cache.size,
    pinnedGameRoutes: Object.fromEntries(pinnedLog)
  });
});

app.get('/', (req, res) => {
  res.status(200).send('Shared-Pool Gaming DoH Booster Active');
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
    const answer = await resolveQuery(query);
    res.set({
      'Content-Type': 'application/dns-message',
      'Cache-Control': 'no-store'
    });
    return res.status(200).send(answer);
  } catch (err) {
    console.error('Resolution error:', err.message);
    return res.status(502).send('Bad Gateway');
  }
}

app.all('/b/:id', handleDoh);
app.all('/dns-query', handleDoh);

app.listen(PORT, () => {
  console.log(`Shared-Pool Gaming DoH server listening on port ${PORT}`);
});
