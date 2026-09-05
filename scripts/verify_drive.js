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
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

const FOLDER_ID = process.env.APPLE_CARD_DRIVE_FOLDER_ID;

try {
  const folder = await drive.files.get({
    fileId: FOLDER_ID,
    fields: 'id,name,mimeType,owners(emailAddress)',
    supportsAllDrives: true,
  });
  console.log(`OK  Folder: "${folder.data.name}" (mime: ${folder.data.mimeType})`);

  const list = await drive.files.list({
    q: `'${FOLDER_ID}' in parents and trashed=false`,
    fields: 'files(id,name,mimeType,size,modifiedTime)',
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = list.data.files || [];
  console.log(`Files in folder: ${files.length}`);
  for (const f of files) {
    console.log(`  - "${f.name}"  ${f.mimeType}  ${f.size || '?'} bytes  ${f.modifiedTime}`);
  }
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  if (e.errors) console.log(JSON.stringify(e.errors, null, 2));
  process.exitCode = 1;
}
