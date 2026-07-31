const express = require('express');
const { exec } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());

// Render automatically sets the PORT environment variable (defaults to 10000)
const PORT = process.env.PORT || 3000;

// Stock Trigger Route
app.post('/trigger-stock', (req, res) => {
    const { fileId, fileName } = req.body;
    
    if (!fileId) {
        return res.status(400).json({ status: "ERROR", message: "Missing fileId in request body" });
    }

    console.log(`Received stock sync request for file: ${fileName} (${fileId})`);

    const scriptPath = path.join(__dirname, 'parse_stock_csv.py');
    
    exec(`python3 "${scriptPath}" "${fileId}"`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Execution error: ${error.message}`);
            return res.status(500).json({ status: "ERROR", message: error.message, details: stderr });
        }
        
        try {
            const result = JSON.parse(stdout);
            return res.status(200).json(result);
        } catch (e) {
            return res.status(500).json({ status: "ERROR", message: "Failed to parse Python output", output: stdout });
        }
    });
});

// Floor Trigger Route
app.post('/trigger-floor', (req, res) => {
    const { fileId, fileName } = req.body;
    
    if (!fileId) {
        return res.status(400).json({ status: "ERROR", message: "Missing fileId in request body" });
    }

    console.log(`Received floor sync request for file: ${fileName} (${fileId})`);

    const scriptPath = path.join(__dirname, 'parse_floor_csv.py');
    
    exec(`python3 "${scriptPath}" "${fileId}"`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Execution error: ${error.message}`);
            return res.status(500).json({ status: "ERROR", message: error.message, details: stderr });
        }
        
        try {
            const result = JSON.parse(stdout);
            return res.status(200).json(result);
        } catch (e) {
            return res.status(500).json({ status: "ERROR", message: "Failed to parse Python output", output: stdout });
        }
    });
});

app.get('/', (req, res) => {
    res.send('JDW Sync Server is running.');
});

app.listen(PORT, () => {
    console.log(`🚀 JDW Sync Server running on port ${PORT}`);
});
