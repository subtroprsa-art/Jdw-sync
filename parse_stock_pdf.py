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
                if text:
                    for line in text.split("\n"):
                        line_clean = line.strip()
                        if not line_clean:
                            continue
                            
                        line_lower = line_clean.lower()
                        # Skip summary and bag total rows (e.g., 15kg, 20kg totals)
                        if "total" in line_lower or re.search(r'\d+\s*kg', line_lower):
                            continue
                            
                        # Split the line into distinct columns based on multi-space gaps
                        columns = [col.strip() for col in re.split(r'\s{2,}', line_clean) if col.strip()]
                        if columns:
                            parsed_records.append(columns)
                            
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
