import { storeKey } from "../src/security/keyVault.js";
const key = process.env.OPENAI_API_KEY; const pass = process.env.KEY_PASSPHRASE;
if (!key || !pass) throw new Error("OPENAI_API_KEY and KEY_PASSPHRASE required");
storeKey("openai", key, pass);
console.log("Stored encrypted key at config/providers.enc");
