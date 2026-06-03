#!/bin/bash
# Install system dependencies for OCR
apt-get install -y tesseract-ocr poppler-utils

# Install Python dependencies
pip install pdfplumber pytesseract pdf2image

# Install Node dependencies
npm install
