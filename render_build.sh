#!/bin/bash

echo "📦 Installing Python dependencies..."
pip3 install --upgrade pip
pip3 install -r requirements.txt

echo "📦 Pre-downloading EasyOCR model..."
python3 -c "import easyocr; reader = easyocr.Reader(['en'], gpu=False)"

echo "✅ Build complete"
