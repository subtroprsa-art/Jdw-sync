/**
 * jdw-sync v2
 * - Buyer History: watches folder, adds new slips incrementally
 * - Stock Scans: watches folder, always uses ONLY the latest day's PDFs
 *   (previous days are ignored — stock resets daily)
 */

const { google }  = require("googleapis");
const pdfParse   = require("pdf-parse");
const admin       = require("firebase-admin");
const cron        = require("node-cron");
const http        = require("http");

const BUYER_HISTORY_FOLDER = process.env.DRIVE_BUYER_HISTORY_FOLDER_ID || "1DBmo42cx_YnQPqKOer1MFiH8onww5pZ6";
const STOCK_SCANS_FOLDER   = process.env.DRIVE_STOCK_SCANS_FOLDER_ID   || "1DrYmim6xThu6KfKRplr5SDBVZc-BFMBm";
const FIREBASE_DB_URL      = process.env.FIREBASE_DATABASE_URL;
const POLL_MINUTES         = parseInt(process.env.POLL_MINUTES || "5");

// ── Seed history (base data) ─────────────────────────────────────────────────
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

// ── Helpers ──────────────────────────────────────────────────────────────────
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

// ── Commodity parser ─────────────────────────────────────────────────────────
function parseCommodityLine(line) {
  line = (line || "").toUpperCase();
  let commodity = "UNK", variety = "*", count = "*";
  if      (line.includes("AVOCADO"))  commodity = "AVOS";
  else if (line.includes("LEMON"))    commodity = "LEMS";
  else if (line.includes("NAARTJ") || line.includes("HAARTJ")) commodity = "NAAR";
  else if (line.includes("ORANGE"))   commodity = "ORGS";
  else if (line.includes("CLEMENTINE")) commodity = "CLTM";
  else if (line.includes("KIWI"))     commodity = "KIWI";
  else if (line.includes("STRAWB"))   commodity = "STRS";
  else if (line.includes("FIG"))      commodity = "FIGS";
  else if (line.includes("GUAVA"))    commodity = "GVS";
  else if (line.includes("DRAGON"))   commodity = "DRAG";
  else if (line.includes("SATSUM"))   commodity = "NAAR";
  const varMatch = line.match(/\b(AF|AH|AK|MA|LR|HM|NV|M1|AE)\b/);
  if (varMatch) variety = varMatch[1];
  const cntMatch = line.match(/;(\d+|1X{1,3}|[LMSX]+);/);
  if (cntMatch) count = cntMatch[1];
  return { commodity, variety, count };
}

// ── Buyer slip parser ────────────────────────────────────────────────────────
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

// ── Stock take parser ─────────────────────────────────────────────────────────
// Handles the JHB Market CONSIGNMENT STOCK TAKE PDF format.
// Each entry appears as: Producer\nGRN\nCOMMODITY\nQTY_REC\n[QTY_SOLD]\n[00FLR or merged]
// FLR is always the last numeric field. Leading-zero blocks encode multiple columns.
function parseStockPdf(snippet, filename, today) {
  if (!snippet) return [];
  const results = [];
  const lines = snippet.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);

  // pdf-parse reads columns left to right across the page
  // Layout: [all producers] [all GRNs] [all commodities] [all qtys]
  // We collect each type and zip them together

  const grns = [];
  const commodities = [];
  const producers = {};  // index -> producer name

  // First pass: find all GRNs and their indices
  const grnIndices = [];
  lines.forEach((line, idx) => {
    if (/^\d{8}$/.test(line)) {
      grns.push(line);
      grnIndices.push(idx);
    }
  });

  if (grns.length === 0) return [];

  // Find commodity strings (contain commas and start with letters)
  const commLines = [];
  lines.forEach((line, idx) => {
    if (/^[A-Z]{2,5},[A-Z0-9]+,/.test(line)) {
      commLines.push({ idx, line });
    }
  });

  // The GRNs and commodities should be in the same order
  // Match them by position: first N commodities match first N GRNs
  const minLen = Math.min(grns.length, commLines.length);

  // For each GRN, find producer (the non-numeric, non-header line just before the GRN block starts)
  // GRNs are consecutive - find where the GRN block starts
  const firstGrnIdx = grnIndices[0];
  
  // Producers appear before GRNs in groups
  // Look for producer names between the start and the GRN block
  // Actually from logs: producers appear BEFORE the whole GRN block
  // They are consecutive just like GRNs
  // Count: same number as GRNs
  
  // Find producer block: consecutive non-numeric, non-header lines just before GRNs
  const SKIP_WORDS = ['CONSIGNMENT','JOHANNESBURG','AGENT:','SALESMAN:','Version','Printed',
                       'Page','STOCK','R S A','GRN','COMMODITY','ARRIVE','COLD','SORT','SIT','RES',
                       'TRAN','D/R','QTY','FLR','REC','SOLD','MARKET','PRODUCE','FRESH'];
  
  const producerLines = [];
  for (let i = firstGrnIdx - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^\d/.test(l) || l.indexOf(',') > 0) break;
    if (l.length > 2 && !SKIP_WORDS.some(s => l.toUpperCase().includes(s))) {
      producerLines.unshift(l);
    }
  }

  // Collect quantity blocks after commodities
  // Each GRN has: REC, then a combined sold+flr number
  // Find number blocks after the last commodity
  const lastCommIdx = commLines.length > 0 ? commLines[commLines.length-1].idx : 0;
  
  const allNums = [];
  for (let i = lastCommIdx + 1; i < lines.length; i++) {
    const t = lines[i].replace(/,/g,'');
    if (/^\d+$/.test(t)) allNums.push(t);
  }

  function extractFLR(combined, rec) {
    combined = String(combined).replace(/,/g,'');
    const m = combined.match(/0{2,}(\d+)$/);
    if (m) return parseInt(m[1]) || 0;
    const m2 = combined.match(/0(\d{2,})$/);
    if (m2) { const c=parseInt(m2[1]); if(!rec||c<=rec) return c; }
    if (combined.length > 4 && rec) {
      for (const ln of [3,4,2]) {
        if (combined.length >= ln) {
          const c = parseInt(combined.slice(-ln).replace(/^0+/,'') || '0');
          if (c>=0 && c<=rec) return c;
        }
      }
    }
    return parseInt(combined) || 0;
  }

  // Each stock line uses 2 numbers: REC and SOLD+FLR combined (or 3: REC, SOLD, FLR)
  // Try to pair numbers with GRNs
  let numIdx = 0;
  for (let i = 0; i < minLen; i++) {
    const grn = grns[i];
    const commLine = commLines[i].line.replace(/\\/g,'');
    const parts = commLine.split(',');
    const commodity = parts[0] || 'UNK';
    const variety   = (parts[2] || '*').replace(/[\\]/g, '').trim();
    const count     = (parts[5] || '*').replace(/[\\]/g, '').trim();
    const producer  = producerLines[i] || '';

    // Get qty numbers for this entry
    const rec = parseInt((allNums[numIdx] || '0').replace(/,/g,'')) || 0;
    numIdx++;
    
    let flr = 0;
    // Check if next number(s) form the FLR
    if (numIdx < allNums.length) {
      const next = allNums[numIdx];
      flr = extractFLR(next, rec);
      numIdx++;
    }

    if (flr > 0 && commodity && /^[A-Z]/.test(commodity)) {
      results.push({ grn, producer, commodity, variety, count, flr, src: filename, stockDate: today });
    }
  }

  console.log(`   📊 parseStockPdf: ${results.length} lines from ${filename} (grns:${grns.length} comms:${commLines.length})`);
  return results;
}
// ── Firebase & Drive init ────────────────────────────────────────────────────
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

async function getSnippet(folderId, filename) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and name = '${filename}'`,
    fields: "files(id,name,contentHints/indexableText)",
    pageSize: 5,
  });
  const snippet = res.data.files?.[0]?.contentHints?.indexableText || "";
  if (snippet.length > 0) return snippet;
  // Fallback: download file and extract text
  const fileId = res.data.files?.[0]?.id;
  if (!fileId) return "";
  return await downloadPdfText(fileId);
}

async function getSnippetById(fileId) {
  const res = await drive.files.get({
    fileId,
    fields: "contentHints/indexableText",
  });
  const snippet = res.data?.contentHints?.indexableText || "";
  if (snippet.length > 0) return snippet;
  return await downloadPdfText(fileId);
}

async function downloadPdfText(fileId) {
  try {
    // Download raw PDF bytes
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const buffer = Buffer.from(res.data);
    // Parse PDF and extract text
    const data = await pdfParse(buffer);
    console.log(`   📄 PDF extracted: ${data.text.length} chars`);
    return data.text || "";
  } catch(e) {
    console.warn("   ⚠️  PDF parse failed for " + fileId + ": " + e.message);
    return "";
  }
}

// ── STOCK SYNC ───────────────────────────────────────────────────────────────
// Always replaces stock with today's files only. Ignores previous days.
function todayStr() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const yyyy = d.getFullYear();
  return dd + mm + yyyy;
}

async function syncStock() {
  console.log("   📦 Checking stock scans...");
  try {
    const today = todayStr(); // e.g. "26052026"

    // List all files in Stock Scans folder
    const res = await drive.files.list({
      q: `'${STOCK_SCANS_FOLDER}' in parents and mimeType = 'application/pdf'`,
      fields: "files(id,name,createdTime)",
      pageSize: 200,
      orderBy: "createdTime desc",
    });
    const allFiles = res.data.files || [];

    // Keep only files whose name starts with today's date
    const todayFiles = allFiles.filter(f => f.name.startsWith(today));
    console.log(`   📂 Stock Scans: ${allFiles.length} total, ${todayFiles.length} from today (${today})`);

    if (todayFiles.length === 0) {
      console.log("   ⚠️  No stock files for today yet — keeping previous stock");
      return;
    }

    // Always reprocess to pick up any parser improvements
    console.log(`   🔄 Processing stock for ${today}...`);
    // Clear stockDate to force reprocess
    await db.ref("jdw/stockDate").set(null);
    await db.ref("jdw/stockFileCount").set(null);

    // Parse all of today's stock PDFs
    let allStock = [];
    for (const file of todayFiles) {
      const snippet = await getSnippet(STOCK_SCANS_FOLDER, file.name);
      console.log(`   🔍 snippet(${file.name}): len=${snippet.length} | ${JSON.stringify(snippet.substring(0,200))}`);
      const rows    = parseStockPdf(snippet, file.name, today);
      allStock = allStock.concat(rows);
      console.log(`   ✅ ${file.name} → ${rows.length} stock lines`);
    }

    if (allStock.length === 0) {
      console.log("   ⚠️  Could not parse stock lines from today's PDFs");
      return;
    }

    // Push to Firebase — completely replaces previous stock
    await db.ref("jdw").update({
      stock:          allStock,
      stockDate:      today,
      stockFileCount: todayFiles.length,
      stockUpdated:   new Date().toISOString(),
    });

    // Log it
    const logSnap = await db.ref("jdw/log").once("value");
    const log = Array.isArray(logSnap.val()) ? logSnap.val() : [];
    log.push({ ts: new Date().toLocaleTimeString("en-ZA"), user:"AUTO-SYNC", msg:`📦 Stock updated: ${allStock.length} lines from ${todayFiles.length} PDFs (${today})` });
    await db.ref("jdw/log").set(log.slice(-100));

    console.log(`   ✅ Stock pushed: ${allStock.length} lines from ${todayFiles.length} files`);
  } catch(e) {
    console.error("   ❌ Stock sync error:", e.message);
  }
}

// ── BUYER HISTORY SYNC ───────────────────────────────────────────────────────
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
    const allFiles  = res.data.files || [];
    const newFiles  = allFiles.filter(f => !processed[f.id]);
    console.log(`   📂 Buyer History: ${allFiles.length} total, ${newFiles.length} new`);

    if (newFiles.length === 0) { console.log("   ✅ No new slips"); return; }

    const histSnap = await db.ref("jdw/history").once("value");
    let history = histSnap.val() || [];
    if (!Array.isArray(history)) history = Object.values(history);

    let newRows = [];
    for (const file of newFiles) {
      try {
        const snippet = await getSnippet(BUYER_HISTORY_FOLDER, file.name);
        const rows    = parseSlip(snippet, file.name);
        newRows = newRows.concat(rows);
        processed[file.id] = new Date().toISOString();
        console.log(`   ✅ ${file.name} → ${rows.length} rows (${rows[0]?.buyer || "?"})`);
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
      history, model, processedFiles: processed,
      lastSync: { ts: new Date().toISOString(), newRows: toAdd.length, total: updated.length, buyers: Object.keys(model).length },
    });

    const logSnap = await db.ref("jdw/log").once("value");
    const log = Array.isArray(logSnap.val()) ? logSnap.val() : [];
    log.push({ ts: new Date().toLocaleTimeString("en-ZA"), user:"AUTO-SYNC", msg:`📥 ${toAdd.length} new tx · ${updated.length} total · ${Object.keys(model).length} buyers` });
    await db.ref("jdw/log").set(log.slice(-100));

    console.log(`   ✅ Buyer history: ${toAdd.length} new rows | ${updated.length} total | ${Object.keys(model).length} buyers`);
  } catch(e) {
    console.error("   ❌ Buyer history sync error:", e.message);
  }
}

// ── MAIN SYNC ────────────────────────────────────────────────────────────────
async function sync() {
  console.log(`\n[${new Date().toISOString()}] 🔄 Sync started`);
  try {
    initFirebase();
    initDrive();

    // Seed buyer history if empty
    const histSnap = await db.ref("jdw/history").once("value");
    let history = histSnap.val();
    if (!history || (Array.isArray(history) && history.length === 0)) {
      console.log("   📦 Seeding base buyer history...");
      const model = buildModel(SEED_HISTORY);
      await db.ref("jdw").update({ history: SEED_HISTORY, model, lastSync: { ts: new Date().toISOString(), newRows: SEED_HISTORY.length, total: SEED_HISTORY.length, buyers: Object.keys(model).length } });
      console.log(`   ✅ Seeded ${SEED_HISTORY.length} transactions`);
    }

    // Run both syncs
    await syncBuyerHistory();
    await syncStock();

  } catch(err) {
    console.error("❌ Sync error:", err.message);
  }
}

// ── Keep-alive server ────────────────────────────────────────────────────────
http.createServer((req, res) => res.end("jdw-sync alive")).listen(process.env.PORT || 3000);

console.log(`🚀 jdw-sync v2 starting — polling every ${POLL_MINUTES} min`);
sync();
cron.schedule(`*/${POLL_MINUTES} * * * *`, sync);
