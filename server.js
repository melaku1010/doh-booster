const express = require('express');
const fetch = require('node-fetch');
const app = express();

// Use Railway's dynamic port or default to 3000 locally
const PORT = process.env.PORT || 3000;

// Upstream secure DNS resolver (e.g., Cloudflare DoH endpoint)
const UPSTREAM_DOH = 'https://cloudflare-dns.com/dns-query';

app.use(express.raw({ type: 'application/dns-message', limit: '1mb' }));
app.use(express.json());

// Health check route for Railway
app.get('/', (req, res) => {
  res.status(200).send('DoH Booster Backend is running successfully!');
});

// Custom booster route handler (matches paths like /b/efb-fkkyz5 or any custom ID)
app.all('/b/:id', async (req, res) => {
  const boosterId = req.params.id;
  console.log(`[+] Incoming request for booster profile: ${boosterId}`);

  try {
    // If the client app sends binary DNS queries (RFC 8484)
    if (req.method === 'POST' && req.headers['content-type'] === 'application/dns-message') {
      const response = await fetch(UPSTREAM_DOH, {
        method: 'POST',
        headers: {
          'Accept': 'application/dns-message',
          'Content-Type': 'application/dns-message',
        },
        body: req.body
      });
      
      const buffer = await response.buffer();
      res.set('Content-Type', 'application/dns-message');
      return res.status(200).send(buffer);
    }

    // Fallback GET request handler for browser or basic testing checks
    res.status(200).json({
      status: 'active',
      booster: boosterId,
      message: 'Custom routing endpoint is live and operational.'
    });

  } catch (error) {
    console.error('[-] Error handling DNS query:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});