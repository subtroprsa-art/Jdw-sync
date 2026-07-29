import pdfplumber
import re
import sys
import json

def parse_stock_report(pdf_path):
    parsed_records = []
    
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            # First try extracting structured table rows
            table_settings = {
                "vertical_strategy": "lines",
                "horizontal_strategy": "lines",
                "snap_tolerance": 3
            }
            tables = page.extract_tables(table_settings)
            
            rows_found = False
            if tables:
                for table in tables:
                    for row in table:
                        if not row:
                            continue
                        cleaned_row = [cell.strip().replace("\n", " ") if cell else "" for cell in row]
                        if not any(cleaned_row):
                            continue
                        
                        row_text = " ".join(cleaned_row).lower()
                        # Skip total and bag total lines (15kg, 20kg, etc.)
                        if "total" in row_text or re.search(r'\d+\s*kg', row_text):
                            continue
                            
                        parsed_records.append(cleaned_row)
                        rows_found = True

            # Fallback: If table grid fails, parse raw text line-by-line
            if not rows_found:
                text = page.extract_text()
                if text:
                    for line in text.split("\n"):
                        line_clean = line.strip()
                        if not line_clean:
                            continue
                            
                        line_lower = line_clean.lower()
                        # Skip summary / total lines
                        if "total" in line_lower or re.search(r'\d+\s*kg', line_lower):
                            continue
                            
                        # Split spaces into columns
                        columns = re.split(r'\s{2,}', line_clean)
                        parsed_records.append(columns)

    # Print JSON output for Node.js backend
    print(json.dumps(parsed_records))

if __name__ == "__main__":
    target_pdf = "stock_report.pdf"
    for arg in sys.argv[1:]:
        if arg.lower().endswith(".pdf"):
            target_pdf = arg
            break
            
    parse_stock_report(target_pdf)
