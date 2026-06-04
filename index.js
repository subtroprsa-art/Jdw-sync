/**
 * jdw-sync v5
 * - Stock Scans: watches folder every 5 min + instant /trigger-stock endpoint
 * - WhatsApp notifications via Twilio when stock matches buyer preferences 80%+
 */

const { google }   = require("googleapis");
const admin        = require("firebase-admin");
const cron         = require("node-cron");
const http         = require("http");
const https        = require("https");
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

// Twilio credentials
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID  || "ACf1c578a5fce1c345d9bd42984cbcd34c";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN    || "ba462ea910adeddb8d1d9e1a0e1475ad";
const TWILIO_FROM  = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

// Salesman contact numbers for the message
const SALESMAN_PHONES = {
  RJ:  "Riaan 084-516-4717",
  CW:  "Christoff 082-418-6030",
  POT: "George 082-418-6030",
};

// Commodity full names
const COMM_NAMES = {
  AVOS:"Avocados", LEMS:"Lemons", FIGS:"Figs", KIWI:"Kiwifruit",
  ORGS:"Oranges", GVS:"Guavas", CLTM:"Clementines", NAAR:"Naartjies",
  STRS:"Strawberries", MANG:"Mangoes", DRAG:"Dragon Fruit", GFT:"Grapefruit",
  SATS:"Satsumas", PAPO:"Papino",
};

const VARIETY_NAMES = {
  AF:"Fuerte", AH:"Hass", AK:"Pinkerton", MA:"Maluma", MD:"Dusa", NV:"Navel",
};

const PACK_NAMES = {
  TR040:"4KG Tray", BG150:"15KG Bag", BG160:"16KG Bag",
  CTT150:"15KG Carton", PTB005:"500G Punnet", PTB002:"160G Punnet",
  DL076:"DL 076 Carton", PC030:"3KG Pocket", PC060:"6KG Pocket",
};

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
  { buyer:"GEBREYSUS KERIGA TEK", grn:"15397488", commodity:"AVOS", variety:"AH", count:"14", qty:84,  price:70,  date:"26/05/2026" },
  { buyer:"FLM SA (PTY) LTD",     grn:"15442214", commodity:"KIWI", variety:"*",  count:"20", qty:75,  price:240, date:"26/05/2026" },
  { buyer:"WELKOM MINI MARKET",   grn:"15415663", commodity:"KIWI", variety:"*",  count:"20", qty:37,  price:128, date:"26/05/2026" },
  { buyer:"AFRICAN FRUIT CO",     grn:"15440606", commodity:"AVOS", variety:"AF", count:"12", qty:30,  price:100, date:"26/05/2026" },
  { buyer:"MUSTAFA AGMAT",        grn:"15421261", commodity:"NAAR", variety:"LR", count:"1X", qty:104, price:60,  date:"26/05/2026" },
  { buyer:"RANDGATE SPAR",        grn:"15429339", commodity:"AVOS", variety:"AF", count:"14", qty:10,  price:110, date:"26/05/2026" },
  { buyer:"KATOMPA MWAMBA",       grn:"15428721", commodity:"NAAR", variety:"HM", count:"15", qty:400, price:10,  date:"26/05/2026" },
  { buyer:"GO FRESH HOSPITALITY", grn:"15440606", commodity:"AVOS", variety:"AF", count:"12", qty:20,  price:100, date:"26/05/2026" },
  { buyer:"RIVERSIDE FRESH",      grn:"15429339", commodity:"AVOS", variety:"AF", count:"14", qty:15,  price:100, date:"26/05/2026" },
  { buyer:"FLM SA (PTY) LTD",     grn:"15398683", commodity:"DRAG", variety:"*",  count:"10", qty:160, price:160, date:"05/05/2026" },
  { buyer:"FLM SA (PTY) LTD",     grn:"15403543", commodity:"GVS",  variety:"*",  count:"L",  qty:200, price:50,  date:"05/05/2026" },
];

// ── Helper functions ──────────────────────────────────────────────────────────
function parseJSON(envVar, label) {
  const raw = process.env[envVar];
  if (!raw) throw new Error(`Missing env var: ${envVar} (${label})`);
  try { return JSON.parse(raw); }
  catch(e) { throw new Error(`Invalid JSON in ${envVar}: ${e.message}`); }
}

function todayStr() {
  const d = new Date();
  return String(d.getDate()).padStart(2,"0") + String(d.getMonth()+1).padStart(2,"0") + d.getFullYear();
}

// ── buildModel ────────────────────────────────────────────────────────────────
function buildModel(history) {
  const m = {};
  for (const h of history) {
    const b = h.buyer;
    if (!b) continue;
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

// ── Slip PDF parser (stub — handled by Apps Script) ───────────────────────────
function parseSlipPdf(pdfPath, filename) {
  return Promise.resolve([]);
}

function parseSlip(text, filename) { return []; }

// ── Spatial stock PDF parser ──────────────────────────────────────────────────
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

// ── WhatsApp via Twilio ───────────────────────────────────────────────────────
function sendWhatsApp(to, message) {
  return new Promise((resolve) => {
    const body = new URLSearchParams({ From: TWILIO_FROM, To: `whatsapp:${to}`, Body: message }).toString();
    const url  = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
    const options = {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Basic ${auth}`, "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`   📱 WhatsApp sent to ${to}`);
          resolve(true);
        } else {
          console.warn(`   ⚠️  WhatsApp failed (${res.statusCode}): ${data.slice(0,200)}`);
          resolve(false);
        }
      });
    });
    req.on("error", e => { console.warn(`   ⚠️  WhatsApp error: ${e.message}`); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ── Match score between a stock row and buyer history preference ──────────────
function calcMatchScore(stockRow, buyerPref) {
  // buyerPref: { commodity, variety, count/size, pack }
  if (stockRow.commodity !== buyerPref.commodity) return 0;

  let score = 40; // base for commodity match

  // Variety match (+20)
  if (buyerPref.variety && buyerPref.variety !== '*' && stockRow.variety !== '*') {
    if (stockRow.variety === buyerPref.variety) score += 20;
    else score -= 10;
  } else {
    score += 10; // open variety — partial credit
  }

  // Size match (+20)
  const stockSize = stockRow.size || stockRow.count || '*';
  const prefSize  = buyerPref.count || buyerPref.size || '*';
  if (prefSize !== '*' && stockSize !== '*') {
    if (stockSize === prefSize) score += 20;
    else score += 5; // close but not exact
  } else {
    score += 10;
  }

  // Pack match (+20)
  if (buyerPref.pack && buyerPref.pack !== '*' && stockRow.pack) {
    if (stockRow.pack === buyerPref.pack) score += 20;
    else score += 5;
  } else {
    score += 10;
  }

  return Math.min(score, 100);
}

// ── Notify buyers about matching new stock ────────────────────────────────────
async function notifyBuyers(newStockRows, user) {
  try {
    // Load buyer phones from Firebase
    const phonesSnap = await db.ref("buyerPhones").once("value");
    const phonesRaw  = phonesSnap.val() || {};
    // Build map: sanitised key → phone
    const phoneMap = {};
    for (const [key, val] of Object.entries(phonesRaw)) {
      if (val.buyerName && val.phone) {
        phoneMap[val.buyerName.toUpperCase()] = val.phone;
      }
    }

    if (Object.keys(phoneMap).length === 0) {
      console.log("   📵 No buyer phones in Firebase — skipping WhatsApp");
      return;
    }

    // Load buyer model from Firebase
    const modelSnap = await db.ref("jdw/model").once("value");
    const model = modelSnap.val() || {};

    // Track sent notifications today to avoid duplicates
    const today = new Date().toISOString().slice(0,10);
    const sentSnap = await db.ref(`jdw/whatsappSent/${today}`).once("value");
    const sent = sentSnap.val() || {};

    const salesman = SALESMAN_PHONES[user] || user;
    let notifCount = 0;

    for (const stockRow of newStockRows) {
      if (!stockRow.flr || stockRow.flr < 1) continue; // skip empty stock

      const commFull = COMM_NAMES[stockRow.commodity] || stockRow.commodity;
      const packFull = PACK_NAMES[stockRow.pack] || stockRow.pack || '';
      const varFull  = VARIETY_NAMES[stockRow.variety] || (stockRow.variety !== '*' ? stockRow.variety : '');
      const sizeStr  = stockRow.size && stockRow.size !== '*' ? `sz ${stockRow.size}` : '';

      for (const [buyerName, buyerPrefs] of Object.entries(model)) {
        const phone = phoneMap[buyerName.toUpperCase()];
        if (!phone) continue; // no phone for this buyer

        for (const [prefKey, pref] of Object.entries(buyerPrefs)) {
          if (pref.commodity !== stockRow.commodity) continue;

          const score = calcMatchScore(stockRow, pref);
          if (score < 80) continue;

          // Dedup key — one notification per buyer per commodity per day
          const dedupKey = `${buyerName}|${stockRow.commodity}|${stockRow.grn}`;
          if (sent[dedupKey.replace(/[.#$[\]/]/g,'_')]) continue;

          // Build message
          const parts = [commFull, varFull, packFull, sizeStr].filter(Boolean).join(', ');
          const message =
            `🌿 *SubTrop RSA — Fresh Stock Alert*\n\n` +
            `Hi! Fresh *${parts}* just arrived at JHB Fresh Produce Market.\n\n` +
            `Floor stock: *${stockRow.flr} units*\n` +
            `Contact: ${salesman}\n\n` +
            `_This is an automated stock alert from SubTrop RSA_`;

          console.log(`   📱 Notifying ${buyerName} (${phone}) — ${commFull} match ${score}%`);
          const ok = await sendWhatsApp(phone, message);

          if (ok) {
            // Mark as sent
            const safeKey = dedupKey.replace(/[.#$[\]/]/g,'_');
            await db.ref(`jdw/whatsappSent/${today}/${safeKey}`).set({
              buyer: buyerName, commodity: stockRow.commodity,
              grn: stockRow.grn, score, ts: new Date().toISOString()
            });
            notifCount++;
          }
          break; // one notification per buyer per stock row
        }
      }
    }

    if (notifCount > 0) console.log(`   ✅ Sent ${notifCount} WhatsApp notifications`);
    else console.log("   ℹ️  No new WhatsApp notifications to send");

  } catch(e) {
    console.error("   ❌ WhatsApp notify error:", e.message);
  }
}

// ── Process a single stock file and push to Firebase ─────────────────────────
async function processStockFile(fileId, filename) {
  const base = filename.toLowerCase().replace(".pdf","");
  let user = "unknown";
  if      (base.includes("riaan")) user = "RJ";
  else if (base.includes("cdw"))   user = "CW";
  else if (base.includes("pot"))   user = "POT";

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

  await db.ref(`stock/${user}`).set(stockByGrn);
  console.log(`   ✅ Stock pushed: /stock/${user} — ${rows.length} rows from ${filename}`);

  // Send WhatsApp notifications for matching buyers
  await notifyBuyers(rows, user);

  return rows.length;
}

// ── STOCK SYNC ────────────────────────────────────────────────────────────────
const processedStockFiles = new Set();

async function syncStock() {
  console.log("   📦 Checking stock scans...");
  try {
    const res = await drive.files.list({
      q: `'${STOCK_SCANS_FOLDER}' in parents and mimeType = 'application/pdf'`,
      fields: "files(id,name,createdTime)",
      pageSize: 200,
      orderBy: "createdTime asc",
    });
    const allFiles = res.data.files || [];
    const newFiles = allFiles.filter(f => !processedStockFiles.has(f.id));

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

    // Buyer history handled by Apps Script
    await syncStock();
  } catch(err) {
    console.error("❌ Sync error:", err.message);
  }
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    return res.end("jdw-sync v5 alive");
  }

  if (req.method === "POST" && req.url === "/trigger-stock") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { secret, fileId, filename } = JSON.parse(body);
        if (secret !== TRIGGER_SECRET) { res.writeHead(403); return res.end(JSON.stringify({ error: "Unauthorized" })); }
        if (!fileId || !filename) { res.writeHead(400); return res.end(JSON.stringify({ error: "fileId and filename required" })); }
        console.log(`\n📡 Trigger received: ${filename} (${fileId})`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "processing", filename }));
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
console.log(`🚀 jdw-sync v5 starting — polling every ${POLL_MINUTES} min + /trigger-stock + WhatsApp notifications`);
sync();
cron.schedule(`*/${POLL_MINUTES} * * * *`, sync);
