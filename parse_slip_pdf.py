#!/usr/bin/env python3
"""
parse_slip_pdf.py — JDW buyer slip PDF parser
Scanned image PDFs from Johannesburg Fresh Produce Market
Uses tesseract OCR via pytesseract + pdf2image
Each page = one slip
Output: JSON array of transaction objects
"""

import sys
import json
import re
import os

def parse_slip_text(text):
    """Parse a single slip's OCR text and return a transaction dict or None."""

    # DATE
    date = None
    date_match = re.search(r'DATE[:\s]+(\d{2}/[A-Z]{3}/\d{4})', text, re.IGNORECASE)
    if date_match:
        raw = date_match.group(1).upper()
        months = {'JAN':'01','FEB':'02','MAR':'03','APR':'04','MAY':'05','JUN':'06',
                  'JUL':'07','AUG':'08','SEP':'09','OCT':'10','NOV':'11','DEC':'12'}
        parts = raw.split('/')
        if len(parts) == 3:
            date = f"{parts[0]}/{months.get(parts[1], parts[1])}/{parts[2]}"

    # BUYER
    buyer = None
    buyer_match = re.search(r'BUYER[:\s]+([^\n]+)', text, re.IGNORECASE)
    if buyer_match:
        buyer = buyer_match.group(1).strip()

    # ACCOUNT
    account = None
    acc_match = re.search(r'ACCOUNT[:\s]+(\d+)', text, re.IGNORECASE)
    if acc_match:
        account = acc_match.group(1).strip()

    # CARD
    card = None
    card_match = re.search(r'CARD[:\s]+(\d+)', text, re.IGNORECASE)
    if card_match:
        card = card_match.group(1).strip()

    # INVOICE
    invoice = None
    inv_match = re.search(r'INVOICE[:\s]+(\d+)', text, re.IGNORECASE)
    if inv_match:
        invoice = inv_match.group(1).strip()

    # GRN
    grn = None
    grn_match = re.search(r'GRN[:\s]+(\d+)', text, re.IGNORECASE)
    if grn_match:
        grn = grn_match.group(1).strip()

    # PRODUCER
    producer = None
    prod_match = re.search(r'PRODUCER[:\s]+([^\n]+)', text, re.IGNORECASE)
    if prod_match:
        producer = prod_match.group(1).strip()

    # COMMODITY LINE — e.g. "AVOCADOS, 4KG TRAY, AF;CL 2;*;14;*;4 KG/L"
    commodity = 'UNK'
    pack = ''
    variety = '*'
    cls = '1'
    size = '*'

    comm_match = re.search(
        r'(AVOCADO|LEMON|NAARTJ|ORANGE|CLEMENTINE|KIWI|STRAWB|FIG|GUAVA|DRAGON|SATSUM|MANGO|PAPINO|GRAPEFRUIT)[^\n]*',
        text, re.IGNORECASE
    )

    if comm_match:
        comm_line = comm_match.group(0).upper()

        if   'AVOCADO' in comm_line: commodity = 'AVOS'
        elif 'LEMON'   in comm_line: commodity = 'LEMS'
        elif 'NAARTJ'  in comm_line: commodity = 'NAAR'
        elif 'ORANGE'  in comm_line: commodity = 'ORGS'
        elif 'CLEMENT' in comm_line: commodity = 'CLTM'
        elif 'KIWI'    in comm_line: commodity = 'KIWI'
        elif 'STRAWB'  in comm_line: commodity = 'STRS'
        elif 'FIG'     in comm_line: commodity = 'FIGS'
        elif 'GUAVA'   in comm_line: commodity = 'GVS'
        elif 'DRAGON'  in comm_line: commodity = 'DRAG'
        elif 'MANGO'   in comm_line: commodity = 'MANG'
        elif 'PAPINO'  in comm_line: commodity = 'PAPO'
        elif 'GRAPEFR' in comm_line: commodity = 'GFT'
        elif 'SATSUM'  in comm_line: commodity = 'SATS'

        # Pack
        pack_match = re.search(r'(\d+\s*KG\s*(?:TRAY|CARTON|BAG|POCKET|PUNNET))', comm_line)
        if pack_match:
            pack = pack_match.group(1).strip()

        # Variety
        var_match = re.search(r'\b(AF|AH|AK|MA|LR|HM|NV|M1|AE|CN|SZ)\b', comm_line)
        if var_match:
            variety = var_match.group(1)

        # Class
        cls_match = re.search(r'CL\s*([12])', comm_line)
        if cls_match:
            cls = cls_match.group(1)

        # Size — number between semicolons e.g. ;14; or ;*;14;
        # OCR sometimes replaces ; with other chars so be flexible
        size_match = re.search(r'[;,*]\s*(\d{1,3})\s*[;,*]', comm_line)
        if size_match:
            size = size_match.group(1)

    # SALE line — "SALE  211 @  80.00  16,880.00"
    # OCR can mangle @ as various chars so be flexible
    qty = 0
    price = 0.0
    total = 0.0

    sale_match = re.search(
        r'SALE\s+([\d,]+)\s*[@©@]\s*([\d,.]+)\s+([\d,.]+)',
        text, re.IGNORECASE
    )
    if not sale_match:
        # Fallback: SALE followed by three numbers
        sale_match = re.search(
            r'SALE\s+([\d,]+)\s+([\d,.]+)\s+([\d,.]+)',
            text, re.IGNORECASE
        )
    if sale_match:
        try:
            qty   = int(sale_match.group(1).replace(',', ''))
            price = float(sale_match.group(2).replace(',', ''))
            total = float(sale_match.group(3).replace(',', ''))
        except:
            pass

    # Validate
    if not buyer or not grn or qty == 0:
        return None

    return {
        'buyer':     buyer,
        'account':   account  or '',
        'card':      card     or '',
        'invoice':   invoice  or '',
        'grn':       grn,
        'producer':  producer or '',
        'commodity': commodity,
        'pack':      pack,
        'variety':   variety,
        'cls':       cls,
        'size':      size,
        'qty':       qty,
        'price':     price,
        'total':     total,
        'date':      date or '',
    }


def parse_pdf(pdf_path):
    results = []
    try:
        import pytesseract
        from pdf2image import convert_from_path
    except ImportError as e:
        print(f"ERROR: Missing dependency: {e}", file=sys.stderr)
        return results

    try:
        pages = convert_from_path(pdf_path, dpi=300)
        for page_num, page in enumerate(pages, 1):
            text = pytesseract.image_to_string(page)
            if not text.strip():
                print(f"  page {page_num}: no text", file=sys.stderr)
                continue
            row = parse_slip_text(text)
            if row:
                results.append(row)
                print(f"  page {page_num}: {row['buyer']} GRN {row['grn']} qty {row['qty']}", file=sys.stderr)
            else:
                print(f"  page {page_num}: could not parse slip", file=sys.stderr)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)

    return results


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: parse_slip_pdf.py <pdf_path>", file=sys.stderr)
        sys.exit(1)
    pdf_path = sys.argv[1]
    if not os.path.exists(pdf_path):
        print(f"ERROR: File not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)
    rows = parse_pdf(pdf_path)
    print(json.dumps(rows, ensure_ascii=False))
