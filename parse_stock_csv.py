import csv
import json
import sys
import os

try:
    import firebase_admin
    from firebase_admin import credentials, db

    if not firebase_admin._apps:
        service_account_env = os.environ.get('FIREBASE_SERVICE_ACCOUNT')
        database_url = "https://jdw-crm-default-rtdb.firebaseio.com/"
        
        if service_account_env:
            try:
                cred_dict = json.loads(service_account_env)
                cred = credentials.Certificate(cred_dict)
            except json.JSONDecodeError:
                cred = credentials.Certificate(service_account_env)
            
            firebase_admin.initialize_app(cred, {
                'databaseURL': database_url
            })
        else:
            firebase_admin.initialize_app({
                'databaseURL': database_url
            })

except Exception as init_error:
    print(f"FIREBASE_INIT_ERROR: {str(init_error)}", file=sys.stderr)
    sys.exit(1)

def parse_commodity(commodity_str):
    """
    Parses commodity string format: e.g., APP,CT185,GS,1,*,100,*
    Returns a structured dictionary of its components.
    """
    if not commodity_str:
        return {}
    
    parts = [p.strip() for p in commodity_str.split(',')]
    
    # Mapping based on standard structure: product, packaging_weight, variety, class, placeholder1, count, placeholder2
    parsed = {
        "raw": commodity_str,
        "product": parts[0] if len(parts) > 0 else "",
        "packaging_weight": parts[1] if len(parts) > 1 else "",
        "variety": parts[2] if len(parts) > 2 else "",
        "class": parts[3] if len(parts) > 3 else "",
        "placeholder_1": parts[4] if len(parts) > 4 else "",
        "count": parts[5] if len(parts) > 5 else "",
        "placeholder_2": parts[6] if len(parts) > 6 else ""
    }
    return parsed

def parse_csv(file_path):
    records = []
    total_rows = 0

    try:
        with open(file_path, mode='r', encoding='utf-8-sig', errors='ignore') as file:
            sample = file.read(2048)
            file.seek(0)
            delimiter = '\t' if '\t' in sample else ','
            
            reader = csv.DictReader(file, delimiter=delimiter)
            ref = db.reference('stock_inventory')
            batch_data = {}

            for row in reader:
                grn_no = row.get('GRN_NO', '').strip()
                if not grn_no or not row.get('PRODUCER'):
                    continue
                
                total_rows += 1
                
                # Parse quantities safely
                qty_rec = int(float(row.get('QTY_REC', 0) or 0))
                qty_sold = int(float(row.get('QTY_SOLD', 0) or 0))
                qty_floor = int(float(row.get('QTY_FLOOR', 0) or 0))
                
                # Cold store row calculation using CSSUM (Column W)
                coldstore_val = row.get('CSSUM', '').strip()
                if not coldstore_val or coldstore_val == '0' or coldstore_val == '0.0':
                    derived_cs = qty_rec - qty_sold - qty_floor
                    coldstore_val = str(max(0, derived_cs))
                else:
                    try:
                        coldstore_val = str(int(float(coldstore_val)))
                    except ValueError:
                        pass

                raw_commodity = row.get('COMMODITY', '').strip()
                commodity_details = parse_commodity(raw_commodity)

                record = {
                    "grn": grn_no,
                    "producer": row.get('PRODUCER', '').strip(),
                    "commodity": raw_commodity,
                    "commodity_details": commodity_details,
                    "date_received": row.get('DATE_RECEIVED', '').strip(),
                    "coldstore": coldstore_val,
                    "qty_rec": qty_rec,
                    "qty_sold": qty_sold,
                    "qty_floor": qty_floor
                }
                records.append(record)

                grn_key = grn_no.replace('/', '_').replace('.', '_')
                if grn_key:
                    batch_data[grn_key] = record

            if batch_data:
                ref.update(batch_data)

        print(json.dumps({
            "status": "SUCCESS",
            "total_rows": total_rows,
            "records_saved_to_realtime_db": len(records),
            "records": records
        }, indent=2))

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
