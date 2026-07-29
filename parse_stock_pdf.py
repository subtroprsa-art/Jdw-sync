import pdfplumber
import re
import sys
import json

def parse_stock_report(pdf_path):
    table_settings = {
        "vertical_strategy": "text",
        "horizontal_strategy": "text",
        "snap_tolerance": 4
    }
    
    parsed_records = []
    
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables(table_settings)
            for table in tables:
                for row in table:
                    cleaned_row = [cell.strip().replace("\n", " ") if cell else "" for cell in row]
                    
                    if not any(cleaned_row):
                        continue
                        
                    row_text = " ".join(cleaned_row).lower()
                    
                    # Filter out summary/bag total rows (e.g., 15kg, 20kg totals)
                    if "total" in row_text or re.search(r'\d+\s*kg', row_text):
                        continue
                        
                    parsed_records.append(cleaned_row)

    print(json.dumps(parsed_records))

if __name__ == "__main__":
    # Filter command line arguments to find the one ending with .pdf
    target_pdf = "stock_report.pdf"
    for arg in sys.argv[1:]:
        if arg.lower().endswith(".pdf"):
            target_pdf = arg
            break
            
    parse_stock_report(target_pdf)
