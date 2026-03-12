# image_gen_skill
Purpose: Generate images using OpenAI's DALL-E 3. Saves generated images to /output/ for viewing.
Call name: "image_gen_skill"
Args: { prompt: "a cat wearing a space helmet", size?: "1024x1024", quality?: "standard"|"hd", style?: "vivid"|"natural" }
Sizes: 1024x1024 (square), 1024x1792 (portrait), 1792x1024 (landscape), 512x512, 256x256
Secrets (optional): OPENAI_API_KEY in Skill Secrets. Falls back to the OpenAI key from provider vault if not set.
Returns: JSON with { status, prompt, path, size, quality, style, revisedPrompt, bytes, elapsedMs }
The image is accessible at the returned path (e.g. /output/generated_123.png).
