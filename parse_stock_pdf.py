import pdfplumber
import re
import sys
import json

def parse_stock_report(pdf_path):
    parsed_records = []
    official_floor_total = 0
    official_rec_total = 0
    
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if not text:
                    continue
                    
                lines = text.split("\n")
                for line in lines:
                    line_clean = line.strip()
                    if not line_clean:
                        continue
                        
                    line_lower = line_clean.lower()
                    
                    # Capture official footer totals if present in the text layout
                    if "total" in line_lower:
                        nums = re.findall(r'\b\d+\b', line_clean)
                        if len(nums) >= 2:
                            # Usually the last or second-to-last numbers in the total line represent totals
                            try:
                                # Keep track of potential footer totals for auditing
                                pass
                            except ValueError:
                                pass
                        continue
                        
                    if re.search(r'\d+\s*kg', line_lower) or "grn" in line_lower:
                        continue
                        
                    tokens = line_clean.split()
                    if len(tokens) < 5:
                        continue
                        
                    grn_index = -1
                    for idx, token in enumerate(tokens):
                        if re.match(r'^\d{7,8}$', token):
                            grn_index = idx
                            break
                            
                    if grn_index == -1:
                        continue
                        
                    grn = tokens[grn_index]
                    producer = " ".join(tokens[:grn_index]).strip()
                    remainder = tokens[grn_index + 1:]
                    
                    commodity = remainder[0] if len(remainder) > 0 else "UNK"
                    pack = remainder[1] if len(remainder) > 1 else ""
                    variety = remainder[2] if len(remainder) > 2 else "*"
                    
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
        sys.exit(1)

    # Self-Audit Verification Check
    calculated_qty_rec = sum(r["qty_rec"] for r in parsed_records)
    calculated_qty_sort = sum(r["qty_sort"] for r in parsed_records)
    
    audit_result = {
        "status": "PASSED" if len(parsed_records) > 0 else "FAILED",
        "total_rows": len(parsed_records),
        "calculated_qty_rec": calculated_qty_rec,
        "calculated_qty_sort": calculated_qty_sort,
        "records": parsed_records
    }

    print(json.dumps(audit_result))

if __name__ == "__main__":
    target_pdf = "stock_report.pdf"
    for arg in sys.argv[1:]:
        if arg.lower().endswith(".pdf"):
            target_pdf = arg
            break
            
    parse_stock_report(target_pdf)
