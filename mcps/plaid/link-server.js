import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import dotenv from 'dotenv';
import express from 'express';
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(ROOT, '.env') });

const config = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const client = new PlaidApi(config);

const TOKENS_FILE = path.join(ROOT, 'secrets/plaid_tokens.json');

function loadTokens() {
  if (!fs.existsSync(TOKENS_FILE)) return {};
  return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
}
function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  const tokens = loadTokens();
  const items = Object.entries(tokens)
    .map(([id, t]) => `<li><strong>${escapeHtml(t.institution_name || id)}</strong> <span style="color:#888">(added ${new Date(t.added_at).toLocaleDateString()})</span></li>`)
    .join('');
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>home_finances · Plaid Link</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;color:#222;">
<h1>home_finances</h1>
<p>Plaid environment: <strong>${escapeHtml(process.env.PLAID_ENV || 'production')}</strong></p>
<h2>Connected institutions</h2>
<ul>${items || '<li><em>none yet</em></li>'}</ul>
<button id="link-btn" style="font-size:16px;padding:10px 20px;cursor:pointer;background:#000;color:#fff;border:0;border-radius:6px;">Connect a new bank</button>
<p id="status" style="margin-top:16px;color:#666;"></p>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
const statusEl = document.getElementById('status');
document.getElementById('link-btn').onclick = async () => {
  statusEl.textContent = 'Requesting Link token…';
  const r = await fetch('/api/link-token', {method: 'POST'});
  if (!r.ok) { statusEl.textContent = 'Failed: ' + (await r.text()); return; }
  const { link_token } = await r.json();
  const handler = Plaid.create({
    token: link_token,
    onSuccess: async (public_token, metadata) => {
      statusEl.textContent = 'Exchanging token for ' + metadata.institution.name + '…';
      const ex = await fetch('/api/exchange', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ public_token, institution: metadata.institution }),
      });
      if (!ex.ok) { statusEl.textContent = 'Exchange failed: ' + (await ex.text()); return; }
      statusEl.textContent = 'Connected! Reloading…';
      setTimeout(() => location.reload(), 800);
    },
    onExit: (err) => {
      if (err) statusEl.textContent = 'Link exited: ' + (err.display_message || err.error_message || err.error_code);
      else statusEl.textContent = '';
    },
  });
  handler.open();
};
</script>
</body></html>`);
});

app.post('/api/link-token', async (req, res) => {
  try {
    const response = await client.linkTokenCreate({
      user: { client_user_id: 'home-finances-user' },
      client_name: 'home_finances',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (e) {
    console.error('link-token error:', e?.response?.data || e);
    res.status(500).send(JSON.stringify(e?.response?.data || { error: e.message }));
  }
});

app.post('/api/exchange', async (req, res) => {
  try {
    const { public_token, institution } = req.body;
    const exchange = await client.itemPublicTokenExchange({ public_token });
    const access_token = exchange.data.access_token;
    const item_id = exchange.data.item_id;

    const tokens = loadTokens();
    tokens[item_id] = {
      access_token,
      institution_id: institution?.institution_id,
      institution_name: institution?.name,
      added_at: new Date().toISOString(),
    };
    saveTokens(tokens);

    console.log(`Linked: ${institution?.name} (${item_id})`);
    res.json({ ok: true, item_id });
  } catch (e) {
    console.error('exchange error:', e?.response?.data || e);
    res.status(500).send(JSON.stringify(e?.response?.data || { error: e.message }));
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const PORT = Number(process.env.LINK_SERVER_PORT) || 3001;
app.listen(PORT, () => {
  console.log(`Plaid Link server: http://localhost:${PORT}`);
});
