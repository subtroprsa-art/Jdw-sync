import pdfplumber
import sys

def debug_print_raw_text(pdf_path):
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            print(f"--- PAGE {i+1} RAW TEXT ---")
            print(page.extract_text())
            print("--------------------------")

if __name__ == "__main__":
    target_pdf = sys.argv[1] if len(sys.argv) > 1 else "stock_report.pdf"
    debug_print_raw_text(target_pdf)
