const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();

// Initialize Google Drive API auth
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'),
  scopes: ['https://www.googleapis.com/auth/drive.readonly']
});
const drive = google.drive({ version: 'v3', auth });

const TRIGGER_SECRET = process.env.TRIGGER_SECRET || 'jdw-trigger-2026';

app.post('/trigger-stock', async (req, res) => {
  const { secret, fileId, filename } = req.body;

  if (secret !== TRIGGER_SECRET) {
    return res.status(403).json({ error: 'Unauthorized secret' });
  }

  if (!fileId || !filename) {
    return res.status(400).json({ error: 'Missing fileId or filename' });
  }

  console.log(`📡 Trigger received: ${filename} (${fileId})`);

  const tempFilePath = path.join('/tmp', `${Date.now()}_${filename}`);

  try {
    // 1. Download PDF from Google Drive
    const dest = fs.createWriteStream(tempFilePath);
    const response = await drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    await new Promise((resolve, reject) => {
      response.data
        .on('end', () => {
          console.log(`   📥 Downloaded ${filename} (${fs.statSync(tempFilePath).size} bytes)`);
          resolve();
        })
        .on('error', err => reject(err))
        .pipe(dest);
    });

    // 2. Execute Python parser (parse_stock_pdf.py)
    const pythonScript = path.join(__dirname, 'parse_stock_pdf.py');
    
    execFile('python3', [pythonScript, tempFilePath], async (error, stdout, stderr) => {
      // Clean up local temp file immediately
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

      if (error) {
        console.error(`❌ Python execution error: ${stderr}`);
        return res.status(500).json({ error: stderr || error.message });
      }

      try {
        const auditResult = JSON.parse(stdout);
        
        console.log(`   🔍 Audit Status: ${auditResult.status} | Rows: ${auditResult.total_rows} | Qty Rec: ${auditResult.calculated_qty_rec} | Qty Sort: ${auditResult.calculated_qty_sort}`);

        if (auditResult.status !== 'PASSED' || auditResult.total_rows === 0) {
          console.error(`❌ Audit FAILED for ${filename}. Push to Firebase aborted.`);
          return res.status(422).json({ error: 'Stock audit failed validation checks.', audit: auditResult });
        }

        const rows = auditResult.records;

        // Determine user tag from filename
        const base = filename.toLowerCase();
        let user = 'unknown';
        if (base.includes('riaan') || base.includes('rj')) user = 'RJ';
        else if (base.includes('cdw')) user = 'CW';
        else if (base.includes('pot')) user = 'POT';

        // Format into a GRN lookup dictionary for Firebase
        const stockByGrn = {};
        rows.forEach(r => {
          stockByGrn[r.grn] = {
            ...r,
            user: user,
            source_file: filename
          };
        });

        // 3. Push verified data to Firebase
        await db.ref(`stock/${user}`).set(stockByGrn);
        console.log(`   ✅ Stock pushed & verified: /stock/${user} — ${rows.length} rows from ${filename}`);

        return res.status(200).json({
          status: 'success',
          filename: filename,
          user: user,
          rows_processed: rows.length,
          audit: auditResult.status
        });

      } catch (parseErr) {
        console.error(`❌ Failed to parse Python stdout JSON: ${stdout}`);
        return res.status(500).json({ error: 'Invalid JSON response from parser script' });
      }
    });

  } catch (err) {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    console.error(`❌ Error processing request: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 JDW Sync Server running on port ${PORT}`);
});
