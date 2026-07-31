const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;

app.post('/trigger-stock', (req, res) => {
    const { fileName, csvData } = req.body;
    
    if (!csvData) {
        return res.status(400).json({ status: "ERROR", message: "Missing csvData in request body" });
    }

    console.log(`Received stock sync request for file: ${fileName}`);

    // Save CSV content temporarily so Python can read it
    const tempFilePath = path.join(__dirname, fileName || 'temp_stock.csv');
    fs.writeFileSync(tempFilePath, csvData);

    const scriptPath = path.join(__dirname, 'parse_stock_csv.py');
    
    exec(`python3 "${scriptPath}" "${tempFilePath}"`, (error, stdout, stderr) => {
        // Clean up temp file
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

        if (error) {
            console.error(`Execution error: ${error.message}`);
            return res.status(500).json({ status: "ERROR", message: error.message, details: stderr });
        }
        
        try {
            const result = JSON.parse(stdout);
            return res.status(200).json(result);
        } catch (e) {
            return res.status(200).json({ status: "SUCCESS", output: stdout });
        }
    });
});

app.get('/', (req, res) => {
    res.send('JDW Sync Server is running.');
});

app.listen(PORT, () => {
    console.log(`🚀 JDW Sync Server running on port ${PORT}`);
});
