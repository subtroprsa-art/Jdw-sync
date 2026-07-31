import csv
import json
import sys

def parse_csv(file_path):
    records = []
    total_rows = 0

    try:
        with open(file_path, mode='r', encoding='utf-8-sig', errors='ignore') as file:
            # Use delimiter='\t' since the data columns are tab-separated
            reader = csv.DictReader(file, delimiter='\t')
            
            for row in reader:
                # Skip summary or blank trailing rows if any
                if not row.get('GRN_NO') and not row.get('PRODUCER'):
                    continue
                
                total_rows += 1
                
                record = {
                    "grn": row.get('GRN_NO', '').strip(),
                    "producer": row.get('PRODUCER', '').strip(),
                    "commodity": row.get('COMMODITY', '').strip(),
                    "date_received": row.get('DATE_RECEIVED', '').strip(),
                    "qty_rec": int(row.get('QTY_REC', 0) or 0),
                    "qty_sold": int(row.get('QTY_SOLD', 0) or 0),
                    "qty_floor": int(row.get('QTY_FLOOR', 0) or 0)
                }
                records.append(record)

        print(json.dumps({
            "status": "SUCCESS",
            "total_rows": total_rows,
            "records": records
        }))

    except Exception as e:
        print(json.dumps({
            "status": "ERROR",
            "message": str(e)
        }))
        sys.exit(1)

if __name__ == '__main__':
    if len(sys.argv) > 1:
        parse_csv(sys.argv[1])
    else:
        print(json.dumps({"status": "ERROR", "message": "No file path provided"}))
        sys.exit(1)
