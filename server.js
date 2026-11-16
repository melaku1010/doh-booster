const express = require('express');
const dnsPacket = require('dns-packet');

const app = express();
const PORT = process.env.PORT || 3000;

// Google DoH supports EDNS Client Subnet (ECS) for GeoDNS steering
const UPSTREAM_ECS = 'https://dns.google/dns-query';
const UPSTREAM_FAST = 'https://cloudflare-dns.com/dns-query';

// Frankfurt/Amsterdam core peering subnet to steer Anycast/GeoDNS game servers
const SPOOF_ECS_IP = process.env.ECS_IP || '185.156.46.0';
const LOCKED_TTL = 3600;

const cache = new Map();

// Keywords used by Konami / eFootball mobile infrastructure
const GAME_KEYWORDS = [
  'konami',
  'efootball',
  'pes',
  'awsglobalaccelerator',
  'googleusercontent',
  'akamaiedge',
  'cloudfront'
];

function isGameDomain(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return GAME_KEYWORDS.some(kw => lower.includes(kw));
}

// Inject EDNS0 Client Subnet option into outgoing DNS query
function addEdnsSubnet(decodedQuery, ip) {
  const additionals = (decodedQuery.additionals || []).filter(r => r.type !== 'OPT');
  additionals.push({
    type: 'OPT',
    name: '.',
    udpPayloadSize: 4096,
    extendedRcode: 0,
    ednsVersion: 0,
    flags: 0,
    flag_do: false,
    options: [
      {
        code: 'CLIENT_SUBNET',
        family: 1, // IPv4
        sourcePrefixLength: 24,
        scopePrefixLength: 0,
        ip: ip
      }
    ]
  });
  decodedQuery.additionals = additionals;
  return dnsPacket.encode(decodedQuery);
}

// Strip AAAA (IPv6) for game domains and lock A records to a single deterministic IP
function optimizeGameResponse(decodedResp, domain) {
  if (!decodedResp.answers || decodedResp.answers.length === 0) return decodedResp;

  const aRecords = decodedResp.answers.filter(a => a.type === 'A');
  const otherRecords = decodedResp.answers.filter(a => a.type !== 'A' && a.type !== 'AAAA');

  if (aRecords.length > 0) {
    // Sort IPs deterministically and pick ONLY ONE to prevent round-robin server hopping
    aRecords.sort((a, b) => a.data.localeCompare(b.data));
    const chosenRecord = aRecords[0];
    chosenRecord.ttl = LOCKED_TTL;

    decodedResp.answers = [...otherRecords, chosenRecord];
    console.log(`[GAME PIN] ${domain} -> Locked single IP: ${chosenRecord.data} (dropped ${aRecords.length - 1} alt IPs)`);
  }

  return decodedResp;
}

async function resolveQuery(rawQueryBuffer) {
  const decoded = dnsPacket.decode(rawQueryBuffer);
  const question = decoded.questions && decoded.questions[0];
  const qName = question ? question.name : '';
  const qType = question ? question.type : '';
  const gameTraffic = isGameDomain(qName);

  // Block IPv6 (AAAA) queries for game domains to force pure IPv4 low-jitter routing
  if (gameTraffic && qType === 'AAAA') {
    return dnsPacket.encode({
      id: decoded.id,
      type: 'response',
      flags: 384, // QR + RD + RA
      questions: decoded.questions,
      answers: []
    });
  }

  const cacheKey = `${qName}:${qType}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    const resp = dnsPacket.decode(cached.buf);
    resp.id = decoded.id;
    return dnsPacket.encode(resp);
  }

  // Steer game traffic using ECS via Google DoH; normal traffic via Cloudflare
  const targetUpstream = gameTraffic ? UPSTREAM_ECS : UPSTREAM_FAST;
  const outboundBuffer = gameTraffic
    ? addEdnsSubnet(decoded, SPOOF_ECS_IP)
    : rawQueryBuffer;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);

  try {
    const r = await fetch(targetUpstream, {
      method: 'POST',
      headers: {
        'Accept': 'application/dns-message',
        'Content-Type': 'application/dns-message'
      },
      body: outboundBuffer,
      signal: ctrl.signal
    });

    if (!r.ok) throw new Error(`Upstream HTTP ${r.status}`);
    const rawResp = Buffer.from(await r.arrayBuffer());

    let finalBuffer = rawResp;
    if (gameTraffic) {
      let decodedResp = dnsPacket.decode(rawResp);
      decodedResp = optimizeGameResponse(decodedResp, qName);
      decodedResp.id = decoded.id;
      finalBuffer = dnsPacket.encode(decodedResp);
    }

    cache.set(cacheKey, {
      buf: finalBuffer,
      expires: Date.now() + (gameTraffic ? LOCKED_TTL * 1000 : 300 * 1000)
    });

    return finalBuffer;
  } finally {
    clearTimeout(timer);
  }
}

app.use(express.raw({ type: 'application/dns-message', limit: '1mb' }));

app.get('/', (req, res) => {
  res.status(200).send('ECS + Single-IP Pinned DoH Engine Active');
});

async function handleDoh(req, res) {
  let query = null;
  if (req.method === 'POST' && Buffer.isBuffer(req.body) && req.body.length > 0) {
    query = req.body;
  } else if (req.method === 'GET' && typeof req.query.dns === 'string') {
    query = Buffer.from(req.query.dns, 'base64url');
  }

  if (!query || query.length < 12) {
    return res.status(400).send('Invalid DNS query');
  }

  try {
    const answer = await resolveQuery(query);
    res.set({
      'Content-Type': 'application/dns-message',
      'Cache-Control': 'no-store'
    });
    return res.status(200).send(answer);
  } catch (err) {
    console.error('DNS error:', err.message);
    return res.status(502).send('Bad Gateway');
  }
}

app.all('/b/:id', handleDoh);
app.all('/dns-query', handleDoh);

app.listen(PORT, () => {
  console.log(`ECS Packet-Rewriting DoH Server listening on port ${PORT}`);
});
