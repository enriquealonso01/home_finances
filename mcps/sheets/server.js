import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(ROOT, '.env') });

const KEY_FILE = path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  ? process.env.GOOGLE_APPLICATION_CREDENTIALS
  : path.join(ROOT, process.env.GOOGLE_APPLICATION_CREDENTIALS);

const SHEET_IDS = {
  family: process.env.FAMILY_SHEET_ID,
  llc: process.env.LLC_SHEET_ID,
};

const auth = new google.auth.GoogleAuth({
  keyFile: KEY_FILE,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

function spreadsheetId(alias) {
  const id = SHEET_IDS[alias];
  if (!id) throw new Error(`Unknown spreadsheet alias: ${alias}. Expected 'family' or 'llc'.`);
  return id;
}

const TOOLS = [
  {
    name: 'sheets_list_tabs',
    description: "List all tabs in 'family' or 'llc' spreadsheet with name, gid, row count, column count.",
    inputSchema: {
      type: 'object',
      properties: { spreadsheet: { type: 'string', enum: ['family', 'llc'] } },
      required: ['spreadsheet'],
    },
  },
  {
    name: 'sheets_read',
    description: "Read a range from 'family' or 'llc'. Returns a 2D array. Range uses A1 notation, e.g. \"Jan 2026!A1:G100\" or just \"Jan 2026\" for the whole tab.",
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet: { type: 'string', enum: ['family', 'llc'] },
        range: { type: 'string' },
      },
      required: ['spreadsheet', 'range'],
    },
  },
  {
    name: 'sheets_append',
    description: 'Append rows at the end of a tab. Range is typically the tab name like "May 2026". Values is a 2D array of rows.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet: { type: 'string', enum: ['family', 'llc'] },
        range: { type: 'string' },
        values: { type: 'array', items: { type: 'array' } },
      },
      required: ['spreadsheet', 'range', 'values'],
    },
  },
  {
    name: 'sheets_update',
    description: 'Update a specific range with values (overwrites). Range like "Jan 2026!A5:G5". Values is a 2D array sized to the range.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet: { type: 'string', enum: ['family', 'llc'] },
        range: { type: 'string' },
        values: { type: 'array', items: { type: 'array' } },
      },
      required: ['spreadsheet', 'range', 'values'],
    },
  },
  {
    name: 'sheets_find_rows',
    description: 'Find rows in a tab where a given column (by letter) contains a substring (case-insensitive). Returns matching 1-based row indices and cell values. Used for template lookup, e.g. find the "May 2026 Rent" row in the LLC sheet before filling.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet: { type: 'string', enum: ['family', 'llc'] },
        tab: { type: 'string' },
        column: { type: 'string', description: 'Column letter, e.g. "D".' },
        match: { type: 'string', description: 'Substring to look for (case-insensitive).' },
      },
      required: ['spreadsheet', 'tab', 'column', 'match'],
    },
  },
  {
    name: 'sheets_duplicate_tab',
    description: 'Duplicate an existing tab to a new tab with a given name. Used for new-month template copies in the family sheet.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet: { type: 'string', enum: ['family', 'llc'] },
        source_tab: { type: 'string' },
        new_name: { type: 'string' },
      },
      required: ['spreadsheet', 'source_tab', 'new_name'],
    },
  },
  {
    name: 'sheets_clear_range',
    description: 'Clear cell contents (values only, not formatting) in a range.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet: { type: 'string', enum: ['family', 'llc'] },
        range: { type: 'string' },
      },
      required: ['spreadsheet', 'range'],
    },
  },
];

async function callTool(name, args) {
  const id = spreadsheetId(args.spreadsheet);

  switch (name) {
    case 'sheets_list_tabs': {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
      return meta.data.sheets.map(s => ({
        title: s.properties.title,
        gid: s.properties.sheetId,
        rows: s.properties.gridProperties.rowCount,
        cols: s.properties.gridProperties.columnCount,
      }));
    }
    case 'sheets_read': {
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: id,
        range: args.range,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      });
      return resp.data.values || [];
    }
    case 'sheets_append': {
      const resp = await sheets.spreadsheets.values.append({
        spreadsheetId: id,
        range: args.range,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: args.values },
      });
      return {
        updatedRange: resp.data.updates.updatedRange,
        updatedRows: resp.data.updates.updatedRows,
        updatedColumns: resp.data.updates.updatedColumns,
      };
    }
    case 'sheets_update': {
      const resp = await sheets.spreadsheets.values.update({
        spreadsheetId: id,
        range: args.range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: args.values },
      });
      return {
        updatedRange: resp.data.updatedRange,
        updatedRows: resp.data.updatedRows,
        updatedColumns: resp.data.updatedColumns,
      };
    }
    case 'sheets_find_rows': {
      const range = `${args.tab}!${args.column}:${args.column}`;
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: id,
        range,
      });
      const values = resp.data.values || [];
      const needle = args.match.toLowerCase();
      const matches = [];
      values.forEach((row, idx) => {
        const cell = (row[0] ?? '').toString().toLowerCase();
        if (cell.includes(needle)) matches.push({ row: idx + 1, value: row[0] });
      });
      return matches;
    }
    case 'sheets_duplicate_tab': {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
      const source = meta.data.sheets.find(s => s.properties.title === args.source_tab);
      if (!source) throw new Error(`Tab not found: ${args.source_tab}`);
      const resp = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: id,
        requestBody: {
          requests: [{
            duplicateSheet: {
              sourceSheetId: source.properties.sheetId,
              newSheetName: args.new_name,
            },
          }],
        },
      });
      const newSheet = resp.data.replies[0].duplicateSheet.properties;
      return { title: newSheet.title, gid: newSheet.sheetId };
    }
    case 'sheets_clear_range': {
      const resp = await sheets.spreadsheets.values.clear({
        spreadsheetId: id,
        range: args.range,
      });
      return { clearedRange: resp.data.clearedRange };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: 'home-finances-sheets', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await callTool(name, args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `ERROR: ${e.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
