'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const FOLDER_NAME = 'app projects';
const FILE_NAME   = 'helmets.html';
const FILE_PATH   = path.join(__dirname, FILE_NAME);

async function run() {
  if (!process.env.GOOGLE_CREDENTIALS) {
    console.error('GOOGLE_CREDENTIALS env var not set');
    process.exit(1);
  }

  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  const drive = google.drive({ version: 'v3', auth });

  // Find the "app projects" folder
  const folderSearch = await drive.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  const folder = folderSearch.data.files?.[0];
  const folderId = folder?.id;

  if (folderId) {
    console.log(`Found folder "${FOLDER_NAME}" (${folderId})`);
  } else {
    console.warn(`Folder "${FOLDER_NAME}" not found — uploading to Drive root`);
  }

  // Check if file already exists in that location
  const existingQ = folderId
    ? `name='${FILE_NAME}' and '${folderId}' in parents and trashed=false`
    : `name='${FILE_NAME}' and trashed=false`;

  const existingSearch = await drive.files.list({
    q: existingQ,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  const existing = existingSearch.data.files?.[0];
  const media = { mimeType: 'text/html', body: fs.createReadStream(FILE_PATH) };

  if (existing) {
    await drive.files.update({
      fileId: existing.id,
      media,
    });
    console.log(`Updated "${FILE_NAME}" in Drive (${existing.id})`);
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: FILE_NAME,
        ...(folderId ? { parents: [folderId] } : {}),
      },
      media,
      fields: 'id',
    });
    console.log(`Uploaded "${FILE_NAME}" to Drive (${created.data.id})`);
  }
}

run().catch(err => {
  console.error('Drive upload failed:', err.message);
  process.exit(1);
});
