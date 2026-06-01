/**
 * jdw-sync — Express sync server
 * ────────────────────────────────
 * PDF parsing uses parse_stock_pdf.py (pdfplumber spatial parser).
 *
 * Endpoints:
 *   POST   /upload-stock        upload PDF → parse → append to Firebase
 *   POST   /clear-and-upload    upload PDF → wipe user's stock → write fresh
 *   DELETE /stock/:user         wipe ALL stock for a user (RJ, CW, or all)
 *   DELETE /stock/:user/:id     delete single entry
 *   GET    /stock/:user         read stock for user
 *   GET    /                    health check
 */

const express         = require('express');
const cors            = require('cors');
const multer          = require('multer');
const { execFile }    = require('child_process');
const path            = require('path');
const fs              = require('fs');
const os              = require('os');
const admin           = require('firebase-admin');

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
app.use(cors({
  origin: true,   // allow all origins
  methods: ['GET','POST','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: false,
}));
app.options('*', cors());  // handle preflight for all routes
app.use(express.json());

// ── Filename → user + date ────────────────────────────────────────────────────
// DDMMYYYYPOT.pdf → RJ   DDMMYYYYCDW.pdf → CW   DDMMYYYYriaan.pdf → RJ
function parseFilename(filename) {
  const base = path.basename(filename, '.pdf').toLowerCase();
  const m    = base.match(/^(\d{2})(\d{2})(\d{4})/);
  const dateStr = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  let user = 'unknown';
  if (base.includes('pot') || base.includes('riaan')) user = 'RJ';
  else if (base.includes('cdw'))                       user = 'CW';
  return { user, dateStr };
}

// ── Python spatial parser ─────────────────────────────────────────────────────
const PARSER = path.join(__dirname, 'parse_stock_pdf.py');

function parsePDF(pdfPath, user, dateStr) {
  return new Promise((resolve, reject) => {
    const args = [PARSER, pdfPath, user || '', dateStr || ''].filter(Boolean);
    execFile('python3', args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stderr) console.warn('[parser]', stderr.trim());
        if (err)    return reject(new Error(`Parser failed: ${stderr || err.message}`));
        try {
          const result = JSON.parse(stdout);
          if (result?.error) return reject(new Error(result.error));
          resolve(Array.isArray(result) ? result : []);
        } catch {
          reject(new Error('Parser returned non-JSON output'));
        }
      }
    );
  });
}

// ── Normalise into Firebase schema ────────────────────────────────────────────
function normaliseEntries(rows, filenameDate, user) {
  return rows
    .filter(r => r && (r.producer || r.grn || r.commodity))
    .map((r, i) => ({
      id:          `${Date.now()}_${i}`,
      user:        r._user  || user,
      date:        r.date   || filenameDate || new Date().toISOString().slice(0, 10),
      producer:    String(r.producer  || '').trim(),
      grn:         String(r.grn       || '').trim(),
      commodity:   String(r.commodity || '').trim(),
      qty_rec:     Number(r.qty_rec)  || 0,
      qty_sort:    Number(r.qty_sort) || 0,
      source:      'pdf',
      uploadedAt:  new Date().toISOString(),
    }));
}

// ── Shared upload handler ─────────────────────────────────────────────────────
async function handleUpload(req, res, clearFirst) {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded (field: pdf)' });

  const tmpPdf = req.file.path;
  try {
    const origName          = req.file.originalname || req.file.filename;
    const { user, dateStr } = parseFilename(origName);
    const finalUser         = req.body.user || user;

    console.log(`[upload] "${origName}" user=${finalUser} date=${dateStr} clearFirst=${clearFirst}`);

    // Optionally wipe existing stock first
    if (clearFirst) {
      await db.ref(`/stock/${finalUser}`).remove();
      console.log(`[upload] cleared existing stock for ${finalUser}`);
    }

    // Parse with Python
    const raw     = await parsePDF(tmpPdf, finalUser, dateStr);
    const entries = normaliseEntries(raw, dateStr, finalUser);
    console.log(`[upload] ${entries.length} entries`);

    if (entries.length === 0) {
      return res.status(422).json({
        error: 'No stock rows found in this PDF',
        hint:  'Make sure this is a JFPM Consignment Stock Take PDF',
      });
    }

    // Write to Firebase
    const updates = {};
    for (const e of entries) updates[`/stock/${e.user}/${e.id}`] = e;
    await db.ref().update(updates);

    return res.json({ success: true, user: finalUser, date: dateStr, count: entries.length, entries });

  } catch (err) {
    console.error('[upload] error:', err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(tmpPdf, () => {});
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Append new stock from PDF
app.post('/upload-stock', upload.single('pdf'), (req, res) => handleUpload(req, res, false));

// Wipe user's stock then upload fresh
app.post('/clear-and-upload', upload.single('pdf'), (req, res) => handleUpload(req, res, true));

// Read stock
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

// Wipe all stock for a user (or all users)
app.delete('/stock/:user', async (req, res) => {
  try {
    const { user } = req.params;
    const ref = user === 'all' ? db.ref('/stock') : db.ref(`/stock/${user}`);
    await ref.remove();
    console.log(`[clear] wiped stock for user=${user}`);
    return res.json({ success: true, user });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Delete single entry
app.delete('/stock/:user/:id', async (req, res) => {
  try {
    await db.ref(`/stock/${req.params.user}/${req.params.id}`).remove();
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Health
app.get('/', (_req, res) => res.send('jdw-sync alive'));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`jdw-sync listening on :${PORT}`));

// Built-in upload page — same domain, no CORS issues
app.get('/upload', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JDW Stock Upload</title>
<style>
body{font-family:sans-serif;max-width:500px;margin:40px auto;padding:16px;background:#0f1520;color:#c8d8e8}
h2{color:#7aeab4;margin-bottom:20px}
.box{background:#1a2232;border-radius:12px;padding:20px}
label{display:block;margin-bottom:8px;font-size:14px;color:#8ab0d0}
input[type=file]{color:#c8d8e8;width:100%;margin-bottom:16px;font-size:14px}
button{width:100%;padding:14px;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:10px}
.u{background:#2e7df7;color:#fff}
.c{background:#c0392b;color:#fff}
#st{margin-top:12px;font-size:14px;min-height:1.4em}
</style>
</head>
<body>
<h2>JDW Stock Upload</h2>
<div class="box">
  <label>Select PDF — POT.pdf=Riaan, CDW.pdf=Christoff, riaan.pdf=Riaan</label>
  <input type="file" id="f" accept=".pdf"/>
  <button class="u" onclick="go(false)">Upload</button>
  <button class="c" onclick="go(true)">🔄 Clear & Re-upload</button>
  <div id="st"></div>
</div>
<script>
async function go(clear){
  const f=document.getElementById('f').files[0];
  const s=document.getElementById('st');
  if(!f){s.textContent='Choose a PDF first';return;}
  s.style.color='#8ab0d0';
  s.textContent=clear?'Clearing & uploading...':'Uploading...';
  const form=new FormData();
  form.append('pdf',f,f.name);
  try{
    const r=await fetch('/'+(clear?'clear-and-upload':'upload-stock'),{method:'POST',body:form});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Failed');
    s.style.color='#7aeab4';
    s.textContent='Done! '+d.count+' entries loaded for '+d.user;
  }catch(e){
    s.style.color='#ff6b6b';
    s.textContent='Error: '+e.message;
  }
}
</script>
</body>
</html>`);
});
