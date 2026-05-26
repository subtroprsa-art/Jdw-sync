# jdw-sync — Auto-sync for jdw CRM

Runs every 5 minutes. Reads new sale slip PDFs from Google Drive, parses them, 
pushes updated buyer history + affinity model to Firebase. 
Riaan and Christoff see updates in the app automatically.

## Deploy on Railway (free, takes ~10 min once)

### 1. Get your credentials

**Firebase service account:**
1. Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key" → download JSON
3. Copy the entire JSON content

**Google service account:**
1. Go to console.cloud.google.com
2. IAM & Admin → Service Accounts → Create Service Account
3. Name it "jdw-drive-reader"
4. Download JSON key
5. Go to Google Drive → right-click your "Buyer History" folder → Share
6. Share with the service account email (e.g. jdw-drive-reader@your-project.iam.gserviceaccount.com)
7. Do the same for the "Stock Scans" folder

### 2. Deploy to Railway

1. Go to railway.app → sign up free (GitHub login)
2. New Project → Deploy from GitHub repo
   - OR: New Project → Empty Project → Add Service → GitHub Repo
   - Upload this jdw-sync folder as a new GitHub repo (github.com → New repo → upload files)
3. In Railway, go to your service → Variables → Add these:

```
FIREBASE_DATABASE_URL       = https://jdw-crm-default-rtdb.firebaseio.com
FIREBASE_SERVICE_ACCOUNT    = { ...paste entire Firebase service account JSON here... }
GOOGLE_SERVICE_ACCOUNT      = { ...paste entire Google service account JSON here... }
DRIVE_BUYER_HISTORY_FOLDER_ID = 1DBmo42cx_YnQPqKOer1MFiH8onww5pZ6
DRIVE_STOCK_SCANS_FOLDER_ID   = 1DrYmim6xThu6KfKRplr5SDBVZc-BFMBm
POLL_MINUTES                = 5
```

4. Railway auto-deploys. Check the logs — you should see:
   ```
   🚀 jdw-sync starting — polling every 5 min
   ✅ Firebase connected
   ✅ Google Drive connected
   🔄 Sync started
   ✅ Pushed X new rows | Y total | Z buyers
   ```

### That's it.

From now on:
- Scan slips → upload to Google Drive Buyer History folder
- Within 5 minutes the app updates automatically for both Riaan and Christoff
- No manual steps needed ever again

### Free tier limits (more than enough)
- Railway: 500 hours/month free (this uses ~720 hours = upgrade to $5/month Hobby plan, or use Render which is free)
- Firebase Realtime DB: 1GB free, 10GB/month transfer free
- Google Drive API: 1 billion requests/day free
