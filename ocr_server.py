from flask import Flask, request, jsonify
from flask_cors import CORS
import easyocr
import base64
from PIL import Image
import io
import sys
import os

app = Flask(__name__)
CORS(app)

# Initialize EasyOCR once (CPU mode)
print("Loading EasyOCR...")
reader = easyocr.Reader(['en'], gpu=False)
print("EasyOCR loaded!")

@app.route('/ocr', methods=['POST'])
def ocr_image():
    try:
        data = request.json
        image_data = data.get('image', '')
        
        if not image_data:
            return jsonify({'error': 'No image provided'}), 400
        
        # Decode base64 image
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        
        image_bytes = base64.b64decode(image_data)
        image = Image.open(io.BytesIO(image_bytes))
        
        # Run EasyOCR
        result = reader.readtext(image, detail=0)
        full_text = '\n'.join(result)
        
        print(f"OCR complete: {len(full_text)} characters extracted")
        
        return jsonify({'text': full_text})
    
    except Exception as e:
        print(f"OCR Error: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'ocr': 'easyocr'})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    print(f"Starting OCR server on port {port}")
    app.run(host='0.0.0.0', port=port)
