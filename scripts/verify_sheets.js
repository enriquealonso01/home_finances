import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

const KEY_FILE = path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  ? process.env.GOOGLE_APPLICATION_CREDENTIALS
  : path.join(ROOT, process.env.GOOGLE_APPLICATION_CREDENTIALS);

const auth = new google.auth.GoogleAuth({
  keyFile: KEY_FILE,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const targets = [
  ['Family', process.env.FAMILY_SHEET_ID],
  ['LLC', process.env.LLC_SHEET_ID],
];

for (const [name, id] of targets) {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
    const title = meta.data.properties.title;
    const tabs = meta.data.sheets.map(s => ({
      title: s.properties.title,
      gid: s.properties.sheetId,
      rows: s.properties.gridProperties.rowCount,
      cols: s.properties.gridProperties.columnCount,
    }));
    console.log(`OK  ${name}: "${title}" (${tabs.length} tabs)`);
    tabs.forEach(t => console.log(`    - "${t.title}"  gid=${t.gid}  ${t.rows}x${t.cols}`));
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}
