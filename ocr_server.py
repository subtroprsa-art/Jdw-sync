from flask import Flask, request, jsonify
from flask_cors import CORS
import easyocr
import base64
from PIL import Image
import io
import os

app = Flask(__name__)
CORS(app)

# EasyOCR will use pre-downloaded model
print("Loading EasyOCR...")
reader = easyocr.Reader(['en'], gpu=False)
print("✅ EasyOCR loaded!")

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'ocr': 'easyocr'})

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
        
        result = reader.readtext(image, detail=0)
        full_text = '\n'.join(result)
        
        return jsonify({'text': full_text})
    
    except Exception as e:
        print(f"OCR Error: {str(e)}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(host='0.0.0.0', port=port)
