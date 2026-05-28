#!/usr/bin/env python3
"""
JDW Stock PDF Spatial Parser  v2
==================================
Three-strategy approach — tries each in order, uses the first that yields data:

  1. extract_table (text strategy)  — best for most PDFs, column-aware
  2. extract_table (lines strategy) — for PDFs with ruled grid lines
  3. Word-cluster fallback           — last resort spatial grouping

All three map Afrikaans and English column headers to the same field names.

Usage:  python3 parse_stock_pdf.py <path.pdf> [username]
Output: JSON array to stdout.  Errors to stderr, exit 1.
"""

import sys, json, re
import pdfplumber
from collections import defaultdict

# ── Column header aliases (English + Afrikaans) ───────────────────────────────
FIELD_ALIASES = {
    'producer':  ['producer', 'produsent', 'produser', 'boer', 'supplier', 'naam', 'name'],
    'grn':       ['grn', 'gr no', 'gr.no', 'receipt', 'ontvangst', 'gr nr', 'gr#'],
    'commodity': ['commodity', 'produk', 'product', 'item', 'description', 'kommoditeit', 'graad'],
    'date':      ['date', 'datum'],
    'quantity':  ['quantity', 'qty', 'mass', 'gewig', 'weight', 'kg', 'ton', 'hoeveelheid'],
    'bags':      ['bags', 'sakke', 'units', 'eenhede', 'sacks'],
}

# All skip-words — rows containing only these are headers/totals/blanks
SKIP_WORDS = set(
    w for words in FIELD_ALIASES.values() for w in words
) | {'total', 'totaal', 'subtotal', 'page', 'bladsy', 'date', 'datum', 'no', 'nr'}


# ── Header → field mapper ─────────────────────────────────────────────────────

def header_to_field(text):
    """Map a header cell string to a canonical field name, or None."""
    t = text.lower().strip().rstrip(':').rstrip('.')
    # Strip units in parens: "Gewig (kg)" → "gewig"
    t = re.sub(r'\s*\(.*?\)', '', t).strip()
    for field, aliases in FIELD_ALIASES.items():
        for alias in aliases:
            if alias in t or t in alias:
                return field
    return None


def detect_header_row(rows):
    """
    Given a list of rows (each a list of strings/None), find the index of the
    header row. Returns (header_index, col_map) where col_map maps col_index→field.
    Returns (-1, {}) if not found.
    """
    for i, row in enumerate(rows):
        cells = [c for c in row if c and c.strip()]
        if len(cells) < 2:
            continue
        mapping = {}
        matches = 0
        for j, cell in enumerate(row):
            if not cell:
                continue
            f = header_to_field(cell)
            if f:
                mapping[j] = f
                matches += 1
        if matches >= 2:
            return i, mapping
    return -1, {}


# ── Date / number normalisation ───────────────────────────────────────────────

def normalise_date(text):
    if not text:
        return None
    t = str(text).strip()
    # YYYY-MM-DD or YYYY/MM/DD
    m = re.search(r'(\d{4})[/\-\.](\d{1,2})[/\-\.](\d{1,2})', t)
    if m:
        return f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"
    # DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
    m = re.search(r'(\d{1,2})[/\-\.](\d{1,2})[/\-\.](\d{2,4})', t)
    if m:
        d, mo, y = m.group(1), m.group(2), m.group(3)
        y = ('20' + y) if len(y) == 2 else y
        return f"{y}-{mo.zfill(2)}-{d.zfill(2)}"
    return t


def clean_number(text):
    if text is None:
        return None
    t = re.sub(r'[,\s]', '', str(text).strip())
    try:
        v = float(t)
        return int(v) if v == int(v) else v
    except ValueError:
        return None


def is_skip_row(row):
    """True if this row is a header repeat, blank, or totals line."""
    cells = [c.strip() for c in row if c and c.strip()]
    if not cells:
        return True
    combined = ' '.join(cells).lower()
    # All cells are skip-words → header row
    if all(header_to_field(c) is not None for c in cells if c.strip()):
        return True
    # Totals rows
    if re.match(r'^(total|totaal)', combined):
        return True
    return False


# ── Table rows → entry dicts ──────────────────────────────────────────────────

def rows_to_entries(table_rows, col_map, fallback_date=None):
    """Convert raw table rows + column mapping into normalised entry dicts."""
    results = []
    for row in table_rows:
        if is_skip_row(row):
            continue
        entry = {}
        for col_idx, field in col_map.items():
            if col_idx < len(row) and row[col_idx] and str(row[col_idx]).strip():
                entry[field] = str(row[col_idx]).strip()

        # Must have at least producer or commodity or grn to be a real row
        if not (entry.get('producer') or entry.get('commodity') or entry.get('grn')):
            continue

        # Normalise
        if 'date' in entry:
            entry['date'] = normalise_date(entry['date']) or fallback_date
        elif fallback_date:
            entry['date'] = fallback_date

        for num_field in ('quantity', 'bags'):
            if num_field in entry:
                v = clean_number(entry[num_field])
                entry[num_field] = v if v is not None else entry[num_field]

        results.append(entry)
    return results


# ── Strategy 1 & 2: extract_table ────────────────────────────────────────────

def try_extract_table(page, strategy, fallback_date=None):
    """
    Try pdfplumber's extract_table with given strategy.
    Returns list of entry dicts, or [] if nothing usable found.
    """
    try:
        table = page.extract_table({
            'vertical_strategy':   strategy,
            'horizontal_strategy': strategy,
            'snap_tolerance':      5,
            'join_tolerance':      5,
            'intersection_tolerance': 5,

        })
    except Exception:
        return []

    if not table or len(table) < 2:
        return []

    header_idx, col_map = detect_header_row(table)

    # No header found — try positional fallback mapping (first row is data)
    if not col_map:
        # Infer from number of columns
        n = max(len(r) for r in table)
        fallback_orders = {
            4: ['producer', 'commodity', 'date', 'quantity'],
            5: ['producer', 'grn', 'commodity', 'date', 'quantity'],
            6: ['producer', 'grn', 'commodity', 'date', 'quantity', 'bags'],
            7: ['producer', 'grn', 'commodity', 'date', 'quantity', 'bags', None],
        }
        order = fallback_orders.get(n)
        if order:
            col_map = {i: f for i, f in enumerate(order) if f}
            header_idx = -1

    if not col_map:
        return []

    data_rows = table[header_idx + 1:]
    return rows_to_entries(data_rows, col_map, fallback_date)


# ── Strategy 3: word-cluster fallback ────────────────────────────────────────

def cluster_xs(xs, gap=28):
    if not xs:
        return []
    sx = sorted(set(round(x) for x in xs))
    clusters = [[sx[0]]]
    for x in sx[1:]:
        if x - clusters[-1][-1] <= gap:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    return [sum(c) / len(c) for c in clusters]


def nearest_col(x, centres):
    return min(range(len(centres)), key=lambda i: abs(centres[i] - x))


def try_word_clusters(page, fallback_date=None):
    """Spatial word-clustering: last resort for unusual layouts."""
    words = page.extract_words(x_tolerance=4, y_tolerance=4,
                               keep_blank_chars=False, use_text_flow=False)
    if not words:
        return []

    # Group by snapped Y
    by_y = defaultdict(list)
    for w in words:
        by_y[round(w['top'] / 5) * 5].append(w)
    sorted_rows = sorted(by_y.items())

    col_centres = cluster_xs([w['x0'] for w in words], gap=28)
    if len(col_centres) < 3:
        return []

    # Find header row
    col_map = {}
    header_y = None
    for y, row_words in sorted_rows:
        mapping = {}
        for w in row_words:
            f = header_to_field(w['text'])
            if f:
                mapping[nearest_col(w['x0'], col_centres)] = f
        if len(mapping) >= 2:
            col_map = mapping
            header_y = y
            break

    if not col_map and len(col_centres) >= 4:
        order = ['producer', 'grn', 'commodity', 'date', 'quantity', 'bags']
        col_map = {i: order[i] for i in range(min(len(col_centres), len(order)))}

    results = []
    for y, row_words in sorted_rows:
        if header_y is not None and y <= header_y:
            continue
        row_data = defaultdict(list)
        for w in row_words:
            field = col_map.get(nearest_col(w['x0'], col_centres))
            if field:
                row_data[field].append(w['text'])
        if not row_data:
            continue
        entry = {k: ' '.join(v) for k, v in row_data.items()}
        if not (entry.get('producer') or entry.get('commodity') or entry.get('grn')):
            continue
        if is_skip_row(list(entry.values())):
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
    """Try all three strategies, return first non-empty result."""

    # Strategy 1: text strategy (best for most stock PDFs)
    rows = try_extract_table(page, 'text', fallback_date)
    if rows:
        return rows, 'text'

    # Strategy 2: lines strategy (for ruled/bordered tables)
    rows = try_extract_table(page, 'lines', fallback_date)
    if rows:
        return rows, 'lines'

    # Strategy 3: explicit_lines strategy (lines_strict variant)
    rows = try_extract_table(page, 'lines_strict', fallback_date)
    if rows:
        return rows, 'lines_strict'

    # Strategy 4: word-cluster fallback
    rows = try_word_clusters(page, fallback_date)
    return rows, 'word_cluster'


# ── File-level entry point ────────────────────────────────────────────────────

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
