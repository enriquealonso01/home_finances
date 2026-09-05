import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

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

const TOOLS = [
  {
    name: 'plaid_list_items',
    description: 'List Plaid items (institutions) the user has connected via Link. Returns item_id, institution_name, added_at for each.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'plaid_list_accounts',
    description: 'List accounts (cards/checking/etc.) for a given item_id, or for all items if item_id is omitted. Returns account_id, name, official_name, mask (last-4), type, subtype per account.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'Optional. If omitted, returns accounts across all connected institutions.' },
      },
    },
  },
  {
    name: 'plaid_get_transactions',
    description: 'Get transactions for a date range. Optionally filter by account_ids or item_id. Returns transaction details: date, amount (positive = outflow), name, merchant_name, category, account_id, pending, transaction_id.',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        account_ids: { type: 'array', items: { type: 'string' }, description: 'Optional. If provided, limits results to these accounts.' },
        item_id: { type: 'string', description: 'Optional. If provided, only this institution; otherwise all connected items.' },
      },
      required: ['start_date', 'end_date'],
    },
  },
];

async function callTool(name, args) {
  const tokens = loadTokens();

  switch (name) {
    case 'plaid_list_items': {
      return Object.entries(tokens).map(([item_id, t]) => ({
        item_id,
        institution_id: t.institution_id,
        institution_name: t.institution_name,
        added_at: t.added_at,
      }));
    }

    case 'plaid_list_accounts': {
      const targets = args.item_id
        ? (tokens[args.item_id] ? { [args.item_id]: tokens[args.item_id] } : {})
        : tokens;
      const out = [];
      for (const [item_id, t] of Object.entries(targets)) {
        const resp = await client.accountsGet({ access_token: t.access_token });
        for (const a of resp.data.accounts) {
          out.push({
            item_id,
            institution_name: t.institution_name,
            account_id: a.account_id,
            name: a.name,
            official_name: a.official_name,
            mask: a.mask,
            type: a.type,
            subtype: a.subtype,
          });
        }
      }
      return out;
    }

    case 'plaid_get_transactions': {
      const targets = args.item_id
        ? (tokens[args.item_id] ? { [args.item_id]: tokens[args.item_id] } : {})
        : tokens;
      const allTxns = [];
      for (const [item_id, t] of Object.entries(targets)) {
        let offset = 0;
        const count = 500;
        while (true) {
          const options = { offset, count };
          if (args.account_ids) options.account_ids = args.account_ids;
          const resp = await client.transactionsGet({
            access_token: t.access_token,
            start_date: args.start_date,
            end_date: args.end_date,
            options,
          });
          for (const tx of resp.data.transactions) {
            allTxns.push({
              item_id,
              institution_name: t.institution_name,
              transaction_id: tx.transaction_id,
              account_id: tx.account_id,
              date: tx.date,
              authorized_date: tx.authorized_date,
              amount: tx.amount,
              name: tx.name,
              merchant_name: tx.merchant_name,
              category: tx.category,
              personal_finance_category: tx.personal_finance_category,
              pending: tx.pending,
              iso_currency_code: tx.iso_currency_code,
            });
          }
          if (resp.data.transactions.length < count) break;
          offset += count;
          if (offset >= resp.data.total_transactions) break;
        }
      }
      return allTxns;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: 'home-finances-plaid', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await callTool(name, args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const detail = e?.response?.data || e.message;
    return {
      content: [{ type: 'text', text: `ERROR: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
