## File Output

When saving files (images, downloads, generated content, etc.), always save to the `output/` directory in the project root. These files are accessible to the user via HTTP at `/output/<filename>`.

Example: if you save a file to `output/grayscale_image.png`, provide the user with the link: `/output/grayscale_image.png`

Always tell the user the download link after saving a file.
