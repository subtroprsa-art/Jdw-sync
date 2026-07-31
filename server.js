const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// Port setup for Render
const PORT = process.env.PORT || 3000;

// Stock Trigger Route (Fixes the 404 error)
app.post('/trigger-stock', (async (req, res) => {
    const { fileId, fileName } = req.body;
    
    if (!fileId) {
        return res.status(400).json({ status: "ERROR", message: "Missing fileId in request body" });
    }

    console.log(`Received stock sync request for file: ${fileName} (${fileId})`);

    // Path to your updated Python stock CSV parser script
    const scriptPath = path.join(__dirname, 'parse_stock_csv.py');
    
    // Note: Ensure your backend logic handles downloading from Google Drive via fileId, 
    // or if the script expects a local file path, pass it accordingly.
    // For now, executing the script with the fileId / path handling:
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
}));

// Floor Trigger Route
app.post('/trigger-floor', (async (req, res) => {
    const { fileId, fileName } = req.body;
    
    if (!fileId) {
        return res.status(400).json({ status: "ERROR", message: "Missing fileId in request body" });
    }

    const scriptPath = path.join(__dirname, 'parse_floor_csv.py');
    
    exec(`python3 "${scriptPath}" "${fileId}"`, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ status: "ERROR", message: error.message, details: stderr });
        }
        
        try {
            const result = JSON.parse(stdout);
            return res.status(200).json(result);
        } catch (e) {
            return res.status(500).json({ status: "ERROR", message: "Failed to parse Python output", output: stdout });
        }
    });
}));

app.get('/', (req, res) => {
    res.send('JDW Sync Backend is running.');
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
