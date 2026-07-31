import csv
import sys
import json
import os

def parse_stock(file_path):
    parsed_records = []
    
    if not os.path.exists(file_path):
        print(json.dumps({"status": "ERROR", "message": f"File not found: {file_path}"}))
        sys.exit(1)

    try:
        with open(file_path, mode='r', encoding='utf-8') as file:
            reader = csv.DictReader(file)
            for row in reader:
                record = {
                    "grn": row.get('GRN_NO', '').strip(),
                    "producer": row.get('PRODUCER', '').strip(),
                    "commodity": row.get('COMMODITY', '').strip(),
                    "date_received": row.get('DATE_RECEIVED', '').strip(),
                    "qty_rec": int(row.get('QTY_REC', 0) or 0),
                    "qty_sold": int(row.get('QTY_SOLD', 0) or 0),
                    "qty_floor": int(row.get('QTY_FLOOR', 0) or 0),
                }
                parsed_records.append(record)
                
        print(json.dumps({"status": "SUCCESS", "total_rows": len(parsed_records), "records": parsed_records}))
        
    except Exception as e:
        print(json.dumps({"status": "ERROR", "message": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"status": "ERROR", "message": "No file path provided."}))
        sys.exit(1)
        
    target_file = sys.argv[1]
    parse_stock(target_file)
