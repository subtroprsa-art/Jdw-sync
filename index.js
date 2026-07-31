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

// Helper to clean commodity names for the pipeline and UI
function getFriendlyProductName(rawName) {
    if (!rawName) return 'Produce';
    let clean = rawName.toString().split(',')[0].replace(/\d{1,2}[\/\-]\w{3}[\/\-]\d{4}/g, '').trim();
    const upper = clean.toUpperCase();
    if (upper.includes('ORG') || upper.includes('ORANGE')) return 'Oranges';
    if (upper.includes('AVO') || upper.includes('AVOCADO')) return 'Avos';
    if (upper.includes('LEM') || upper.includes('LEMON')) return 'Lemons';
    if (upper.includes('NOV')) return 'Nova';
    if (upper.includes('BER')) return 'Berries';
    if (upper.includes('NUT')) return 'Nuts';
    return clean || 'Produce';
}

// Master data distributor to update dedicated frontend nodes automatically on backend writes
async function updateDedicatedNodes() {
  try {
    console.log("⚡ Rebuilding dedicated Firebase nodes...");
    
    const stockSnap = await db.ref('stock').once('value');
    const stockVal = stockSnap.val() || {};
    
    let totalUnits = 0;
    const normalizedUIStock = [];
    const normalizedPipelineStock = [];

    // Flatten multi-user stock tree (RJ, CDW, POT)
    for (const userKey in stockVal) {
      const userStock = stockVal[userKey];
      for (const itemKey in userStock) {
        const item = userStock[itemKey];
        if (!item || typeof item !== 'object') continue;

        const balanceVal = Number(
            item.balance !== undefined ? item.balance :
            (item.flr !== undefined ? item.flr :
            (item.count !== undefined ? item.count :
            (item.qty !== undefined ? item.qty :
            (item.qty_rec !== undefined ? item.qty_rec : 0))))
        ) || 0;

        totalUnits += balanceVal;

        normalizedUIStock.push({
          id: itemKey,
          producer: item.producer || item.farm || userKey,
          commodity: item.commodity || item.comm || item.variety || 'PRODUCE',
          grn: item.grn || '-',
          balance: balanceVal,
          pack: item.pack || item.size || '-'
        });

        normalizedPipelineStock.push({
          id: itemKey,
          friendly_name: getFriendlyProductName(item.commodity || item.comm || item.item),
          pack: item.pack || (item.size ? `${item.size}kg` : ''),
          qty: balanceVal
        });
      }
    }

    // Grab buyers to compute total revenue if available
    const buyersSnap = await db.ref('buyers').once('value');
    const buyersVal = buyersSnap.val() || {};
    let totalRev = 0;
    let buyerCount = 0;

    if (Array.isArray(buyersVal)) {
      buyerCount = buyersVal.length;
      buyersVal.forEach(b => {
        totalRev += Number(b.turnover || b.totalSpent || b.revenue || 0) || 0;
      });
    } else {
      const buyerKeys = Object.keys(buyersVal);
      buyerCount = buyerKeys.length;
      buyerKeys.forEach(k => {
        const b = buyersVal[k];
        totalRev += Number(b.turnover || b.totalSpent || b.revenue || 0) || 0;
      });
    }

    const updates = {};
    updates['/dashboard_kpis'] = {
      total_floor_units: totalUnits,
      total_buyers: buyerCount,
      total_revenue: totalRev,
      last_updated: Date.now()
    };
    updates['/ui_stock_balances'] = normalizedUIStock;
    updates['/pipeline_data'] = normalizedPipelineStock;

    await db.ref().update(updates);
    console.log("✅ Dedicated nodes successfully updated on backend.");
  } catch (err) {
    console.error("❌ Error updating dedicated nodes:", err);
  }
}

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

        // Trigger background sync to dedicated frontend nodes
        await updateDedicatedNodes();

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
