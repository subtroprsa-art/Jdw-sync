const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'),
  scopes: ['https://www.googleapis.com/auth/drive.readonly']
});
const drive = google.drive({ version: 'v3', auth });

const TRIGGER_SECRET = process.env.TRIGGER_SECRET || 'jdw-trigger-2026';

// Helper function to download file from Google Drive and run a Python script parser
async function handlePdfProcessing(req, res, isFloor) {
  const { secret, fileId, filename } = req.body;

  if (secret !== TRIGGER_SECRET) {
    return res.status(403).json({ error: 'Unauthorized secret' });
  }

  if (!fileId || !filename) {
    return res.status(400).json({ error: 'Missing fileId or filename' });
  }

  console.log(`📡 ${isFloor ? 'Floor' : 'Stock'} Trigger received: ${filename} (${fileId})`);
  const tempFilePath = path.join('/tmp', `${Date.now()}_${filename}`);

  try {
    const dest = fs.createWriteStream(tempFilePath);
    const response = await drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    await new Promise((resolve, reject) => {
      response.data
        .on('end', () => resolve())
        .on('error', err => reject(err))
        .pipe(dest);
    });

    // Determine user tag (RJ, CDW, or POT) matching frontend expectations
    const base = filename.toLowerCase();
    let user = 'UNKNOWN';
    if (base.includes('riaan') || base.includes('rj')) {
      user = 'RJ';
    } else if (base.includes('cdw') || base.includes('cw')) {
      user = 'CDW';
    } else if (base.includes('pot')) {
      user = 'POT';
    }

    const scriptName = isFloor ? 'parse_floor_pdf.py' : 'parse_stock_pdf.py';
    const pythonScript = path.join(__dirname, scriptName);
    
    const scriptArgs = isFloor 
      ? [pythonScript, tempFilePath, user, new Date().toISOString().split('T')[0]]
      : [pythonScript, tempFilePath];

    execFile('python3', scriptArgs, async (error, stdout, stderr) => {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

      if (error) {
        console.error(`❌ Python execution error (${scriptName}): ${stderr}`);
        return res.status(500).json({ error: stderr || error.message });
      }

      try {
        const resultData = JSON.parse(stdout);
        
        let rows = [];
        let dbPath = '';

        if (isFloor) {
          rows = Array.isArray(resultData) ? resultData : [];
          dbPath = `floorBalance/${user}`;
        } else {
          rows = resultData.records || [];
          dbPath = `stock/${user}`;
        }

        if (rows.length === 0) {
          console.error(`⚠️ No rows parsed from ${filename} using ${scriptName}`);
          return res.status(422).json({ error: 'Parser returned 0 rows.', output: resultData });
        }

        const dataByGrn = {};
        rows.forEach(r => {
          const key = r.grn || `row_${Math.random()}`;
          dataByGrn[key] = {
            ...r,
            user: user,
            source_file: filename
          };
        });

        await db.ref(dbPath).set(dataByGrn);
        console.log(`   ✅ Verified & pushed: /${dbPath} — ${rows.length} rows from ${filename}`);

        return res.status(200).json({
          status: 'success',
          filename: filename,
          user: user,
          rows_processed: rows.length,
          type: isFloor ? 'floor_balance' : 'stock'
        });

      } catch (parseErr) {
        console.error(`❌ Failed to parse Python stdout JSON: ${stdout}`);
        return res.status(500).json({ error: 'Invalid JSON response from parser script' });
      }
    });

  } catch (err) {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    return res.status(500).json({ error: err.message });
  }
}

// Endpoint 1: Stock Scans
app.post('/trigger-stock', async (req, res) => {
  await handlePdfProcessing(req, res, false);
});

// Endpoint 2: Floor Balance Scans
app.post('/trigger-floor', async (req, res) => {
  await handlePdfProcessing(req, res, true);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 JDW Sync Server running on port ${PORT}`);
});
