import csv
import json
import sys
import os

# Safe initialization wrapper to catch startup errors
db = None
try:
    import firebase_admin
    from firebase_admin import credentials, firestore

    if not firebase_admin._apps:
        service_account_env = os.environ.get('FIREBASE_SERVICE_ACCOUNT')
        if service_account_env:
            try:
                cred_dict = json.loads(service_account_env)
                cred = credentials.Certificate(cred_dict)
            except json.JSONDecodeError:
                cred = credentials.Certificate(service_account_env)
            firebase_admin.initialize_app(cred)
        else:
            firebase_admin.initialize_app()

    db = firestore.client()
except Exception as init_error:
    # Print initialization error directly to stderr so Node.js catches it
    print(f"FIREBASE_INIT_ERROR: {str(init_error)}", file=sys.stderr)
    sys.exit(1)

def parse_csv(file_path):
    records = []
    total_rows = 0

    try:
        with open(file_path, mode='r', encoding='utf-8-sig', errors='ignore') as file:
            reader = csv.DictReader(file, delimiter='\t')
            
            batch = db.batch()
            batch_count = 0

            for row in reader:
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

                doc_ref = db.collection('stock_inventory').document(record["grn"])
                batch.set(doc_ref, record)
                batch_count += 1

                if batch_count >= 400:
                    batch.commit()
                    batch = db.batch()
                    batch_count = 0

            if batch_count > 0:
                batch.commit()

        print(json.dumps({
            "status": "SUCCESS",
            "total_rows": total_rows,
            "records_saved_to_firebase": len(records),
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
