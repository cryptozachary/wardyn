import { promises as fs } from "fs"; import path from "path";
export async function execute(args: any): Promise<string> {
  const { action, filePath, data } = args;
  if (typeof filePath !== "string") throw new Error("filePath required");
  if (filePath.includes("..") || path.isAbsolute(filePath)) throw new Error("Path outside sandbox");
  const full = path.join(process.cwd(), "sandbox", filePath);
  if (action === "read") return await fs.readFile(full, "utf8");
  if (action === "write") { await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, data ?? "", "utf8"); return "ok"; }
  throw new Error("Unknown action");
}
