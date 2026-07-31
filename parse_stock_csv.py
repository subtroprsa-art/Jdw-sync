import csv
import firebase_admin
from firebase_admin import credentials
from firebase_admin import db

# Initialize Firebase (update path to your service account key and database URL)
cred = credentials.Certificate("serviceAccountKey.json")
firebase_admin.initialize_app(cred, {
    'databaseURL': 'https://YOUR-DATABASE-NAME.firebaseio.com/'
})

def parse_and_upload_stock(csv_filename):
    ref = db.reference('stock_inventory')
    
    with open(csv_filename, mode='r', encoding='utf-8') as file:
        reader = csv.DictReader(file)
        
        for row in reader:
            # Skip rows that don't have a GRN number (like summary or empty lines)
            grn_no = row.get('GRN_NO', '').strip()
            if not grn_no:
                continue
                
            record = {
                "grn": grn_no,
                "producer": row.get('PRODUCER', '').strip(),
                "commodity": row.get('COMMODITY', '').strip(),
                "date_received": row.get('DATE_RECEIVED', '').strip(),
                "coldstore": row.get('CS_SUMAGTQTYCSTORE', '').strip() or row.get('COLDSTORE', '').strip() or "0",
                "qty_rec": int(row.get('QTY_REC', 0) or 0),
                "qty_sold": int(row.get('QTY_SOLD', 0) or 0),
                "qty_floor": int(row.get('QTY_FLOOR', 0) or 0)
            }
            
            # Push or set data in Firebase keyed by GRN
            ref.child(grn_no).set(record)
            print(f"Successfully uploaded GRN: {grn_no} with coldstore: {record['coldstore']}")

if __name__ == "__main__":
    parse_and_upload_stock("riaan300072026csv.txt")
