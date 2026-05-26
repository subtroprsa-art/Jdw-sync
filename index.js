/**
 * jdw-sync
 * Watches the JHB Market Buyer History folder in Google Drive.
 * Every 5 minutes it reads any new sale slip PDFs, parses them,
 * and pushes the updated history + rebuilt affinity model to Firebase.
 * Runs forever on Railway / Render (free tier).
 */

const { google }       = require("googleapis");
const admin            = require("firebase-admin");
const cron             = require("node-cron");

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG  – set these as environment variables on Railway/Render
// ─────────────────────────────────────────────────────────────────────────────
const BUYER_HISTORY_FOLDER = process.env.DRIVE_BUYER_HISTORY_FOLDER_ID || "1DBmo42cx_YnQPqKOer1MFiH8onww5pZ6";
const STOCK_SCANS_FOLDER   = process.env.DRIVE_STOCK_SCANS_FOLDER_ID   || "1DrYmim6xThu6KfKRplr5SDBVZc-BFMBm";
const FIREBASE_DB_URL      = process.env.FIREBASE_DATABASE_URL;          // e.g. https://jdw-crm-default-rtdb.firebaseio.com
const POLL_MINUTES         = parseInt(process.env.POLL_MINUTES || "5");

// ─────────────────────────────────────────────────────────────────────────────
// FIREBASE INIT
// ─────────────────────────────────────────────────────────────────────────────
let db;
function initFirebase() {
  if (db) return;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: FIREBASE_DB_URL,
  });
  db = admin.database();
  console.log("✅ Firebase connected");
}

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE DRIVE INIT
// ─────────────────────────────────────────────────────────────────────────────
let drive;
function initDrive() {
  if (drive) return;
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  drive = google.drive({ version: "v3", auth });
  console.log("✅ Google Drive connected");
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSE SLIP SNIPPET
// Extracts buyer, GRN, commodity, variety, count, qty, price from Drive snippet
// ─────────────────────────────────────────────────────────────────────────────
function parseSlip(snippet, filename) {
  if (!snippet) return [];
  const rows = [];

  const buyerMatch   = snippet.match(/BUYER:\s*([^\n]+)/);
  const dateMatch    = snippet.match(/DATE:\s*(\d{2}\/[A-Z]+\/\d{4})/);
  const buyer        = buyerMatch  ? buyerMatch[1].trim().replace(/\\/g, "") : "UNKNOWN";
  const rawDate      = dateMatch   ? dateMatch[1] : "26/05/2026";

  // normalise date to DD/MM/YYYY
  const months = { JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",
                   JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12" };
  const dateParts = rawDate.match(/(\d{2})\/([A-Z]+)\/(\d{4})/);
  const date = dateParts
    ? `${dateParts[1]}/${months[dateParts[2]] || "05"}/${dateParts[3]}`
    : rawDate;

  // find all GRN blocks
  const grnBlocks = [...snippet.matchAll(/GRN:\s*(\d+)\s*\nPRODUCER:[^\n]+\n([^\n]+)\n[\s\S]*?SALE\s+([\d,]+)\s*@\s*([\d.]+)/g)];

  for (const m of grnBlocks) {
    const grn       = m[1];
    const commLine  = m[2].replace(/\\/g, "").replace(/\*;/g, "*,").trim();
    const qty       = parseInt(m[3].replace(/,/g, "")) || 0;
    const price     = parseFloat(m[4]) || 0;

    // parse commodity line e.g. "AVOCADOS, 4KG TRAY, AF;CL 1;*;12;*;4 KG/L"
    const { commodity, variety, count } = parseCommodityLine(commLine);

    if (qty > 0) {
      rows.push({ buyer, grn, commodity, variety, count, qty, price, date, src: filename });
    }
  }

  // fallback: simpler pattern
  if (rows.length === 0) {
    const simpleGrn   = snippet.match(/GRN:\s*(\d+)/);
    const simpleSale  = snippet.match(/SALE\s+([\d,]+)\s*@\s*([\d.]+)/);
    const simpleComm  = snippet.match(/\n([A-Z][A-Z ,;:/*\d]+)\n/);
    if (simpleGrn && simpleSale) {
      const grn   = simpleGrn[1];
      const qty   = parseInt(simpleSale[1].replace(/,/g, "")) || 0;
      const price = parseFloat(simpleSale[2]) || 0;
      const line  = simpleComm ? simpleComm[1] : "";
      const { commodity, variety, count } = parseCommodityLine(line);
      if (qty > 0) rows.push({ buyer, grn, commodity, variety, count, qty, price, date, src: filename });
    }
  }

  return rows;
}

function parseCommodityLine(line) {
  line = line.toUpperCase();
  let commodity = "UNK", variety = "*", count = "*";

  if      (line.includes("AVOCADO")) commodity = "AVOS";
  else if (line.includes("LEMON"))   commodity = "LEMS";
  else if (line.includes("NAARTJ"))  commodity = "NAAR";
  else if (line.includes("ORANGE"))  commodity = "ORGS";
  else if (line.includes("CLEMENTINE") || line.includes("CLTM")) commodity = "CLTM";
  else if (line.includes("KIWI"))    commodity = "KIWI";
  else if (line.includes("STRAWB"))  commodity = "STRS";
  else if (line.includes("FIG"))     commodity = "FIGS";
  else if (line.includes("GUAVA"))   commodity = "GVS";
  else if (line.includes("DRAGON"))  commodity = "DRAG";
  else if (line.includes("SATSUM"))  commodity = "NAAR";

  // variety: AF, AH, AK, MA, LR, HM, NV, M1 …
  const varMatch = line.match(/\b(AF|AH|AK|MA|LR|HM|NV|M1|AE)\b/);
  if (varMatch) variety = varMatch[1];

  // count: numeric or size codes
  const cntMatch = line.match(/;(\d+|1X{1,3}|[LMSX]+);/);
  if (cntMatch) count = cntMatch[1];

  return { commodity, variety, count };
}

// ─────────────────────────────────────────────────────────────────────────────
// AFFINITY MODEL BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function buildModel(history) {
  const m = {};
  for (const h of history) {
    const b = h.buyer;
    const k = [h.commodity, h.variety, h.count].filter(v => v && v !== "*").join("|");
    if (!m[b]) m[b] = {};
    if (!m[b][k]) m[b][k] = { totalQty:0, txCount:0, priceSum:0, lastDate:"", commodity:h.commodity, variety:h.variety, count:h.count };
    m[b][k].totalQty += h.qty;
    m[b][k].txCount  += 1;
    m[b][k].priceSum += h.price * h.qty;
    if (!m[b][k].lastDate || h.date > m[b][k].lastDate) m[b][k].lastDate = h.date;
  }
  for (const b of Object.keys(m))
    for (const k of Object.keys(m[b])) {
      const e = m[b][k];
      e.avgPrice = e.priceSum / e.totalQty;
      e.score    = e.txCount * Math.log1p(e.totalQty);
      e.avgQty   = Math.round(e.totalQty / e.txCount);
    }
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SYNC FUNCTION
// ─────────────────────────────────────────────────────────────────────────────
async function sync() {
  console.log(`\n[${new Date().toISOString()}] 🔄 Sync started`);
  try {
    initFirebase();
    initDrive();

    // 1. Get already-processed file IDs from Firebase
    const processedSnap = await db.ref("jdw/processedFiles").once("value");
    const processed = processedSnap.val() || {};

    // 2. List all PDFs in the Buyer History folder
    const res = await drive.files.list({
      q: `parentId = '${BUYER_HISTORY_FOLDER}' and mimeType = 'application/pdf'`,
      fields: "files(id,name,createdTime,description)",
      pageSize: 200,
      orderBy: "createdTime desc",
    });
    const files = res.data.files || [];
    console.log(`   Found ${files.length} PDFs in Drive`);

    // 3. Find new files
    const newFiles = files.filter(f => !processed[f.id]);
    console.log(`   ${newFiles.length} new files to process`);
    if (newFiles.length === 0) { console.log("   ✅ Nothing new"); return; }

    // 4. Get existing history from Firebase
    const histSnap = await db.ref("jdw/history").once("value");
    let history = histSnap.val() || [];
    if (!Array.isArray(history)) history = Object.values(history);

    // 5. Parse each new file's snippet (Drive search snippet is already extracted)
    // We re-fetch the file metadata to get the snippet
    let newRows = [];
    for (const file of newFiles) {
      try {
        const meta = await drive.files.get({
          fileId: file.id,
          fields: "id,name,description",
          supportsAllDrives: true,
        });
        // Drive snippet comes via search; for direct get we use the export
        // Use the files.export or just re-search for snippet
        const searchRes = await drive.files.list({
          q: `'${BUYER_HISTORY_FOLDER}' in parents and name = '${file.name}'`,
          fields: "files(id,name,contentHints/indexableText)",
          pageSize: 1,
        });
        const snippet = searchRes.data.files?.[0]?.contentHints?.indexableText || "";
        const rows = parseSlip(snippet, file.name);
        newRows = newRows.concat(rows);
        processed[file.id] = new Date().toISOString();
        console.log(`   ✅ ${file.name} → ${rows.length} rows (${rows[0]?.buyer || "?"})`);
      } catch (e) {
        console.warn(`   ⚠️  Could not parse ${file.name}: ${e.message}`);
        processed[file.id] = "error";
      }
    }

    if (newRows.length === 0) {
      console.log("   No parseable rows found in new files");
      await db.ref("jdw/processedFiles").set(processed);
      return;
    }

    // 6. Merge + deduplicate (by buyer+grn+date)
    const existing = new Set(history.map(h => `${h.buyer}|${h.grn}|${h.date}`));
    const toAdd    = newRows.filter(r => !existing.has(`${r.buyer}|${r.grn}|${r.date}`));
    const updated  = [...history, ...toAdd];

    // 7. Rebuild affinity model
    const model = buildModel(updated);

    // 8. Push everything to Firebase atomically
    await db.ref("jdw").update({
      history:        updated,
      model:          model,
      processedFiles: processed,
      lastSync: {
        ts:       new Date().toISOString(),
        newRows:  toAdd.length,
        total:    updated.length,
        buyers:   Object.keys(model).length,
      },
    });

    // 9. Log to shared log
    const logSnap = await db.ref("jdw/log").once("value");
    const log = Array.isArray(logSnap.val()) ? logSnap.val() : [];
    log.push({
      ts:   new Date().toLocaleTimeString("en-ZA"),
      user: "AUTO-SYNC",
      msg:  `📥 ${toAdd.length} new tx from ${newFiles.length} slips · ${updated.length} total · ${Object.keys(model).length} buyers`,
    });
    await db.ref("jdw/log").set(log.slice(-100));

    console.log(`   ✅ Pushed ${toAdd.length} new rows | ${updated.length} total | ${Object.keys(model).length} buyers`);

  } catch (err) {
    console.error("❌ Sync error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
console.log(`🚀 jdw-sync starting — polling every ${POLL_MINUTES} min`);
sync(); // run immediately on start
cron.schedule(`*/${POLL_MINUTES} * * * *`, sync);
