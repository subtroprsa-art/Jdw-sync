from flask import Flask, request, jsonify
from flask_cors import CORS
import pytesseract
import base64
from PIL import Image
import io
import os

app = Flask(__name__)
CORS(app)

@app.route('/')
def home():
    return 'OCR Server is running!'

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'ocr': 'tesseract'})

@app.route('/ocr', methods=['POST'])
def ocr_image():
    try:
        data = request.json
        image_data = data.get('image', '')
        
        if not image_data:
            return jsonify({'error': 'No image provided'}), 400
        
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        
        image_bytes = base64.b64decode(image_data)
        image = Image.open(io.BytesIO(image_bytes))
        
        # Run Tesseract OCR
        text = pytesseract.image_to_string(image)
        
        return jsonify({'text': text})
    
    except Exception as e:
        print(f"OCR Error: {str(e)}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    ocr_port = int(os.environ.get('OCR_PORT', 5002))
    app.run(host='0.0.0.0', port=ocr_port)
