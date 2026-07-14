#!/bin/bash

# Install Python dependencies using pip directly (skip Poetry)
echo "📦 Installing Python dependencies..."
pip3 install --upgrade pip
pip3 install -r requirements.txt

# Install system dependencies for pdf2image
echo "📦 Installing system dependencies..."
apt-get update && apt-get install -y poppler-utils

# Pre-download PaddleOCR model (speeds up first request)
echo "📦 Pre-downloading PaddleOCR model..."
python3 -c "from paddleocr import PaddleOCR; PaddleOCR(use_angle_cls=True, lang='en')"

echo "✅ Build complete"
