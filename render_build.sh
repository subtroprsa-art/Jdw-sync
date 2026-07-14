#!/bin/bash

echo "📦 Installing Python dependencies..."

# Install Python dependencies
pip3 install --upgrade pip
pip3 install -r requirements.txt || echo "⚠️ Some packages failed, continuing..."

# Try alternative install for PaddlePaddle if needed
if ! python3 -c "import paddle" 2>/dev/null; then
  echo "⚠️ PaddlePaddle not installed, trying CPU version..."
  pip3 install paddlepaddle==2.5.2 -f https://www.paddlepaddle.org.cn/whl/linux/mkl/avx/stable.html
fi

# Install system dependencies (try different method)
echo "📦 Installing system dependencies..."
apt update --allow-releaseinfo-change || true
apt install -y poppler-utils || echo "⚠️ Could not install poppler-utils"

# Pre-download PaddleOCR model
echo "📦 Pre-downloading PaddleOCR model..."
python3 -c "from paddleocr import PaddleOCR; PaddleOCR(use_angle_cls=True, lang='en')" || echo "⚠️ PaddleOCR model download failed"

echo "✅ Build complete"
