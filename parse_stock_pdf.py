#!/usr/bin/env python3
"""
JDW Stock PDF Parser v4 - Layout Line Approach
================================================
Uses pdfplumber's extract_text_lines(layout=True) which preserves the
full row on a single line, then parses each line with regex.

This is immune to column-mixing AND works on both direct uploads
and Google Drive downloaded PDFs.

Usage:  python3 parse_stock_pdf.py <pdf> [username] [YYYY-MM-DD]
Output: JSON array to stdout. Errors to stderr, exit 1.
"""

import sys, json, re
import pdfplumber

MONTH_MAP = {
    'JAN':'01','FEB':'02','MAR':'03','APR':'04','MAY':'05','JUN':'06',
    'JUL':'07','AUG':'08','SEP':'09','OCT':'10','NOV':'11','DEC':'12',
}

def parse_date(s):
    # DD/MON/YYYY
    m = re.match(r'(\d{1,2})[/\-]([A-Za-z]{3})[/\-](\d{4})', s)
    if m:
        d, mon, y = m.group(1), m.group(2).upper(), m.group(3)
        return f"{y}-{MONTH_MAP.get(mon,'00')}-{d.zfill(2)}"
    # YYYY-MM-DD
    m = re.match(r'(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})', s)
    if m:
        return f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"
    # DD/MM/YYYY
    m = re.match(r'(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})', s)
    if m:
        d, mo, y = m.group(1), m.group(2), m.group(3)
        if len(y) == 2: y = '20' + y
        return f"{y}-{mo.zfill(2)}-{d.zfill(2)}"
    return s

def parse_layout_line(line_text):
    """
    Parse a single layout line containing a full stock row.
    Example:
    'CASHUMI BOERDERY    15427248 AVOS,BG150,AF,2,M,*,* 16/MAY/2026 81 72 0 0 0 0 9'
    Returns dict or None.
    """
    t = line_text.strip()
    if not t:
        return None

    # Must contain a GRN (8-digit number)
    grn_match = re.search(r'\b(\d{8})\b', t)
    if not grn_match:
        return None

    grn      = grn_match.group(1)
    grn_pos  = grn_match.start()
    producer = t[:grn_pos].strip()
    if not producer:
        return None

    rest = t[grn_pos + len(grn):].strip()

    # Commodity: e.g. AVOS,BG150,AF,2,M,*,*
    comm_match = re.search(r'([A-Z]{2,5},[A-Z0-9]+,[A-Z*0-9]+(?:,[^\s]+)*)', rest)
    commodity  = comm_match.group(1).split(',')[0] if comm_match else 'UNK'
    comm_end   = comm_match.end() if comm_match else 0

    # Date after commodity
    after_comm  = rest[comm_end:].strip()
    date_match  = re.search(r'(\d{1,2}/[A-Z]{3}/\d{4})', after_comm)
    date        = parse_date(date_match.group(1)) if date_match else None
    date_end    = date_match.end() if date_match else 0

    # Quantities after date
    after_date  = after_comm[date_end:].strip() if date_match else after_comm
    nums        = re.findall(r'\b(\d[\d,]*)\b', after_date)
    clean_nums  = []
    for n in nums:
        v = n.replace(',', '')
        try:
            clean_nums.append(int(v))
        except:
            pass

    qty_rec  = clean_nums[0]  if len(clean_nums) > 0 else 0
    qty_sort = clean_nums[-1] if len(clean_nums) > 0 else 0

    return {
        'producer':  producer,
        'grn':       grn,
        'commodity': commodity,
        'date':      date,
        'qty_rec':   qty_rec,
        'qty_sort':  qty_sort,
    }

def parse_stock_pdf(pdf_path, username=None, fallback_date=None):
    all_entries = []
    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages, 1):
            try:
                lines = page.extract_text_lines(layout=True)
                rows  = []
                for line in lines:
                    entry = parse_layout_line(line.get('text', ''))
                    if entry:
                        if not entry.get('date') and fallback_date:
                            entry['date'] = fallback_date
                        entry['_page'] = page_num
                        if username:
                            entry['_user'] = username
                        rows.append(entry)
                print(f"  page {page_num}: rows={len(rows)}", file=sys.stderr)
                all_entries.extend(rows)
            except Exception as e:
                print(f"  page {page_num}: ERROR {e}", file=sys.stderr)
    return all_entries

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
