import sys
import json
import requests
from PIL import Image
from io import BytesIO

def main():
    args = json.loads(sys.stdin.read())
    url = args.get('Test URL', '')
    try:
        response = requests.get(url)
        response.raise_for_status()
        img = Image.open(BytesIO(response.content))
        grayscale_img = img.convert('L')
        output_path = 'grayscale_image.png'
        grayscale_img.save(output_path)
        print(f'Image saved as {output_path}')
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()