#!/bin/bash

echo "📦 Installing Python dependencies..."
pip3 install --upgrade pip
pip3 install -r requirements.txt

echo "✅ Build complete"
