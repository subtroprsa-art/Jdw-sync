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
                    # Skip summary and bag total rows
                    if "total" in line_lower or re.search(r'\d+\s*kg', line_lower):
                        continue
                        
                    # Split columns by multiple spaces
                    cols = [c.strip() for c in re.split(r'\s{2,}', line_clean) if c.strip()]
                    if len(cols) >= 3:
                        # Map text columns to the keys your Node backend checks
                        # Adjust indices based on your specific PDF column layout if needed
                        record = {
                            "grn": cols[0] if len(cols) > 0 else "",
                            "producer": cols[1] if len(cols) > 1 else "",
                            "commodity": cols[2] if len(cols) > 2 else "UNK",
                            "pack": cols[3] if len(cols) > 3 else "",
                            "variety": cols[4] if len(cols) > 4 else "*",
                            "grade": cols[5] if len(cols) > 5 else "1",
                            "size": cols[6] if len(cols) > 6 else "*",
                            "count": cols[7] if len(cols) > 7 else "*",
                            "qty_rec": int(cols[8]) if len(cols) > 8 and cols[8].isdigit() else 0,
                            "qty_sort": int(cols[9]) if len(cols) > 9 and cols[9].isdigit() else 0
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
