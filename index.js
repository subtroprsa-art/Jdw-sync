/**
 * jdw-sync v6
 * - Stock Scans: watches folder every 5 min + instant /trigger-stock endpoint
 * - AI Match: Gemini 2.5 Flash via /ai-match endpoint
 */

const { google }   = require("googleapis");
const admin        = require("firebase-admin");
const http         = require("http");
const cron         = require("node-cron");
const https        = require("https");

const { execFile } = require("child_process");
const fs           = require("fs");
const os           = require("os");
const path         = require("path");

const BUYER_HISTORY_FOLDER = process.env.DRIVE_BUYER_HISTORY_FOLDER_ID || "1DBmo42cx_YnQPqKOer1MFiH8onww5pZ6";
const STOCK_SCANS_FOLDER   = process.env.DRIVE_STOCK_SCANS_FOLDER_ID   || "1DrYmim6xThu6KfKRplr5SDBVZc-BFMBm";
const FLOOR_BALANCE_FOLDER = process.env.DRIVE_FLOOR_BALANCE_FOLDER_ID || "";
const FIREBASE_DB_URL      = process.env.FIREBASE_DATABASE_URL;
const PARSER_SCRIPT        = path.join(__dirname, "parse_stock_pdf.py");
const FLOOR_PARSER_SCRIPT  = path.join(__dirname, "parse_floor_pdf.py");
const TRIGGER_SECRET       = process.env.TRIGGER_SECRET || "jdw-trigger-2026";

// Commodity full names
const COMM_NAMES = {
  AVOS:"Avocados", LEMS:"Lemons", FIGS:"Figs", KIWI:"Kiwifruit",
  ORGS:"Oranges", GVS:"Guavas", CLTM:"Clementines", NAAR:"Naartjies",
  STRS:"Strawberries", MANG:"Mangoes", DRAG:"Dragon Fruit", GFT:"Grapefruit",
  SATS:"Satsumas", PAPO:"Papino",
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

// ── Process a single floor balance file and push to Firebase ──────────────────
async function processFloorFile(fileId, filename) {
  const base = filename.toLowerCase().replace(".pdf","");
  let user = "unknown";
  if      (base.includes("riaan") || base.includes("rj")) user = "RJ";
  else if (base.includes("cdw")   || base.includes("christoff")) user = "CW";
  else if (base.includes("pot"))  user = "POT";

  const dateMatch = filename.match(/(\d{8})/);
  const today = dateMatch ? dateMatch[1] : todayStr();

  const tmpPath = await downloadPdfToTemp(fileId, filename);
  if (!tmpPath) throw new Error("Download failed");

  let rows = [];
  try {
    rows = await new Promise((resolve) => {
      if (!fs.existsSync(FLOOR_PARSER_SCRIPT)) { console.warn("   ⚠️  parse_floor_pdf.py not found"); return resolve([]); }
      execFile("python3", [FLOOR_PARSER_SCRIPT, tmpPath, user, today],
        { timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (stderr) console.warn(`   ⚠️  floor parser stderr: ${stderr.trim().slice(0,200)}`);
          if (err) { console.error(`   ❌ Floor parser error: ${err.message}`); return resolve([]); }
          try { resolve(JSON.parse(stdout)); } catch(e) { console.error(`   ❌ Floor JSON parse: ${e.message}`); resolve([]); }
        }
      );
    });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  if (rows.length === 0) { console.log(`   ⚠️  No rows from floor file ${filename}`); return 0; }

  // Key by GRN+SEQ to avoid duplicates
  const floorByKey = {};
  rows.forEach(r => { floorByKey[r.grn + '_' + r.seq] = r; });

  await db.ref(`floor/${user}`).set(floorByKey);
  console.log(`   ✅ Floor pushed: /floor/${user} — ${rows.length} rows from ${filename}`);
  return rows.length;
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

  // ── CORS preflight (must be first) ─────────────────────────────────────────
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
    });
    return res.end();
  }

  // ── Health check ───────────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/") {
    return res.end("jdw-sync v10 alive");
  }

  // ── Trigger stock sync ─────────────────────────────────────────────────────
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

  // ── Trigger floor balance sync ────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/trigger-floor") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { secret, fileId, filename } = JSON.parse(body);
        if (secret !== TRIGGER_SECRET) { res.writeHead(403); return res.end(JSON.stringify({ error: "Unauthorized" })); }
        if (!fileId || !filename) { res.writeHead(400); return res.end(JSON.stringify({ error: "fileId and filename required" })); }
        console.log(`\n📡 Floor trigger received: ${filename} (${fileId})`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "processing", filename }));
        try {
          initFirebase();
          initDrive();
          const count = await processFloorFile(fileId, filename);
          console.log(`   ✅ Floor trigger complete: ${filename} → ${count} rows`);
        } catch(e) {
          console.error(`   ❌ Floor trigger error: ${e.message}`);
        }
      } catch(e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON: " + e.message }));
      }
    });
    return;
  }

  // ── AI Match endpoint ──────────────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/ai-match") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { prompt } = JSON.parse(body);

        if (!prompt) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "prompt required" }));
        }

        const GEMINI_KEY = process.env.GEMINI_API_KEY;
        if (!GEMINI_KEY) {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "GEMINI_API_KEY not set on server" }));
        }

        // Model cascade: try 2.5-flash first, fall back to 1.5-flash if unavailable
        const MODELS = [
          "gemini-2.5-flash",
          "gemini-2.5-flash-lite",
          "gemini-3.5-flash",
        ];
        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 2000;

        // Promisified single Gemini call
        function callGemini(model, payload) {
          return new Promise((resolve, reject) => {
            const options = {
              hostname: "generativelanguage.googleapis.com",
              path:     `/v1beta/models/${model}:generateContent`,
              method:   "POST",
              headers: {
                "Content-Type":   "application/json",
                "x-goog-api-key": GEMINI_KEY,
                "Content-Length": Buffer.byteLength(payload)
              }
            };
            const apiReq = https.request(options, (apiRes) => {
              let data = "";
              apiRes.on("data", chunk => data += chunk);
              apiRes.on("end", () => {
                try {
                  resolve({ parsed: JSON.parse(data), raw: data });
                } catch(e) {
                  reject(new Error("JSON parse error: " + e.message + " | raw: " + data.slice(0, 300)));
                }
              });
            });
            apiReq.on("error", (e) => reject(new Error("Network error: " + e.message)));
            apiReq.write(payload);
            apiReq.end();
          });
        }

        function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

        const payload = JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 3000, temperature: 0.1, response_mime_type: "application/json" },
          systemInstruction: { parts: [{ text: "You are a JSON API. Respond with valid JSON only. No markdown, no explanation, no text before or after the JSON object." }] }
        });

        let lastError = null;

        for (const model of MODELS) {
          for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
              console.log(`   🤖 Gemini attempt ${attempt}/${MAX_RETRIES} with ${model}`);
              const { parsed: geminiResp } = await callGemini(model, payload);

              // 503 / UNAVAILABLE — retryable
              if (geminiResp.error?.code === 503 || geminiResp.error?.status === "UNAVAILABLE") {
                lastError = `${model} unavailable (503)`;
                console.warn(`   ⚠️  ${lastError} — attempt ${attempt}/${MAX_RETRIES}`);
                if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
                continue; // retry same model
              }

              // Any other Gemini error — not retryable, try next model
              if (geminiResp.error) {
                lastError = `${model}: ${geminiResp.error.message} (${geminiResp.error.status})`;
                console.error(`   ❌ Gemini error on ${model}:`, JSON.stringify(geminiResp.error));
                break; // skip remaining retries, try next model
              }

              const text = geminiResp.candidates?.[0]?.content?.parts?.[0]?.text || "";

              if (!text) {
                const reason = geminiResp.candidates?.[0]?.finishReason || "unknown";
                lastError = `${model} empty response, finishReason: ${reason}`;
                console.warn(`   ⚠️  ${lastError}`);
                break; // try next model
              }

              // ✅ Gemini responded — validate JSON server-side
              // If JSON is invalid (truncated), treat as a retryable error
              console.log(`   ✅ Gemini success with ${model} (attempt ${attempt})`);
              let parsed;
              try {
                let s = text.replace(/```json\s*/gi,'').replace(/```\s*/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').trim();
                let start = s.indexOf('{'), end = s.lastIndexOf('}');
                if (start === -1 || end <= start) throw new Error('No JSON object found');
                let jsonStr = s.slice(start, end + 1).replace(/,\s*([\]\}])/g, '$1');
                parsed = JSON.parse(jsonStr);
                if (!parsed.matches || !Array.isArray(parsed.matches)) throw new Error('Missing matches array');
                console.log(`   ✅ Server JSON parse OK — ${parsed.matches.length} matches`);
              } catch(parseErr) {
                lastError = `JSON invalid: ${parseErr.message}`;
                console.error(`   ❌ ${model} attempt ${attempt} JSON error: ${parseErr.message}`);
                if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
                break; // exhausted retries for this model, try next
              }
              // Send clean re-encoded JSON — no bad chars can reach the browser
              res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
              return res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(parsed) }], model, preparse: true }));

            } catch(e) {
              lastError = e.message;
              console.error(`   ❌ ${model} attempt ${attempt} threw: ${e.message}`);
              if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
            }
          }
        }

        // All models and retries exhausted
        console.error("   ❌ All Gemini models exhausted. Last error:", lastError);
        res.writeHead(503, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "AI unavailable — all models exhausted. Last error: " + lastError }));

      } catch(e) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Invalid JSON: " + e.message }));
      }
    });
    return;
  }



  // ── PROCESS COLDSTORE SLIP (auto-detects type) ────────────────────────────
  if (req.method === "POST" && req.url === "/process-coldstore-slip") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { secret, fileId, filename } = JSON.parse(body);
        if (secret !== TRIGGER_SECRET) { res.writeHead(403); return res.end(JSON.stringify({ error: "Unauthorized" })); }
        if (!fileId) { res.writeHead(400); return res.end(JSON.stringify({ error: "fileId required" })); }

        console.log(`\n❄️  Coldstore slip received: ${filename}`);

        initDrive();
        const fileMeta = await drive.files.get({ fileId, fields: "mimeType,name" });
        const imageRes = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
        const base64Image = Buffer.from(imageRes.data).toString("base64");
        const mimeType = fileMeta.data.mimeType;

        const geminiKey = process.env.GEMINI_API_KEY;
        const prompt = `This is a Johannesburg Fresh Produce Market slip. There are 4 possible slip types:
1. "STOCK TRANSFER TO IN-TRANSIT FOR DEPOSIT INTO COLDSTORE" - deposit initiated
2. "STOCK DEPOSIT INTO COLD STORE" - deposit confirmed (has QTY SENT and QTY DEPOSITED)
3. "WITHDRAWAL REQUEST FROM COLD STORE" - withdrawal initiated (has WITHDRAWAL NO and ORIGINAL DEPOSIT NO)
4. "STOCK DEPOSIT ONTO AGENT FLOOR" - withdrawal confirmed, back on floor (has WITHDRAWAL NO, ORIGINAL DEPOSIT NO, QTY DEPOSITED)

First identify which slip type this is (1, 2, 3, or 4), then extract fields. Return ONLY valid JSON:
{
  "slipType": 1, 2, 3, or 4,
  "depositNo": "deposit number if present",
  "withdrawalNo": "withdrawal number if present (slip type 3 or 4 only)",
  "originalDepositNo": "original deposit number if present (slip type 3 or 4 only)",
  "grn": "GRN number",
  "date": "date as shown",
  "commodity": "commodity code: Avocados=AVOS, Lemons=LEMS, Oranges=ORGS, Naartjies=NAAR, Clementines=CLTM, Grapefruit=GFT, Strawberries=BERS, Kiwifruit=KIWI",
  "pack": "container/pack type",
  "variety": "variety",
  "grade": "class e.g. CL 1 or CL 2",
  "size": "size or * if asterisk",
  "count": "count number or empty",
  "producer": "producer name",
  "salesman": "salesman name",
  "qty": "the relevant quantity - QTY SENT/TRANSFERRED for slip 1, QTY DEPOSITED for slip 2, QTY REQUESTED for slip 3, QTY DEPOSITED for slip 4",
  "pallets": "number of pallets",
  "fromLocation": "from location",
  "toLocation": "to location"
}
Return ONLY the JSON object, no other text.`;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: prompt },
                  { inline_data: { mime_type: mimeType, data: base64Image } }
                ]
              }]
            })
          }
        );

        const geminiData = await geminiRes.json();
        const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        console.log("   Gemini raw response:", text.slice(0, 500));
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON in Gemini response. Raw text: " + text.slice(0, 200));
        const parsed = JSON.parse(jsonMatch[0]);

        const slipType = parseInt(parsed.slipType);
        parsed.filename = filename;
        parsed.fileId = fileId;
        parsed.processedAt = new Date().toISOString();

        initFirebase();
        const fb = require("firebase-admin");
        const db = fb.database();

        if (slipType === 1) {
          // Transfer initiated - create record with status "in_transit"
          const key = parsed.depositNo || Date.now().toString();
          await db.ref("coldstore/" + key).set({
            ...parsed,
            status: "in_transit",
            transferSlipAt: parsed.processedAt
          });
          console.log(`   ✅ Slip 1 (Transfer): Deposit ${parsed.depositNo} → in_transit`);
        }
        else if (slipType === 2) {
          // Deposit confirmed - update status to "active" (officially in coldstore)
          const key = parsed.depositNo || Date.now().toString();
          await db.ref("coldstore/" + key).update({
            ...parsed,
            status: "active",
            depositedAt: parsed.processedAt
          });
          console.log(`   ✅ Slip 2 (Deposit Confirmed): Deposit ${parsed.depositNo} → active`);
        }
        else if (slipType === 3) {
          // Withdrawal requested - update status to "withdrawal_pending"
          // Only update if the original deposit record actually exists (defensive check)
          const key = parsed.originalDepositNo;
          if (key) {
            const existing = await db.ref("coldstore/" + key).once("value");
            if (existing.exists()) {
              await db.ref("coldstore/" + key).update({
                status: "withdrawal_pending",
                withdrawalNo: parsed.withdrawalNo,
                withdrawalRequestedAt: parsed.processedAt
              });
              console.log(`   ✅ Slip 3 (Withdrawal Request): Deposit ${key} → withdrawal_pending`);
            } else {
              console.warn(`   ⚠️  Slip 3 (Withdrawal Request): No matching deposit ${key} found in coldstore — ignoring withdrawal, original deposit slip may be missing.`);
            }
          }
        }
        else if (slipType === 4) {
          // Floor deposit confirmed - mark as "removed" (back on floor)
          // Only update if the original deposit record actually exists (defensive check)
          const key = parsed.originalDepositNo;
          if (key) {
            const existing = await db.ref("coldstore/" + key).once("value");
            if (existing.exists()) {
              await db.ref("coldstore/" + key).update({
                status: "removed",
                removedAt: parsed.processedAt
              });
              console.log(`   ✅ Slip 4 (Floor Confirmed): Deposit ${key} → removed (back on floor)`);
            } else {
              console.warn(`   ⚠️  Slip 4 (Floor Confirmed): No matching deposit ${key} found in coldstore — ignoring, original deposit slip may be missing.`);
            }
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, slipType, data: parsed }));
      } catch(e) {
        console.error("❌ Coldstore slip error:", e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // ── 404 ────────────────────────────────────────────────────────────────────
  res.writeHead(404);
  res.end("Not found");
});

server.listen(process.env.PORT || 3000);
console.log("🚀 jdw-sync v10 starting — polling 04:00-12:00 every 30 min + instant /trigger-stock");
// Delay startup sync by 10s to allow service to fully start
setTimeout(sync, 10000);
// Poll every 30 min between 04:00 and 12:00 (Johannesburg time = UTC+2)
// Cron runs in UTC: 04:00 SAST = 02:00 UTC, 12:00 SAST = 10:00 UTC
cron.schedule("0,30 2-10 * * *", () => {
  console.log(`[${new Date().toISOString()}] ⏰ Scheduled poll`);
  sync();
});
