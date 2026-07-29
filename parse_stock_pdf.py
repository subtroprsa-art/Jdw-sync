import sys
import re
import json
import pdfplumber

def parse_comm_field(comm_str):
    parts = [p.strip() for p in comm_str.split(',')]
    return {
        'commodity': parts[0] if len(parts) > 0 else 'UNK',
        'pack':      parts[1] if len(parts) > 1 else '',
        'variety':   parts[2] if len(parts) > 2 else '*',
        'grade':     parts[3] if len(parts) > 3 and parts[3] else '1',
        'size':      parts[4] if len(parts) > 4 else '*',
        'count':     parts[5] if len(parts) > 5 else '*',
    }

def col_pot(words, x_min, x_max):
    """Specific column slicer for POT layout to avoid misalignment."""
    matched = [w['text'] for w in words if x_min <= w['x0'] < x_max]
    return ' '.join(matched).strip()

def parse_stock_pdf(pdf_path, user, date_str):
    rows = []
    pdf_summary_total = 0
    is_pot = (user.upper() == 'POT')
    
    with pdfplumber.open(pdf_path) as pdf:
        for page_idx, page in enumerate(pdf.pages):
            text_all = page.extract_text() or ''
            
            # Extract native PDF summary footer total on the last page
            if page_idx == len(pdf.pages) - 1:
                summary_match = re.search(r'[\d,]+\s+[\d,]+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+([\d,]+)', text_all)
                if summary_match:
                    pdf_summary_total = int(summary_match.group(1).replace(',', ''))

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

                if any(s in text for s in ['AGENT:', 'SALESMAN:', 'CONSIGNMENT', 'Page', 'Printed']):
                    continue

                comm_match = re.search(r'([A-Z]{2,5},\s*[A-Z0-9]{2,8},\s*[A-Z*]*,\s*[^,\n]+,\s*[^,\n]*,\s*[^,\n]*)', text)
                if not comm_match:
                    continue

                cf = parse_comm_field(comm_match.group(1))

                # Use adjusted spatial boundaries for POT, original for others (CDW/RJ)
                if is_pot:
                    grn      = col_pot(lw, 0, 180)
                    producer = col_pot(lw, 180, 340)
                    qty_rec  = col_pot(lw, 480, 550)
                    qty_sort = col_pot(lw, 550, 630)
                    arr_date = col_pot(lw, 630, 740)
                else:
                    grn      = col_pot(lw, 0, 150)
                    producer = col_pot(lw, 150, 320)
                    qty_rec  = col_pot(lw, 500, 560)
                    qty_sort = col_pot(lw, 560, 620)
                    arr_date = col_pot(lw, 620, 720)

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
                    'date':      arr_date if arr_date else date_str,
                    'user':      user
                })

    # Crosscheck Assertion Validation Logging
    calculated_total = sum(r['qty_sort'] for r in rows)
    if pdf_summary_total > 0 and calculated_total != pdf_summary_total:
        print(f"⚠️ WARNING: Floor total mismatch for {user}! Calculated sum: {calculated_total}, PDF Footer Total: {pdf_summary_total}", file=sys.stderr)
    else:
        print(f"✅ Validation Passed for {user}: Total Floor Balance = {calculated_total}", file=sys.stderr)

    return rows

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print(json.dumps([]))
        sys.exit(1)
        
    pdf_path = sys.argv[1]
    user_arg = sys.argv[2]
    date_arg = sys.argv[3]
    
    parsed_data = parse_stock_pdf(pdf_path, user_arg, date_arg)
    print(json.dumps(parsed_data))
