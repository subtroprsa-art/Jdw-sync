/**
 * jdw-sync
 * Watches the JHB Market Buyer History folder in Google Drive.
 * Every 5 minutes it reads any new sale slip PDFs, parses them,
 * and pushes the updated history + rebuilt affinity model to Firebase.
 */

const { google }  = require("googleapis");
const admin       = require("firebase-admin");
const cron        = require("node-cron");

const BUYER_HISTORY_FOLDER = process.env.DRIVE_BUYER_HISTORY_FOLDER_ID || "1DBmo42cx_YnQPqKOer1MFiH8onww5pZ6";
const FIREBASE_DB_URL      = process.env.FIREBASE_DATABASE_URL;
const POLL_MINUTES         = parseInt(process.env.POLL_MINUTES || "5");

// ── Robust JSON parser (handles mobile copy-paste issues) ────────────────────
function parseJSON(envVar, name) {
  try {
    let raw = (process.env[envVar] || "").trim();
    // remove any stray line breaks outside of string values
    // fix private_key escaped newlines
    raw = raw.replace(/\\\\n/g, "\\n");
    const obj = JSON.parse(raw);
    // ensure private_key has real newlines
    if (obj.private_key) {
      obj.private_key = obj.private_key.replace(/\\n/g, "\n");
    }
    console.log(`✅ Parsed ${name}`);
    return obj;
  } catch(e) {
    console.error(`❌ Could not parse ${name}: ${e.message}`);
    console.error(`   First 100 chars: ${(process.env[envVar]||"").substring(0,100)}`);
    throw e;
  }
}

// ── Firebase ─────────────────────────────────────────────────────────────────
let db;
function initFirebase() {
  if (db) return;
  const serviceAccount = parseJSON("FIREBASE_SERVICE_ACCOUNT", "Firebase credentials");
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: FIREBASE_DB_URL,
    });
  }
  db = admin.database();
  console.log("✅ Firebase connected to", FIREBASE_DB_URL);
}

// ── Google Drive ─────────────────────────────────────────────────────────────
let drive;
function initDrive() {
  if (drive) return;
  const credentials = parseJSON("GOOGLE_SERVICE_ACCOUNT", "Google credentials");
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  drive = google.drive({ version: "v3", auth });
  console.log("✅ Google Drive connected");
}

// ── Slip parser ───────────────────────────────────────────────────────────────
function parseCommodityLine(line) {
  line = (line || "").toUpperCase();
  let commodity = "UNK", variety = "*", count = "*";
  if      (line.includes("AVOCADO"))                       commodity = "AVOS";
  else if (line.includes("LEMON"))                         commodity = "LEMS";
  else if (line.includes("NAARTJ") || line.includes("HAARTJ")) commodity = "NAAR";
  else if (line.includes("ORANGE"))                        commodity = "ORGS";
  else if (line.includes("CLEMENTINE") || line.includes("CLTM")) commodity = "CLTM";
  else if (line.includes("KIWI"))                          commodity = "KIWI";
  else if (line.includes("STRAWB"))                        commodity = "STRS";
  else if (line.includes("FIG"))                           commodity = "FIGS";
  else if (line.includes("GUAVA"))                         commodity = "GVS";
  else if (line.includes("DRAGON"))                        commodity = "DRAG";
  else if (line.includes("SATSUM"))                        commodity = "NAAR";
  const varMatch = line.match(/\b(AF|AH|AK|MA|LR|HM|NV|M1|AE)\b/);
  if (varMatch) variety = varMatch[1];
  const cntMatch = line.match(/;(\d+|1X{1,3}|[LMSX]+);/);
  if (cntMatch) count = cntMatch[1];
  return { commodity, variety, count };
}

function parseSlip(snippet, filename) {
  if (!snippet) return [];
  const rows = [];
  const buyerMatch = snippet.match(/BUYER:\s*([^\n]+)/);
  const dateMatch  = snippet.match(/DATE:\s*(\d{2}\/[A-Z]+\/\d{4})/);
  const buyer      = buyerMatch ? buyerMatch[1].trim().replace(/\\/g,"").replace(/\[|\]/g,"") : "UNKNOWN";
  const months     = {JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12"};
  const dp         = dateMatch ? dateMatch[1].match(/(\d{2})\/([A-Z]+)\/(\d{4})/) : null;
  const date       = dp ? `${dp[1]}/${months[dp[2]]||"05"}/${dp[3]}` : "26/05/2026";

  const blocks = [...snippet.matchAll(/GRN:\s*(\d+)[\s\S]*?SALE\s+([\d,]+)\s*@\s*([\d.]+)/g)];
  for (const m of blocks) {
    const grn   = m[1];
    const qty   = parseInt(m[2].replace(/,/g,"")) || 0;
    const price = parseFloat(m[3]) || 0;
    // find commodity line just before this GRN block
    const grnPos  = snippet.indexOf(`GRN: ${grn}`);
    const before  = snippet.substring(Math.max(0, grnPos - 200), grnPos + 200);
    const commMatch = before.match(/\n([A-Z][A-Z ,;:\/*\d]+)\n/);
    const { commodity, variety, count } = parseCommodityLine(commMatch ? commMatch[1] : "");
    if (qty > 0) rows.push({ buyer, grn, commodity, variety, count, qty, price, date, src: filename });
  }
  return rows;
}

// ── Affinity model ────────────────────────────────────────────────────────────
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

// ── Main sync ─────────────────────────────────────────────────────────────────
async function sync() {
  console.log(`\n[${new Date().toISOString()}] 🔄 Sync started`);
  try {
    initFirebase();
    initDrive();

    const processedSnap = await db.ref("jdw/processedFiles").once("value");
    const processed = processedSnap.val() || {};

    const res = await drive.files.list({
      q: `'${BUYER_HISTORY_FOLDER}' in parents and mimeType = 'application/pdf'`,
      fields: "files(id,name,createdTime)",
      pageSize: 200,
      orderBy: "createdTime desc",
    });
    const files = res.data.files || [];
    console.log(`   Found ${files.length} PDFs in Drive`);

    const newFiles = files.filter(f => !processed[f.id]);
    console.log(`   ${newFiles.length} new files to process`);
    if (newFiles.length === 0) { console.log("   ✅ Nothing new"); return; }

    const histSnap = await db.ref("jdw/history").once("value");
    let history = histSnap.val() || [];
    if (!Array.isArray(history)) history = Object.values(history);

    let newRows = [];
    for (const file of newFiles) {
      try {
        const searchRes = await drive.files.list({
          q: `'${BUYER_HISTORY_FOLDER}' in parents and name = '${file.name}'`,
          fields: "files(id,name,contentHints/indexableText)",
          pageSize: 5,
        });
        const snippet = searchRes.data.files?.[0]?.contentHints?.indexableText || "";
        const rows = parseSlip(snippet, file.name);
        newRows = newRows.concat(rows);
        processed[file.id] = new Date().toISOString();
        console.log(`   ✅ ${file.name} → ${rows.length} rows (${rows[0]?.buyer || "no buyer found"})`);
      } catch(e) {
        console.warn(`   ⚠️  ${file.name}: ${e.message}`);
        processed[file.id] = "error";
      }
    }

    const existing = new Set(history.map(h => `${h.buyer}|${h.grn}|${h.date}`));
    const toAdd    = newRows.filter(r => !existing.has(`${r.buyer}|${r.grn}|${r.date}`));
    const updated  = [...history, ...toAdd];
    const model    = buildModel(updated);

    await db.ref("jdw").update({
      history:        updated,
      model:          model,
      processedFiles: processed,
      lastSync: { ts: new Date().toISOString(), newRows: toAdd.length, total: updated.length, buyers: Object.keys(model).length },
    });

    const logSnap = await db.ref("jdw/log").once("value");
    const log = Array.isArray(logSnap.val()) ? logSnap.val() : [];
    log.push({ ts: new Date().toLocaleTimeString("en-ZA"), user:"AUTO-SYNC", msg:`📥 ${toAdd.length} new tx · ${updated.length} total · ${Object.keys(model).length} buyers` });
    await db.ref("jdw/log").set(log.slice(-100));

    console.log(`   ✅ Done — ${toAdd.length} new rows | ${updated.length} total | ${Object.keys(model).length} buyers`);

  } catch(err) {
    console.error("❌ Sync error:", err.message);
  }
}

// ── Keep-alive ping (prevents Render free tier from sleeping) ─────────────────
const http = require("http");
http.createServer((req, res) => res.end("jdw-sync alive")).listen(process.env.PORT || 3000);

console.log(`🚀 jdw-sync starting — polling every ${POLL_MINUTES} min`);
sync();
cron.schedule(`*/${POLL_MINUTES} * * * *`, sync);
