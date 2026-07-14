#!/bin/bash

echo "📦 Installing Tesseract..."
apt-get update && apt-get install -y tesseract-ocr

echo "📦 Installing Python dependencies..."
pip3 install --upgrade pip
pip3 install -r requirements.txt

echo "✅ Build complete"
