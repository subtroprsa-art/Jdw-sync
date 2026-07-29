import pdfplumber
import re
import sys
import json

def parse_stock_report(pdf_path):
    table_settings = {
        "vertical_strategy": "text",
        "horizontal_strategy": "text",
        "snap_tolerance": 4,
        "keep_blank_chars": True
    }
    
    parsed_records = []
    
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables(table_settings)
            for table in tables:
                for row in table:
                    # Clean up each cell in the row
                    cleaned_row = [cell.strip().replace("\n", " ") if cell else "" for cell in row]
                    
                    # Skip empty rows
                    if not any(cleaned_row):
                        continue
                        
                    row_text = " ".join(cleaned_row).lower()
                    
                    # Filter out summary/bag total rows (e.g., 15kg, 20kg totals)
                    if "total" in row_text or re.search(r'\d+\s*kg', row_text):
                        continue
                        
                    parsed_records.append(cleaned_row)

    # Output as JSON so your Node.js backend server.js / index.js can catch and ingest it cleanly
    print(json.dumps(parsed_records))

if __name__ == "__main__":
    # Expects the PDF file path passed as a command-line argument from your Node backend
    target_pdf = sys.argv[1] if len(sys.argv) > 1 else "stock_report.pdf"
    parse_stock_report(target_pdf)
