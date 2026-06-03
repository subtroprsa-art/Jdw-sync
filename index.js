/**
 * jdw-sync v4
 * - Buyer History: watches folder, adds new slips incrementally
 * - Stock Scans: watches folder every 5 min + instant /trigger-stock endpoint
 *   Uses parse_stock_pdf.py (pdfplumber spatial parser)
 */

const { google }   = require("googleapis");
const admin        = require("firebase-admin");
const cron         = require("node-cron");
const http         = require("http");
const { execFile } = require("child_process");
const fs           = require("fs");
const os           = require("os");
const path         = require("path");

const BUYER_HISTORY_FOLDER = process.env.DRIVE_BUYER_HISTORY_FOLDER_ID || "1DBmo42cx_YnQPqKOer1MFiH8onww5pZ6";
const STOCK_SCANS_FOLDER   = process.env.DRIVE_STOCK_SCANS_FOLDER_ID   || "1DrYmim6xThu6KfKRplr5SDBVZc-BFMBm";
const FIREBASE_DB_URL      = process.env.FIREBASE_DATABASE_URL;
const POLL_MINUTES         = parseInt(process.env.POLL_MINUTES || "5");
const PARSER_SCRIPT        = path.join(__dirname, "parse_stock_pdf.py");
const TRIGGER_SECRET       = process.env.TRIGGER_SECRET || "jdw-trigger-2026";

// ── Seed history ─────────────────────────────────────────────────────────────
const SEED_HISTORY = [
  { buyer:"MANDELA MARKET",       grn:"15379866", commodity:"AVOS", variety:"AK", count:"8",  qty:30,  price:50,  date:"26/05/2026" },
  { buyer:"MANDELA MARKET",       grn:"15379857", commodity:"AVOS", variety:"AK", count:"10", qty:10,  price:50,  date:"26/05/2026" },
  { buyer:"MANDELA MARKET",       grn:"15379869", commodity:"AVOS", variety:"AK", count:"16", qty:120, price:50,  date:"26/05/2026" },
  { buyer:"MANDELA MARKET",       grn:"15444973", commodity:"AVOS", variety:"MA", count:"22", qty:164, price:70,  date:"26/05/2026" },
  { buyer:"DAY DREAMERS",         grn:"15440606", commodity:"AVOS", variety:"AF", count:"12", qty:60,  price:120, date:"26/05/2026" },
  { buyer:"DAY DREAMERS",         grn:"15428753", commodity:"KIWI", variety:"*",  count:"20", qty:2,   price:200, date:"26/05/2026" },
  { buyer:"SUNNINGHILL SUPER SP", grn:"15440606", commodity:"AVOS", variety:"AF", count:"12", qty:25,  price:120, date:"26/05/2026" },
  { buyer:"DE AGUIAR HELIO GOME", grn:"15440606", commodity:"AVOS", variety:"AF", count:"12", qty:30,  price:120, date:"26/05/2026" },
  { buyer:"PAULS FRUIT & VEG",    grn:"15416268", commodity:"LEMS", variety:"*",  count:"88", qty:2,   price:120, date:"26/05/2026" },
  { buyer:"PAULS FRUIT & VEG",    grn:"15428726", commodity:"NAAR", variety:"HM", count:"12", qty:5,   price:14,  date:"26/05/2026" },
  { buyer:"PAULS FRUIT & VEG",    grn:"15415663", commodity:"KIWI", variety:"*",  count:"20", qty:5,   price:160, date:"26/05/2026" },
  { buyer:"PAULS FRUIT & VEG",    grn:"15444988", commodity:"AVOS", variety:"AH", count:"*",  qty:5,   price:162, date:"26/05/2026" },
  { buyer:"WOMEGO SEYUM NUNO",    grn:"15429348", commodity:"NAAR", variety:"LR", count:"1X", qty:30,  price:70,  date:"26/05/2026" },
  { buyer:"GEBREYSUS KERIGA TEK", grn:"15397488", commodity:"AVOS", variety:"AH", count:"14", qty:84,  price:70,  date:"26/05/2026" },
  { buyer:"FLM SA (PTY) LTD",     grn:"15442214", commodity:"KIWI", variety:"*",  count:"20", qty:75,  price:240, date:"26/05/2026" },
  { buyer:"MUHACHA ABENITO JOAO", grn:"15444723", commodity:"STRS", variety:"*",  count:"16", qty:40,  price:640, date:"26/05/2026" },
  { buyer:"WELKOM MINI MARKET",   grn:"15415663", commodity:"KIWI", variety:"*",  count:"20", qty:37,  price:128, date:"26/05/2026" },
  { buyer:"FERREIRA TYRONE",      grn:"15444973", commodity:"AVOS", variety:"MA", count:"22", qty:8,   price:80,  date:"26/05/2026" },
  { buyer:"PIONEER FRESH",        grn:"15429339", commodity:"AVOS", variety:"AF", count:"14", qty:20,  price:100, date:"26/05/2026" },
  { buyer:"AFRICAN FRUIT CO",     grn:"15440606", commodity:"AVOS", variety:"AF", count:"12", qty:30,  price:100, date:"26/05/2026" },
  { buyer:"ALI ENDRIS",           grn:"15442587", commodity:"AVOS", variety:"AH", count:"20", qty:166, price:60,  date:"26/05/2026" },
  { buyer:"MUSTAFA AGMAT",        grn:"15421261", commodity:"NAAR", variety:"LR", count:"1X", qty:104, price:60,  date:"26/05/2026" },
  { buyer:"RANDGATE SPAR",        grn:"15429339", commodity:"AVOS", variety:"AF", count:"14", qty:10,  price:110, date:"26/05/2026" },
  { buyer:"ARGYROU SAVEWAYS",     grn:"15428726", commodity:"NAAR", variety:"HM", count:"12", qty:36,  price:10,  date:"26/05/2026" },
  { buyer:"KATOMPA MWAMBA",       grn:"15428721", commodity:"NAAR", variety:"HM", count:"15", qty:400, price:10,  date:"26/05/2026" },
  { buyer:"GARDENFRESH",          grn:"15442235", commodity:"FIGS", variety:"*",  count:"20", qty:5,   price:200, date:"26/05/2026" },
  { buyer:"SIBIYA SAM",           grn:"15387810", commodity:"AVOS", variety:"MA", count:"14", qty:26,  price:60,  date:"05/05/2026" },
  { buyer:"MM FOODS",             grn:"15373522", commodity:"FIGS", variety:"*",  count:"30", qty:5,   price:240, date:"05/05/2026" },
  { buyer:"PICK N PAY BRACKENH",  grn:"15401127", commodity:"KIWI", variety:"*",  count:"8",  qty:25,  price:160, date:"05/05/2026" },
  { buyer:"RIVERSIDE FRESH",      grn:"15391663", commodity:"AVOS", variety:"AH", count:"16", qty:50,  price:80,  date:"05/05/2026" },
  { buyer:"RIVERSIDE FRESH",      grn:"15340998", commodity:"AVOS", variety:"AH", count:"20", qty:20,  price:70,  date:"05/05/2026" },
  { buyer:"TROPICAPE FRUIT PACK", grn:"15400623", commodity:"STRS", variety:"*",  count:"16", qty:20,  price:640, date:"05/05/2026" },
  { buyer:"FLM SA (PTY) LTD",     grn:"15398683", commodity:"DRAG", variety:"*",  count:"10", qty:160, price:160, date:"05/05/2026" },
  { buyer:"ZAMAN MD OHEDUZ",      grn:"15400098", commodity:"LEMS", variety:"*",  count:"56", qty:10,  price:140, date:"05/05/2026" },
  { buyer:"SIESTA (PTY) LTD",     grn:"15391736", commodity:"FIGS", variety:"*",  count:"30", qty:2,   price:300, date:"05/05/2026" },
  { buyer:"GO FRESH HOSPITALITY", grn:"15400623", commodity:"STRS", variety:"*",  count:"16", qty:8,   price:640, date:"05/05/2026" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseJSON(envVar, name) {
  try {
    let raw = (process.env[envVar] || "").trim();
    raw = raw.replace(/\\\\n/g, "\\n");
    const obj = JSON.parse(raw);
    if (obj.private_key) obj.private_key = obj.private_key.replace(/\n/g, "\n");
    console.log(`✅ Parsed ${name}`);
    return obj;
  } catch(e) {
    console.error(`❌ Could not parse ${name}: ${e.message}`);
    throw e;
  }
}

function buildModel(history) {
  const m = {};
  for (const h of history) {
    const b = h.buyer;
    if (!b) continue;
    // Sanitise all fields — Firebase rejects undefined values
    const commodity = h.commodity || 'UNK';
    const variety   = h.variety   || '*';
    const count     = h.count     || h.size || '*';
    const qty       = Number(h.qty)   || 0;
    const price     = Number(h.price) || 0;
    const date      = h.date || '';

    const k = [commodity, variety, count].filter(v => v && v !== "*").join("|");
    if (!m[b]) m[b] = {};
    if (!m[b][k]) m[b][k] = { totalQty:0, txCount:0, priceSum:0, lastDate:"", commodity, variety, count };
    m[b][k].totalQty += qty;
    m[b][k].txCount  += 1;
    m[b][k].priceSum += price * qty;
    if (!m[b][k].lastDate || date > m[b][k].lastDate) m[b][k].lastDate = date;
  }
  for (const b of Object.keys(m))
    for (const k of Object.keys(m[b])) {
      const e = m[b][k];
      e.avgPrice = e.totalQty > 0 ? e.priceSum / e.totalQty : 0;
      e.score    = e.txCount * Math.log1p(e.totalQty);
      e.avgQty   = e.txCount > 0 ? Math.round(e.totalQty / e.txCount) : 0;
    }
  return m;
}

// ── Slip PDF parser ───────────────────────────────────────────────────────────
const SLIP_PARSER_SCRIPT = path.join(__dirname, "parse_slip_pdf.py");

function parseSlipPdf(pdfPath, filename) {
  return new Promise((resolve) => {
    if (!fs.existsSync(SLIP_PARSER_SCRIPT)) { console.warn("   ⚠️  parse_slip_pdf.py not found"); return resolve([]); }
    execFile("python3", [SLIP_PARSER_SCRIPT, pdfPath],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stderr) console.warn(`   ⚠️  slip parser stderr: ${stderr.trim().slice(0,200)}`);
        if (err) { console.error(`   ❌ Slip parser error: ${err.message}`); return resolve([]); }
        try {
          const rows = JSON.parse(stdout);
          if (!Array.isArray(rows)) return resolve([]);
          const results = rows.filter(r => r.buyer && r.grn && r.qty > 0).map(r => ({
            buyer:r.buyer, account:r.account||'', card:r.card||'', grn:r.grn,
            invoice:r.invoice||'', commodity:r.commodity||'UNK', variety:r.variety||'*',
            cls:r.cls||'1', size:r.size||'*', qty:r.qty, price:r.price,
            total:r.total, date:r.date, src:filename,
          }));
          console.log(`   ✅ Slip parser: ${results.length} rows from ${filename}`);
          resolve(results);
        } catch(e) { console.error(`   ❌ Slip JSON parse error: ${e.message}`); resolve([]); }
      }
    );
  });
}

function parseCommodityLine(line) {
  line = (line || "").toUpperCase();
  let commodity = "UNK", variety = "*", count = "*";
  if      (line.includes("AVOCADO"))    commodity = "AVOS";
  else if (line.includes("LEMON"))      commodity = "LEMS";
  else if (line.includes("NAARTJ") || line.includes("HAARTJ")) commodity = "NAAR";
  else if (line.includes("ORANGE"))     commodity = "ORGS";
  else if (line.includes("CLEMENTINE")) commodity = "CLTM";
  else if (line.includes("KIWI"))       commodity = "KIWI";
  else if (line.includes("STRAWB"))     commodity = "STRS";
  else if (line.includes("FIG"))        commodity = "FIGS";
  else if (line.includes("GUAVA"))      commodity = "GVS";
  else if (line.includes("DRAGON"))     commodity = "DRAG";
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
  const buyer  = buyerMatch ? buyerMatch[1].trim().replace(/\\/g,"").replace(/\[|\]/g,"") : "UNKNOWN";
  const months = {JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12"};
  const dp     = dateMatch ? dateMatch[1].match(/(\d{2})\/([A-Z]+)\/(\d{4})/) : null;
  const date   = dp ? `${dp[1]}/${months[dp[2]]||"05"}/${dp[3]}` : "26/05/2026";
  const blocks = [...snippet.matchAll(/GRN:\s*(\d+)[\s\S]*?SALE\s+([\d,]+)\s*@\s*([\d.]+)/g)];
  for (const m of blocks) {
    const grn   = m[1];
    const qty   = parseInt(m[2].replace(/,/g,"")) || 0;
    const price = parseFloat(m[3]) || 0;
    const grnPos = snippet.indexOf(`GRN: ${grn}`);
    const around = snippet.substring(Math.max(0,grnPos-200), grnPos+200);
    const commMatch = around.match(/\n([A-Z][A-Z ,;:\/*\d]+)\n/);
    const { commodity, variety, count } = parseCommodityLine(commMatch ? commMatch[1] : "");
    if (qty > 0) rows.push({ buyer, grn, commodity, variety, count, qty, price, date, src: filename });
  }
  return rows;
}

// ── Spatial stock PDF parser (pdfplumber) ─────────────────────────────────────
function parsePdfSpatial(pdfPath, filename, today) {
  return new Promise((resolve) => {
    if (!fs.existsSync(PARSER_SCRIPT)) { console.warn("   ⚠️  parse_stock_pdf.py not found"); return resolve([]); }
    execFile("python3", [PARSER_SCRIPT, pdfPath, "", today || ""],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (stderr) console.warn(`   ⚠️  parser stderr: ${stderr.trim().slice(0,200)}`);
        if (err) { console.error(`   ❌ Parser error: ${err.message}`); return resolve([]); }
        try {
          const rows = JSON.parse(stdout);
          if (!Array.isArray(rows)) return resolve([]);
          const results = rows
            .filter(r => r.producer || r.grn || r.commodity)
            .map(r => ({
              grn:        String(r.grn        || ""),
              producer:   String(r.producer   || ""),
              commodity:  String(r.commodity  || "UNK"),
              pack:       String(r.pack       || ""),
              variety:    String(r.variety    || "*"),
              grade:      String(r.grade      || "1"),
              size:       String(r.size       || "*"),
              count:      String(r.count      || "*"),
              flr:        Number(r.qty_sort)  || 0,
              rec:        Number(r.qty_rec)   || 0,
              arriveDate: r.date              || null,
              stockDate:  today,
              src:        filename,
            }))
            .filter(r => r.grn || r.producer);
          console.log(`   ✅ Spatial parser: ${results.length} rows from ${filename}`);
          resolve(results);
        } catch(e) { console.error(`   ❌ JSON parse error: ${e.message}`); resolve([]); }
      }
    );
  });
}

// ── Firebase & Drive init ─────────────────────────────────────────────────────
let db;
function initFirebase() {
  if (db) return;
  const sa = parseJSON("FIREBASE_SERVICE_ACCOUNT", "Firebase credentials");
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa), databaseURL: FIREBASE_DB_URL });
  db = admin.database();
  console.log("✅ Firebase connected");
}

let drive;
function initDrive() {
  if (drive) return;
  const creds = parseJSON("GOOGLE_SERVICE_ACCOUNT", "Google credentials");
  const auth  = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
  drive = google.drive({ version: "v3", auth });
  console.log("✅ Google Drive connected");
}

// ── Download PDF from Drive ───────────────────────────────────────────────────
async function downloadPdfToTemp(fileId, filename) {
  const tmpPath = path.join(os.tmpdir(), filename);
  try {
    const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    const buf = Buffer.from(res.data);
    fs.writeFileSync(tmpPath, buf);
    console.log(`   📥 Downloaded ${filename} (${buf.length} bytes)`);
    return tmpPath;
  } catch(e) {
    console.warn(`   ⚠️  Download failed for ${filename}: ${e.message}`);
    return null;
  }
}

// ── Process a single stock file and push to Firebase ─────────────────────────
async function processStockFile(fileId, filename) {
  const base = filename.toLowerCase().replace(".pdf","");
  let user = "unknown";
  if      (base.includes("riaan")) user = "RJ";
  else if (base.includes("cdw"))   user = "CW";
  else if (base.includes("pot"))   user = "POT";

  // Extract date from filename e.g. 03062026cdw.pdf → 03062026
  const dateMatch = filename.match(/^(\d{8})/);
  const today = dateMatch ? dateMatch[1] : todayStr();

  const tmpPath = await downloadPdfToTemp(fileId, filename);
  if (!tmpPath) throw new Error("Download failed");

  let rows = [];
  try {
    rows = await parsePdfSpatial(tmpPath, filename, today);
    rows.forEach(r => r.user = user);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  if (rows.length === 0) {
    console.log(`   ⚠️  No rows parsed from ${filename}`);
    return 0;
  }

  // Build Firebase payload keyed by GRN
  const stockByGrn = {};
  rows.forEach(r => {
    stockByGrn[r.grn] = {
      grn:        r.grn,
      producer:   r.producer,
      commodity:  r.commodity,
      pack:       r.pack       || "",
      variety:    r.variety    || "*",
      grade:      r.grade      || "1",
      size:       r.size       || "*",
      count:      r.count      || "*",
      qty_rec:    r.rec        || 0,
      qty_sort:   r.flr        || 0,
      date:       r.arriveDate || today,
      user:       user,
      source:     "drive",
      uploadedAt: new Date().toISOString(),
    };
  });

  // PUT replaces the salesman's entire stock with this file's data
  await db.ref(`stock/${user}`).set(stockByGrn);
  console.log(`   ✅ Stock pushed: /stock/${user} — ${rows.length} rows from ${filename}`);
  return rows.length;
}

// ── STOCK SYNC (polling — processes any unprocessed files) ────────────────────
function todayStr() {
  const d = new Date();
  return String(d.getDate()).padStart(2,"0") + String(d.getMonth()+1).padStart(2,"0") + d.getFullYear();
}

// Track processed file IDs in memory (resets on server restart — that's fine)
const processedStockFiles = new Set();

async function syncStock() {
  console.log("   📦 Checking stock scans...");
  try {
    const res = await drive.files.list({
      q: `'${STOCK_SCANS_FOLDER}' in parents and mimeType = 'application/pdf'`,
      fields: "files(id,name,createdTime)",
      pageSize: 200,
      orderBy: "createdTime asc",  // oldest first so newest wins
    });
    const allFiles  = res.data.files || [];
    const newFiles  = allFiles.filter(f => !processedStockFiles.has(f.id));

    if (newFiles.length === 0) { console.log("   ✅ No new stock files"); return; }
    console.log(`   🔄 Processing ${newFiles.length} new stock file(s)...`);

    for (const file of newFiles) {
      try {
        await processStockFile(file.id, file.name);
        processedStockFiles.add(file.id);
      } catch(e) {
        console.error(`   ❌ ${file.name}: ${e.message}`);
      }
    }
  } catch(e) {
    console.error("   ❌ Stock sync error:", e.message);
  }
}

// ── BUYER HISTORY SYNC ────────────────────────────────────────────────────────
async function syncBuyerHistory() {
  console.log("   🧾 Checking buyer history...");
  try {
    const processedSnap = await db.ref("jdw/processedFiles").once("value");
    const processed = processedSnap.val() || {};

    const res = await drive.files.list({
      q: `'${BUYER_HISTORY_FOLDER}' in parents and mimeType = 'application/pdf'`,
      fields: "files(id,name,createdTime)",
      pageSize: 200,
      orderBy: "createdTime desc",
    });
    const allFiles = res.data.files || [];
    const newFiles = allFiles.filter(f => !processed[f.id]);
    console.log(`   📂 Buyer History: ${allFiles.length} total, ${newFiles.length} new`);
    if (newFiles.length === 0) { console.log("   ✅ No new slips"); return; }

    const histSnap = await db.ref("jdw/history").once("value");
    let history = histSnap.val() || [];
    if (!Array.isArray(history)) history = Object.values(history);

    let newRows = [];
    for (const file of newFiles) {
      let tmpPath = null;
      try {
        tmpPath = await downloadPdfToTemp(file.id, file.name);
        let rows = [];
        if (tmpPath) rows = await parseSlipPdf(tmpPath, file.name);
        if (rows.length === 0) {
          console.warn(`   ⚠️  OCR parser got 0 rows for ${file.name}, trying indexableText`);
          const fileRes = await drive.files.get({ fileId: file.id, fields: "contentHints/indexableText" });
          const snippet = fileRes.data?.contentHints?.indexableText || "";
          rows = parseSlip(snippet, file.name);
        }
        newRows = newRows.concat(rows);
        processed[file.id] = new Date().toISOString();
        console.log(`   ✅ ${file.name} → ${rows.length} rows`);
      } catch(e) {
        console.warn(`   ⚠️  ${file.name}: ${e.message}`);
        processed[file.id] = "error";
      } finally {
        if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch {} }
      }
    }

    const existing = new Set(history.map(h => `${h.buyer}|${h.grn}|${h.date}`));
    const toAdd    = newRows.filter(r => !existing.has(`${r.buyer}|${r.grn}|${r.date}`));
    const updated  = [...history, ...toAdd];
    const model    = buildModel(updated);

    await db.ref("jdw").update({
      history: updated, model, processedFiles: processed,
      lastSync: { ts: new Date().toISOString(), newRows: toAdd.length, total: updated.length, buyers: Object.keys(model).length },
    });

    const logSnap = await db.ref("jdw/log").once("value");
    const log = Array.isArray(logSnap.val()) ? logSnap.val() : [];
    log.push({ ts: new Date().toLocaleTimeString("en-ZA"), user:"AUTO-SYNC", msg:`📥 ${toAdd.length} new tx · ${updated.length} total · ${Object.keys(model).length} buyers` });
    await db.ref("jdw/log").set(log.slice(-100));

    console.log(`   ✅ Buyer history: ${toAdd.length} new rows | ${updated.length} total`);
  } catch(e) {
    console.error("   ❌ Buyer history sync error:", e.message);
  }
}

// ── MAIN SYNC ─────────────────────────────────────────────────────────────────
async function sync() {
  console.log(`\n[${new Date().toISOString()}] 🔄 Sync started`);
  try {
    initFirebase();
    initDrive();

    const histSnap = await db.ref("jdw/history").once("value");
    let history = histSnap.val();
    if (!history || (Array.isArray(history) && history.length === 0)) {
      console.log("   📦 Seeding base buyer history...");
      const model = buildModel(SEED_HISTORY);
      await db.ref("jdw").update({ history: SEED_HISTORY, model, lastSync: { ts: new Date().toISOString(), newRows: SEED_HISTORY.length, total: SEED_HISTORY.length, buyers: Object.keys(model).length } });
      console.log(`   ✅ Seeded ${SEED_HISTORY.length} transactions`);
    }

    await syncBuyerHistory();
    await syncStock();
  } catch(err) {
    console.error("❌ Sync error:", err.message);
  }
}

// ── HTTP SERVER — keep-alive + /trigger-stock endpoint ────────────────────────
const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/") {
    return res.end("jdw-sync alive");
  }

  // Trigger endpoint — called by Apps Script when new stock PDF detected
  // POST /trigger-stock
  // Body: { secret, fileId, filename }
  if (req.method === "POST" && req.url === "/trigger-stock") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { secret, fileId, filename } = JSON.parse(body);

        if (secret !== TRIGGER_SECRET) {
          res.writeHead(403);
          return res.end(JSON.stringify({ error: "Unauthorized" }));
        }

        if (!fileId || !filename) {
          res.writeHead(400);
          return res.end(JSON.stringify({ error: "fileId and filename required" }));
        }

        console.log(`\n📡 Trigger received: ${filename} (${fileId})`);

        // Respond immediately so Apps Script doesn't time out
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "processing", filename }));

        // Process in background
        try {
          initFirebase();
          initDrive();
          const count = await processStockFile(fileId, filename);
          processedStockFiles.add(fileId);
          console.log(`   ✅ Trigger complete: ${filename} → ${count} rows`);
        } catch(e) {
          console.error(`   ❌ Trigger processing error: ${e.message}`);
        }

      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON: " + e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(process.env.PORT || 3000);
console.log(`🚀 jdw-sync v4 starting — polling every ${POLL_MINUTES} min + /trigger-stock endpoint`);
sync();
cron.schedule(`*/${POLL_MINUTES} * * * *`, sync);
