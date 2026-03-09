import sys, json, requests
from PIL import Image
from io import BytesIO

def main():
    args = json.loads(sys.stdin.read())
    url = args.get('Test URL', '')
    try:
        response = requests.get(url)
        response.raise_for_status()
        image = Image.open(BytesIO(response.content))
        grayscale_image = image.convert('L')
        output = BytesIO()
        grayscale_image.save(output, format='JPEG')
        output.seek(0)
        print('Grayscale image downloaded successfully.')
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()