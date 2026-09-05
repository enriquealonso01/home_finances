import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
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
if (!fs.existsSync(TOKENS_FILE)) {
  console.log('No Plaid tokens yet. Run "npm run link-server" first.');
  process.exit(0);
}
const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));

console.log(`Connected institution(s): ${Object.keys(tokens).length}\n`);

for (const [item_id, t] of Object.entries(tokens)) {
  console.log(`=== ${t.institution_name}  (item_id: ${item_id}) ===`);
  try {
    const resp = await client.accountsGet({ access_token: t.access_token });
    for (const a of resp.data.accounts) {
      console.log(`  • ${a.name}  [${a.subtype}/${a.type}]  ****${a.mask}`);
      console.log(`     official: ${a.official_name || '(none)'}`);
      console.log(`     account_id: ${a.account_id}`);
    }
  } catch (e) {
    console.log('  ERROR:', JSON.stringify(e?.response?.data || e.message));
  }
  console.log('');
}
