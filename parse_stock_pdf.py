#!/usr/bin/env python3
"""
JDW Stock PDF Parser v5 - Layout Line Approach
================================================
Extracts commodity, pack, variety, grade, size, count from the comma-separated
commodity field e.g. AVOS,TR040,AF,1,*,14,*

Usage:  python3 parse_stock_pdf.py <pdf> [username] [YYYY-MM-DD]
Output: JSON array to stdout. Errors to stderr.
"""

import sys, json, re
import pdfplumber

MONTH_MAP = {
    'JAN':'01','FEB':'02','MAR':'03','APR':'04','MAY':'05','JUN':'06',
    'JUL':'07','AUG':'08','SEP':'09','OCT':'10','NOV':'11','DEC':'12',
}

PACK_NAMES = {
    'TR040': '4KG TRAY',
    'BG150': '15KG BAG',
    'BG160': '16KG BAG',
    'SP170': '17KG SPECIAL',
    'CTT150': '15KG CARTON',
    'PTB005': '500G PUNNET',
    'PTB002': '160G PUNNET',
    'DL076': 'DL 076 CARTON',
    'PC030': '3KG POCKET',
    'PC060': '6KG POCKET',
    'ECO020': '2KG ECONO PACK',
}

SKIP = ['STOCK REPORT', 'JOHANNESBURG', 'AGENT:', 'SALESMAN:', 'Page', 'Printed', 
        'PRODUCER', 'COMMODITY', 'GRN', 'REC', 'FLR', 'SORT']

def parse_date(s):
    m = re.match(r'(\d{1,2})[/\-]([A-Za-z]{3})[/\-](\d{4})', s)
    if m:
        d, mon, y = m.group(1), m.group(2).upper(), m.group(3)
        return f"{y}-{MONTH_MAP.get(mon,'00')}-{d.zfill(2)}"
    m = re.match(r'(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})', s)
    if m:
        return f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}"
    m = re.match(r'(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})', s)
    if m:
        d, mo, y = m.group(1), m.group(2), m.group(3)
        if len(y) == 2: y = '20' + y
        return f"{y}-{mo.zfill(2)}-{d.zfill(2)}"
    return s

def parse_comm_field(comm_str):
    parts = [p.strip() for p in comm_str.split(',')]
    return {
        'commodity': parts[0] if len(parts) > 0 else 'UNK',
        'pack':      parts[1] if len(parts) > 1 else '',
        'variety':   parts[2] if len(parts) > 2 else '*',
        'grade':     parts[3] if len(parts) > 3 else '1',
        'size':      parts[4] if len(parts) > 4 else '*',
        'count':     parts[5] if len(parts) > 5 else '*',
    }

def parse_stock_pdf(pdf_path, user, date_str):
    rows = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            words = page.extract_words(x_tolerance=3, y_tolerance=3)
            if not words:
                continue

            lines_by_y = {}
            for w in words:
                y = round(w['top'] / 4) * 4
                lines_by_y.setdefault(y, []).append(w)

            for y in sorted(lines_by_y):
                lw = sorted(lines_by_y[y], key=lambda w: w['x0'])
                text = ' '.join(w['text'] for w in lw)

                if any(s in text for s in SKIP):
                    continue

                # Match commodity field format e.g. AVOS,TR040,AF,1,*,14,*
                comm_match = re.search(r'([A-Z]{2,5},[A-Z0-9]{2,8},[A-Z*]+,(?:CL [123]|[A-Z0-9*]+),[^,\s]+,[^,\s]+,[*\w]+)', text)
                if not comm_match:
                    continue

                cf = parse_comm_field(comm_match.group(1))

                def col(x_min, x_max):
                    return ' '.join(w['text'] for w in lw if x_min <= w['x0'] < x_max).strip()

                # Column positioning bounds
                grn      = col(0, 150)
                producer = col(150, 320)
                qty_rec  = col(500, 560)
                qty_sort = col(560, 620)
                arr_date = col(620, 720)

                # Find digits in GRN and quantities
                grn_num = re.sub(r'\D', '', grn)
                if not grn_num:
                    continue

                rec_val  = int(re.sub(r'\D', '', qty_rec)) if re.search(r'\d', qty_rec) else 0
                sort_val = int(re.sub(r'\D', '', qty_sort)) if re.search(r'\d', qty_sort) else 0

                rows.append({
                    'grn':       grn_num,
                    'producer':  producer,
                    'commodity': cf['commodity'],
                    'pack':      cf['pack'],
                    'variety':   cf['variety'],
                    'grade':     cf['grade'],
                    'size':      cf['size'],
                    'count':     cf['count'],
                    'qty_rec':   rec_val,
                    'qty_sort':  sort_val,
                    'date':      parse_date(arr_date) if arr_date else date_str,
                    'user':      user
                })
    return rows

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('[]')
        sys.exit(0)
        
    pdf_path = sys.argv[1]
    user     = sys.argv[2] if len(sys.argv) > 2 else 'unknown'
    date_str = sys.argv[3] if len(sys.argv) > 3 else ''
    
    try:
        results = parse_stock_pdf(pdf_path, user, date_str)
        print(json.dumps(results))
    except Exception as e:
        sys.stderr.write(f'Error parsing stock PDF: {e}\n')
        print('[]')
