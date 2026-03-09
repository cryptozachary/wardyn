import sys, json
import requests
from PIL import Image
from io import BytesIO

def main():
    args = json.loads(sys.stdin.read())
    url = args.get('Test URL')
    try:
        response = requests.get(url)
        response.raise_for_status()
        image = Image.open(BytesIO(response.content)).convert('L')
        output = 'grayscale_image.png'
        image.save(output)
        print(output)
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()