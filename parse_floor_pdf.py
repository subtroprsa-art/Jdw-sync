"""
parse_floor_pdf.py — Floor Balance PDF parser for JDW CRM
Usage: python3 parse_floor_pdf.py <pdf_path> <user> <date>

Column x0 positions (from header inspection):
  RECEIVED: 24  DAYS: 99  SEQ: 134  GRN: 191
  PRODUCER: 242  COMMODITY: 349  LOC: 513  BALANCE: 537+
"""
import sys, json, re
import pdfplumber

def parse_comm_string(s):
    parts = [p.strip() for p in s.split(',')]
    return {
        'commodity': parts[0] if len(parts) > 0 else '',
        'pack':      parts[1] if len(parts) > 1 else '',
        'variety':   parts[2] if len(parts) > 2 else '*',
        'grade':     parts[3] if len(parts) > 3 else '',
        'size':      parts[4] if len(parts) > 4 else '*',
        'count':     parts[5] if len(parts) > 5 else '*',
    }

SKIP = ['FLOOR BALANCE','JOHANNESBURG','AGENT:','SALESMAN:','floorbalance',
        'Page','Version','Printed','FOR ','RECEIVED','PRODUCER','DAYS',
        'COMMODITY','LOC','BALANCE','SEQ','GRN','COMMISSION','DELIVERY']

def parse_floor_pdf(pdf_path, user, date_str):
    rows = []
    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages):
            words = page.extract_words(x_tolerance=3, y_tolerance=3)
            if not words:
                sys.stderr.write(f"page {page_num+1}: rows=0\n")
                continue

            # Group into lines by y (bucket 4px)
            lines_by_y = {}
            for w in words:
                y = round(w['top'] / 4) * 4
                lines_by_y.setdefault(y, []).append(w)

            page_rows = 0
            for y in sorted(lines_by_y):
                lw = sorted(lines_by_y[y], key=lambda w: w['x0'])
                text = ' '.join(w['text'] for w in lw)

                # Skip headers/footers
                if any(s in text for s in SKIP):
                    continue

                # Must contain a commodity string
                comm_match = re.search(r'([A-Z]{2,5},[A-Z0-9]{2,8},[A-Z*]+,(?:CL [123]|LOWEST CLASS|[A-Z*]+),[^,\s]+,[^,\s]+,[*\w]+)', text)
                if not comm_match:
                    continue

                comm_str = comm_match.group(1)
                cf = parse_comm_string(comm_str)
                if not cf['commodity'] or len(cf['commodity']) > 5:
                    continue

                # Extract by x0 column ranges
                def col(x_min, x_max):
                    return ' '.join(w['text'] for w in lw if x_min <= w['x0'] < x_max).strip()

                received = col(0,   98)   # date + time
                days     = col(98,  133)
                seq      = col(133, 190)
                grn      = col(190, 241)
                producer = col(241, 348)
                loc      = col(510, 540)
                balance  = col(540, 620)

                # Validate
                if not grn or not re.match(r'\d+', grn):
                    continue
                if not balance or not re.match(r'\d+', balance.replace(' ','')):
                    continue

                rows.append({
                    'received':  received,
                    'days':      int(re.sub(r'\D','', days)) if re.search(r'\d', days) else 0,
                    'seq':       seq,
                    'grn':       grn,
                    'producer':  producer,
                    'loc':       loc,
                    'balance':   int(re.sub(r'\D','', balance)) if re.search(r'\d', balance) else 0,
                    'commodity': cf['commodity'],
                    'pack':      cf['pack'],
                    'variety':   cf['variety'],
                    'grade':     cf['grade'],
                    'size':      cf['size'],
                    'count':     cf['count'],
                    'user':      user,
                    'floorDate': date_str,
                })
                page_rows += 1

            sys.stderr.write(f"page {page_num+1}: rows={page_rows}\n")
    return rows

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('[]'); sys.exit(0)
    pdf_path = sys.argv[1]
    user     = sys.argv[2] if len(sys.argv) > 2 else 'unknown'
    date_str = sys.argv[3] if len(sys.argv) > 3 else ''
    try:
        rows = parse_floor_pdf(pdf_path, user, date_str)
        print(json.dumps(rows))
    except Exception as e:
        sys.stderr.write(f'Error: {e}\n')
        print('[]')
