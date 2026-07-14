FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for EasyOCR
RUN apt-get update && apt-get install -y \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download EasyOCR models (speeds up first request)
RUN python -c "import easyocr; reader = easyocr.Reader(['en'], gpu=False)"

# Copy the rest of the application
COPY . .

# Expose the port
EXPOSE 5001

CMD ["python", "ocr_server.py"]
