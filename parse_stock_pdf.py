import pdfplumber
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
                        if line_clean:
                            # Print each raw line to stdout for your Render logs so we can see it
                            parsed_records.append([line_clean])
    except Exception as e:
        # Print error to stderr so it doesn't break JSON output
        print(f"Error parsing PDF: {str(e)}", file=sys.stderr)

    # Always output a valid JSON array so Node.js never crashes
    print(json.dumps(parsed_records))

if __name__ == "__main__":
    target_pdf = "stock_report.pdf"
    for arg in sys.argv[1:]:
        if arg.lower().endswith(".pdf"):
            target_pdf = arg
            break
            
    parse_stock_report(target_pdf)
