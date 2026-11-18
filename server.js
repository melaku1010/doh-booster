// --- ISOLATED STATS ROUTE ---
app.get('/stats-data', (req, res) => {
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
    // This is what your screenshot was triggering because the browser GET request 
    // hit the wildcard route without a valid binary DNS query payload!
    return res.status(200).json({ status: 'active', booster: 'doh-endpoint', message: 'Send DNS query payloads here via Intra.' });
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
