#!/bin/bash

echo "📦 Installing Python dependencies using Poetry..."

# Install Poetry if not already installed
curl -sSL https://install.python-poetry.org | python3 -

# Install dependencies from pyproject.toml
poetry install

# Install system dependencies (skip if permission denied)
echo "📦 Installing system dependencies..."
apt update --allow-releaseinfo-change 2>/dev/null || true
apt install -y poppler-utils 2>/dev/null || echo "⚠️ Could not install poppler-utils"

# Pre-download PaddleOCR model
echo "📦 Pre-downloading PaddleOCR model..."
poetry run python -c "from paddleocr import PaddleOCR; PaddleOCR(use_angle_cls=True, lang='en')" || echo "⚠️ PaddleOCR model download failed"

echo "✅ Build complete"
