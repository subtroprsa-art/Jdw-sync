/**
 * jdw-sync — Express sync server
 * ────────────────────────────────
 * PDF parsing uses Claude Vision API (Anthropic):
 *   PDF → PNG pages (pdftoppm) → base64 → claude-sonnet → JSON rows
 *
 * This is immune to column-mixing because Claude reads the table visually,
 * exactly as a human would, regardless of how the PDF stores its text stream.
 *
 * Endpoints:
 *   POST /upload-stock   multipart PDF → parse → write Firebase
 *   GET  /stock/:user    read stock from Firebase
 *   DELETE /stock/:user/:id
 *   GET  /               health check
 */

const express        = require('express');
const cors           = require('cors');
const multer         = require('multer');
const { execFile, exec } = require('child_process');
const path           = require('path');
const fs             = require('fs');
const os             = require('os');
const admin          = require('firebase-admin');

// ── Firebase ──────────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: 'https://jdw-crm-default-rtdb.firebaseio.com',
});
const db = admin.database();

// ── Express ───────────────────────────────────────────────────────────────────
const app    = express();
const upload = multer({ dest: os.tmpdir() });
app.use(cors());
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const VISION_MODEL      = 'claude-sonnet-4-20250514';
const PDF_DPI           = 150;   // 150 DPI → ~A4 page ≈ 1240×1754px, good quality, small size

// ── Filename parser ───────────────────────────────────────────────────────────
// Filenames: DDMMYYYYPOT.pdf | DDMMYYYYCDW.pdf | DDMMYYYYriaan.pdf
function parseFilename(filename) {
  const base = path.basename(filename, '.pdf').toLowerCase();
  const m    = base.match(/^(\d{2})(\d{2})(\d{4})/);
  const dateStr = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  let user = 'unknown';
  if (base.includes('pot') || base.includes('riaan')) user = 'RJ';
  else if (base.includes('cdw'))                       user = 'CW';
  return { user, dateStr };
}

// ── PDF → PNG pages ───────────────────────────────────────────────────────────
function pdfToImages(pdfPath, outDir) {
  return new Promise((resolve, reject) => {
    const prefix = path.join(outDir, 'page');
    execFile('pdftoppm', ['-png', '-r', String(PDF_DPI), pdfPath, prefix],
      { timeout: 60_000 },
      (err, _stdout, stderr) => {
        if (err) return reject(new Error(`pdftoppm failed: ${stderr || err.message}`));
        // pdftoppm writes page-1.png, page-2.png … (zero-padded to page count)
        const files = fs.readdirSync(outDir)
          .filter(f => f.startsWith('page') && f.endsWith('.png'))
          .sort()
          .map(f => path.join(outDir, f));
        resolve(files);
      }
    );
  });
}

// ── Claude Vision: parse one page image ──────────────────────────────────────
const SYSTEM_PROMPT = `You are a precise agricultural stock data extractor.
You will be shown a page from a stock intake PDF used by a South African grain depot.
Extract every data row from the table and return ONLY a JSON array — no markdown, no explanation.

Each object in the array must have exactly these keys (use null if a value is not present):
  producer   - the producer/farmer/supplier name
  grn        - the GRN number or receipt number (string, keep any prefix like "GRN-")
  commodity  - the commodity/product name (e.g. MAIZE, WHEAT, SUNFLOWER, SOYA)
  date       - the date in YYYY-MM-DD format
  quantity   - the mass/quantity as a plain number (kg or tons as shown, no units)
  bags       - number of bags/units as a plain integer

Rules:
- Ignore header rows, totals rows, blank rows, and page numbers.
- If a column header is in Afrikaans (Produsent, Produk, Datum, Gewig, Sakke) map it to the English key.
- Dates: convert any format (DD/MM/YYYY, D-M-YY, etc.) to YYYY-MM-DD.
- Numbers: strip commas and spaces, return as number type not string.
- If a page has no table data, return an empty array [].
- Return ONLY the JSON array, nothing else.`;

async function parsePageWithVision(imagePath) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY env var not set');

  const imageData = fs.readFileSync(imagePath).toString('base64');

  const body = {
    model:      VISION_MODEL,
    max_tokens: 4096,
    system:     SYSTEM_PROMPT,
    messages: [{
      role:    'user',
      content: [
        {
          type:   'image',
          source: { type: 'base64', media_type: 'image/png', data: imageData },
        },
        {
          type: 'text',
          text: 'Extract all stock table rows from this page as JSON.',
        },
      ],
    }],
  };

  const response = await fetch(ANTHROPIC_URL, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data   = await response.json();
  const raw    = data.content?.[0]?.text?.trim() || '[]';

  // Strip any accidental markdown fences
  const clean  = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/,'').trim();

  try {
    const rows = JSON.parse(clean);
    return Array.isArray(rows) ? rows : [];
  } catch {
    console.error('[vision] JSON parse failed, raw response:', raw.slice(0, 300));
    return [];
  }
}

// ── Normalise rows into Firebase schema ───────────────────────────────────────
function normaliseEntries(rows, filenameDate, user) {
  return rows
    .filter(r => r && (r.producer || r.commodity || r.grn))
    .map((r, i) => ({
      id:         `${Date.now()}_${i}`,
      user,
      date:       r.date        || filenameDate || new Date().toISOString().slice(0, 10),
      producer:   String(r.producer  || '').trim(),
      grn:        String(r.grn       || '').trim(),
      commodity:  String(r.commodity || '').trim(),
      quantity:   Number(r.quantity) || 0,
      bags:       parseInt(r.bags)   || 0,
      source:     'vision',
      uploadedAt: new Date().toISOString(),
    }));
}

// ── POST /upload-stock ────────────────────────────────────────────────────────
app.post('/upload-stock', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (field: pdf)' });

  const tmpPdf = req.file.path;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdw-'));

  try {
    const origName          = req.file.originalname || req.file.filename;
    const { user, dateStr } = parseFilename(origName);
    const finalUser         = req.body.user || user;

    console.log(`[upload] "${origName}" → user=${finalUser} date=${dateStr}`);

    // 1. Convert PDF pages to PNG images
    const imageFiles = await pdfToImages(tmpPdf, tmpDir);
    console.log(`[upload] ${imageFiles.length} page(s) to process`);

    // 2. Send each page to Claude Vision (sequentially to avoid rate limits)
    const allRows = [];
    for (let i = 0; i < imageFiles.length; i++) {
      console.log(`[upload] Vision parsing page ${i + 1}/${imageFiles.length}…`);
      try {
        const rows = await parsePageWithVision(imageFiles[i]);
        console.log(`[upload] page ${i + 1}: ${rows.length} rows`);
        allRows.push(...rows);
      } catch (err) {
        console.error(`[upload] page ${i + 1} vision error:`, err.message);
        // Continue — don't fail the whole upload on one bad page
      }
    }

    // 3. Normalise
    const entries = normaliseEntries(allRows, dateStr, finalUser);
    console.log(`[upload] ${entries.length} valid entries total`);

    if (entries.length === 0) {
      return res.status(422).json({
        error: 'No stock rows found in this PDF',
        hint:  'Make sure the PDF contains a table with Producer / GRN / Commodity / Date / Quantity columns',
      });
    }

    // 4. Write to Firebase /stock/<user>/<id>
    const updates = {};
    for (const e of entries) updates[`/stock/${e.user}/${e.id}`] = e;
    await db.ref().update(updates);

    return res.json({ success: true, user: finalUser, date: dateStr, count: entries.length, entries });

  } catch (err) {
    console.error('[upload] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(tmpPdf, () => {});
    // Clean up temp image dir
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch {}
  }
});

// ── GET /stock/:user ──────────────────────────────────────────────────────────
app.get('/stock/:user', async (req, res) => {
  try {
    const { user } = req.params;
    const ref  = user === 'all' ? db.ref('/stock') : db.ref(`/stock/${user}`);
    const snap = await ref.once('value');
    return res.json(snap.val() || {});
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /stock/:user/:id ───────────────────────────────────────────────────
app.delete('/stock/:user/:id', async (req, res) => {
  try {
    await db.ref(`/stock/${req.params.user}/${req.params.id}`).remove();
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.send('jdw-sync alive'));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`jdw-sync listening on :${PORT} [vision parser]`));
