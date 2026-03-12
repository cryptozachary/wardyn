import axios from "axios";
import { promises as fs } from "fs";
import path from "path";
import { getSkillSecret } from "../../src/security/skillSecrets.js";

export const parameters = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Description of the image to generate" },
    size: {
      type: "string",
      enum: ["1024x1024", "1024x1792", "1792x1024", "512x512", "256x256"],
      description: "Image dimensions (default: 1024x1024)",
    },
    quality: {
      type: "string",
      enum: ["standard", "hd"],
      description: "Image quality (default: standard). HD costs more.",
    },
    style: {
      type: "string",
      enum: ["vivid", "natural"],
      description: "Image style (default: vivid)",
    },
  },
  required: ["prompt"],
};

export const secrets = {
  OPENAI_API_KEY: {
    description: "OpenAI API key for DALL-E image generation. If not set, falls back to the provider vault key.",
    required: false,
  },
};

/* ────────────────────── constants ────────────────────── */

const OUTPUT_DIR = path.join(process.cwd(), "output");
const API_URL = "https://api.openai.com/v1/images/generations";

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { prompt, size = "1024x1024", quality = "standard", style = "vivid" } = args;

  if (!prompt || typeof prompt !== "string") {
    return JSON.stringify({ status: "error", error: "prompt is required", elapsedMs: 0 });
  }

  try {
    // Try skill-specific secret first, fall back to provider vault
    let apiKey = getSkillSecret("image_gen_skill", "OPENAI_API_KEY");
    if (!apiKey) {
      // Try loading from the provider vault via loadKeys
      try {
        const { loadKeys } = await import("../../src/security/keyVault.js");
        const keys = loadKeys(process.env.KEY_PASSPHRASE ?? "");
        apiKey = keys["openai"] ?? "";
      } catch {}
    }

    if (!apiKey) {
      throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY in Skill Secrets, or configure an OpenAI key in Setup.");
    }

    const res = await axios.post(
      API_URL,
      {
        model: "dall-e-3",
        prompt,
        n: 1,
        size,
        quality,
        style,
        response_format: "b64_json",
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      },
    );

    const imageData = res.data?.data?.[0];
    if (!imageData?.b64_json) throw new Error("No image data in response");

    // Save to output directory
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const filename = `generated_${Date.now()}.png`;
    const filePath = path.join(OUTPUT_DIR, filename);
    const buffer = Buffer.from(imageData.b64_json, "base64");
    await fs.writeFile(filePath, buffer);

    return JSON.stringify({
      status: "ok",
      prompt,
      path: `/output/${filename}`,
      size,
      quality,
      style,
      revisedPrompt: imageData.revised_prompt || prompt,
      bytes: buffer.length,
      elapsedMs: Date.now() - start,
    });
  } catch (err: any) {
    const msg = err.response?.data?.error?.message || err.message;
    return JSON.stringify({ status: "error", error: msg, elapsedMs: Date.now() - start });
  }
}
