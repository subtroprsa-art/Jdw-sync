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
    Parses commodity string format safely: e.g., APP,CT185,GS,1,*,100,*
    Returns a structured dictionary of its components.
    """
    if not commodity_str or not isinstance(commodity_str, str):
        return {}
    
    parts = [p.strip() for p in commodity_str.split(',')]
    
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
                if not row:
                    continue
                
                grn_val = row.get('GRN_NO')
                grn_no = str(grn_val).strip() if grn_val is not None else ''
                
                producer_val = row.get('PRODUCER')
                producer = str(producer_val).strip() if producer_val is not None else ''

                if not grn_no or not producer:
                    continue
                
                total_rows += 1
                
                # Parse quantities safely with None checks
                qty_rec_val = row.get('QTY_REC', 0)
                qty_rec = int(float(qty_rec_val)) if qty_rec_val is not None and str(qty_rec_val).strip() != '' else 0

                qty_sold_val = row.get('QTY_SOLD', 0)
                qty_sold = int(float(qty_sold_val)) if qty_sold_val is not None and str(qty_sold_val).strip() != '' else 0

                qty_floor_val = row.get('QTY_FLOOR', 0)
                qty_floor = int(float(qty_floor_val)) if qty_floor_val is not None and str(qty_floor_val).strip() != '' else 0
                
                # Cold store row calculation using CSSUM (Column W)
                cssum_val = row.get('CSSUM')
                coldstore_val = str(cssum_val).strip() if cssum_val is not None else ''
                
                if not coldstore_val or coldstore_val == '0' or coldstore_val == '0.0':
                    derived_cs = qty_rec - qty_sold - qty_floor
                    coldstore_val = str(max(0, derived_cs))
                else:
                    try:
                        coldstore_val = str(int(float(coldstore_val)))
                    except ValueError:
                        pass

                raw_comm_val = row.get('COMMODITY')
                raw_commodity = str(raw_comm_val).strip() if raw_comm_val is not None else ''
                commodity_details = parse_commodity(raw_commodity)

                date_rec_val = row.get('DATE_RECEIVED')
                date_received = str(date_rec_val).strip() if date_rec_val is not None else ''

                record = {
                    "grn": grn_no,
                    "producer": producer,
                    "commodity": raw_commodity,
                    "commodity_details": commodity_details,
                    "date_received": date_received,
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
            "records_saved_to_realtime_db": len(records)
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
