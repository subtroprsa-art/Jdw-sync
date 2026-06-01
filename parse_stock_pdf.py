#!/usr/bin/env python3
"""
JDW Stock PDF Parser  v3
=========================
Handles the Johannesburg Fresh Produce Market "CONSIGNMENT STOCK TAKE" format.

Column layout (detected from real PDF):
  x < 155   → PRODUCER  (multi-word, joined by space)
  155–210   → GRN NO    (8-digit number)
  210–355   → COMMODITY (e.g. AVOS,BG150,AF,2,M,*,*)
  355–440   → DATE      (DD/MON/YYYY)
  440–480   → QTY REC
  480–525   → QTY SOLD
  610–640   → QTY SORT  (FLR / remaining)
  (other qty columns ignored)

Strategy:
  1. Try hardcoded X-band column mapping (best for this specific format)
  2. Fall back to pdfplumber extract_table text strategy
  3. Fall back to word-cluster spatial detection

Usage:  python3 parse_stock_pdf.py <path.pdf> [username] [YYYY-MM-DD]
Output: JSON array to stdout. Errors to stderr, exit 1.
"""

import sys, json, re
import pdfplumber
from collections import defaultdict

# ── Hardcoded column bands for JFPM stocktake format ─────────────────────────
# Each tuple: (x_min, x_max, field_name)
JFPM_COLUMNS = [
    (  0,  155, 'producer'),
    (155,  215, 'grn'),
    (215,  360, 'commodity'),
    (355,  445, 'date'),
    (440,  480, 'qty_rec'),
    (480,  530, 'qty_sold'),
    (720,  780, 'qty_sort'),   # FLR remaining (rightmost column, x≈741)
]

HEADER_Y_MAX = 115   # skip anything above this (title, agent, salesman, column headers)
FOOTER_KEYWORDS = {'total', 'totaal', 'page', 'printed', 'agent:', 'salesman:', 'version'}


# ── Date normalisation ────────────────────────────────────────────────────────

MONTH_MAP = {
    'jan':'01','feb':'02','mar':'03','apr':'04','may':'05','jun':'06',
    'jul':'07','aug':'08','sep':'09','oct':'10','nov':'11','dec':'12',
}

def normalise_date(text):
    if not text:
        return None
    t = str(text).strip()
    # DD/MON/YYYY  e.g. 20/MAY/2026
    m = re.match(r'(\d{1,2})[/\-]([A-Za-z]{3})[/\-](\d{4})', t)
    if m:
        d, mon, y = m.group(1), m.group(2).lower(), m.group(3)
        mo = MONTH_MAP.get(mon, '00')
        return f"{y}-{mo}-{d.zfill(2)}"
    # YYYY-MM-DD or YYYY/MM/DD
    m = re.search(r'(\d{4})[/\-\.](\d{1,2})[/\-\.](\d{1,2})', t)
    if m:
        return f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"
    # DD/MM/YYYY
    m = re.search(r'(\d{1,2})[/\-\.](\d{1,2})[/\-\.](\d{2,4})', t)
    if m:
        d, mo, y = m.group(1), m.group(2), m.group(3)
        y = ('20' + y) if len(y) == 2 else y
        return f"{y}-{mo.zfill(2)}-{d.zfill(2)}"
    return t


def clean_number(text):
    if not text:
        return None
    t = re.sub(r'[,\s]', '', str(text).strip())
    try:
        v = float(t)
        return int(v) if v == int(v) else v
    except ValueError:
        return None


def parse_commodity(text):
    """Extract the commodity code (first part before comma) from AVOS,BG150,AF,..."""
    if not text:
        return text
    return text.split(',')[0].strip()


# ── Strategy 1: hardcoded X-band parsing ─────────────────────────────────────

def parse_jfpm_page(page, fallback_date=None):
    """
    Parse a JFPM stocktake page using hardcoded column X-band boundaries.
    Returns list of entry dicts.
    """
    words = page.extract_words(x_tolerance=4, y_tolerance=3,
                               keep_blank_chars=False, use_text_flow=False)
    if not words:
        return []

    # Debug: log first few word positions to help diagnose column issues
    data_words = [w for w in words if w['top'] > HEADER_Y_MAX]
    if data_words:
        sample = data_words[:3]
        print(f"  [debug] first data words: " + 
              " | ".join(f"x0={w['x0']:.0f} text={w['text']!r}" for w in sample),
              file=sys.stderr)

    # Group words by snapped Y row
    by_y = defaultdict(list)
    for w in words:
        if w['top'] <= HEADER_Y_MAX:
            continue
        # Skip footer/total rows
        if any(kw in w['text'].lower() for kw in FOOTER_KEYWORDS):
            continue
        by_y[round(w['top'] / 3) * 3].append(w)

    results = []
    for y in sorted(by_y):
        row_words = by_y[y]
        row = defaultdict(list)

        for w in row_words:
            x = w['x0']
            for x_min, x_max, field in JFPM_COLUMNS:
                if x_min <= x < x_max:
                    row[field].append(w['text'])
                    break

        if not row:
            continue

        producer  = ' '.join(row.get('producer', []))
        grn       = ' '.join(row.get('grn', []))
        commodity = ' '.join(row.get('commodity', []))
        date_raw  = ' '.join(row.get('date', []))
        qty_rec   = ' '.join(row.get('qty_rec', []))
        qty_sort  = ' '.join(row.get('qty_sort', []))

        # Must have at least a GRN or producer to be a valid row
        if not grn and not producer:
            continue
        # Skip if producer looks like a header keyword
        if producer.lower() in {'producer', 'produsent', 'agent', 'salesman'}:
            continue
        # Skip if grn is not numeric
        if grn and not re.match(r'^\d+$', grn.strip()):
            continue

        entry = {
            'producer':  producer.strip(),
            'grn':       grn.strip(),
            'commodity': parse_commodity(commodity),
            'date':      normalise_date(date_raw) or fallback_date,
            'qty_rec':   clean_number(qty_rec),
            'qty_sort':  clean_number(qty_sort),
        }
        results.append(entry)

    return results


# ── Strategy 2 & 3: generic fallbacks ────────────────────────────────────────

FIELD_ALIASES = {
    'producer':  ['producer', 'produsent', 'produser', 'boer', 'supplier'],
    'grn':       ['grn', 'gr no', 'gr.no', 'receipt', 'ontvangst'],
    'commodity': ['commodity', 'produk', 'product', 'item', 'description'],
    'date':      ['date', 'datum', 'arrive'],
    'quantity':  ['quantity', 'qty', 'mass', 'gewig', 'weight', 'kg', 'rec'],
    'bags':      ['bags', 'sakke', 'units', 'sort', 'flr'],
}

def header_to_field(text):
    t = re.sub(r'\s*\(.*?\)', '', text.lower().strip()).rstrip(':.')
    for field, aliases in FIELD_ALIASES.items():
        for alias in aliases:
            if alias in t or t in alias:
                return field
    return None

def detect_header(rows):
    for i, row in enumerate(rows):
        cells = [c for c in row if c and c.strip()]
        mapping = {}
        for j, cell in enumerate(row or []):
            if cell:
                f = header_to_field(cell)
                if f:
                    mapping[j] = f
        if len(mapping) >= 2:
            return i, mapping
    return -1, {}

def try_extract_table(page, strategy, fallback_date=None):
    try:
        table = page.extract_table({
            'vertical_strategy':      strategy,
            'horizontal_strategy':    strategy,
            'snap_tolerance':         5,
            'join_tolerance':         5,
            'intersection_tolerance': 5,
        })
    except Exception:
        return []
    if not table or len(table) < 2:
        return []
    header_idx, col_map = detect_header(table)
    if not col_map:
        n = max(len(r) for r in table)
        orders = {
            4: ['producer','commodity','date','quantity'],
            5: ['producer','grn','commodity','date','quantity'],
            6: ['producer','grn','commodity','date','quantity','bags'],
        }
        order = orders.get(n)
        if order:
            col_map = {i: f for i, f in enumerate(order)}
            header_idx = -1
    if not col_map:
        return []
    results = []
    for row in table[header_idx + 1:]:
        if not any(c and c.strip() for c in row):
            continue
        entry = {}
        for ci, field in col_map.items():
            if ci < len(row) and row[ci] and str(row[ci]).strip():
                entry[field] = str(row[ci]).strip()
        if not (entry.get('producer') or entry.get('grn') or entry.get('commodity')):
            continue
        if 'date' in entry:
            entry['date'] = normalise_date(entry['date']) or fallback_date
        elif fallback_date:
            entry['date'] = fallback_date
        for f in ('quantity', 'bags'):
            if f in entry:
                v = clean_number(entry[f])
                if v is not None:
                    entry[f] = v
        results.append(entry)
    return results


# ── Per-page dispatcher ───────────────────────────────────────────────────────

def parse_page(page, fallback_date=None):
    # Strategy 1: JFPM hardcoded bands (best for real stock PDFs)
    rows = parse_jfpm_page(page, fallback_date)
    if rows:
        return rows, 'jfpm_bands'

    # Strategy 2: pdfplumber text strategy
    rows = try_extract_table(page, 'text', fallback_date)
    if rows:
        return rows, 'text'

    # Strategy 3: pdfplumber lines strategy
    rows = try_extract_table(page, 'lines', fallback_date)
    if rows:
        return rows, 'lines'

    return [], 'none'


# ── File entry point ──────────────────────────────────────────────────────────

def parse_stock_pdf(pdf_path, username=None, fallback_date=None):
    all_entries = []
    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages, 1):
            try:
                rows, strategy = parse_page(page, fallback_date)
                print(f"  page {page_num}: strategy={strategy}, rows={len(rows)}", file=sys.stderr)
                for r in rows:
                    r['_page'] = page_num
                    if username:
                        r['_user'] = username
                all_entries.extend(rows)
            except Exception as e:
                print(f"  page {page_num}: ERROR {e}", file=sys.stderr)
    return all_entries


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: parse_stock_pdf.py <pdf> [username] [YYYY-MM-DD]', file=sys.stderr)
        sys.exit(1)
    pdf_path      = sys.argv[1]
    username      = sys.argv[2] if len(sys.argv) > 2 else None
    fallback_date = sys.argv[3] if len(sys.argv) > 3 else None
    try:
        entries = parse_stock_pdf(pdf_path, username, fallback_date)
        print(json.dumps(entries, ensure_ascii=False, indent=2))
    except FileNotFoundError:
        print(json.dumps({'error': f'File not found: {pdf_path}'}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)
