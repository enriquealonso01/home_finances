import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
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
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

const FOLDER_ID = process.env.APPLE_CARD_DRIVE_FOLDER_ID;
const LOCAL_DIR = path.join(ROOT, 'data', 'apple_card');
fs.mkdirSync(LOCAL_DIR, { recursive: true });

const list = await drive.files.list({
  q: `'${FOLDER_ID}' in parents and trashed=false and (mimeType='text/csv' or name contains '.csv')`,
  fields: 'files(id,name,size,modifiedTime,mimeType)',
  pageSize: 200,
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
});

const files = list.data.files || [];
console.log(`Found ${files.length} file(s) in Drive folder:`);
files.forEach(f => console.log(`  - "${f.name}"  ${f.size}b  ${f.modifiedTime}`));
console.log('');

for (const f of files) {
  const localPath = path.join(LOCAL_DIR, f.name);
  const resp = await drive.files.get(
    { fileId: f.id, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );
  const out = fs.createWriteStream(localPath);
  await new Promise((res, rej) => {
    resp.data.on('end', res).on('error', rej).pipe(out);
  });
  console.log(`Downloaded → ${path.relative(ROOT, localPath)}`);
}

if (files.length > 0) {
  console.log('\n--- Content of first CSV ---');
  const first = files[0];
  console.log(fs.readFileSync(path.join(LOCAL_DIR, first.name), 'utf-8'));
}
