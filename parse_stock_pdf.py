import pdfplumber
import re
import sys
import json

def parse_stock_report(pdf_path):
    parsed_records = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if not text:
                    continue
                    
                for line in text.split("\n"):
                    line_clean = line.strip()
                    if not line_clean:
                        continue
                        
                    line_lower = line_clean.lower()
                    # Skip header, total, and bag weight rows
                    if "total" in line_lower or re.search(r'\d+\s*kg', line_lower) or "grn" in line_lower:
                        continue
                        
                    # Tokenize the line by whitespace
                    tokens = line_clean.split()
                    if len(tokens) < 5:
                        continue
                        
                    # Look for a GRN pattern (typically a 7-8 digit number like 15379866)
                    grn_index = -1
                    for idx, token in enumerate(tokens):
                        if re.match(r'^\d{7,8}$', token):
                            grn_index = idx
                            break
                            
                    if grn_index == -1:
                        continue
                        
                    # Extract fields relative to the found GRN position
                    grn = tokens[grn_index]
                    # Producer is usually everything before the GRN
                    producer = " ".join(tokens[:grn_index]).strip()
                    
                    # Commodity, pack, variety, quantities typically follow after GRN
                    remainder = tokens[grn_index + 1:]
                    
                    commodity = remainder[0] if len(remainder) > 0 else "UNK"
                    pack = remainder[1] if len(remainder) > 1 else ""
                    variety = remainder[2] if len(remainder) > 2 else "*"
                    
                    # Pull trailing numbers for quantities (Qty Rec and Qty Sort are usually at the tail end of the line)
                    numbers = [t for t in remainder if t.isdigit()]
                    qty_rec = int(numbers[0]) if len(numbers) > 0 else 0
                    qty_sort = int(numbers[-1]) if len(numbers) > 1 else 0

                    record = {
                        "grn": grn,
                        "producer": producer,
                        "commodity": commodity,
                        "pack": pack,
                        "variety": variety,
                        "grade": "1",
                        "size": "*",
                        "count": "*",
                        "qty_rec": qty_rec,
                        "qty_sort": qty_sort
                    }
                    parsed_records.append(record)
                            
    except Exception as e:
        print(f"Error parsing PDF: {str(e)}", file=sys.stderr)

    print(json.dumps(parsed_records))

if __name__ == "__main__":
    target_pdf = "stock_report.pdf"
    for arg in sys.argv[1:]:
        if arg.lower().endswith(".pdf"):
            target_pdf = arg
            break
            
    parse_stock_report(target_pdf)
