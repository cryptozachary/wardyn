import { promises as fs } from "fs"; import path from "path";

export const parameters = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["read", "write"], description: "File operation to perform" },
    filePath: { type: "string", description: "Relative path inside sandbox (e.g. 'notes/todo.txt')" },
    data: { type: "string", description: "Content to write (only for action='write')" }
  },
  required: ["action", "filePath"]
};

export async function execute(args: any): Promise<string> {
  const { action, filePath, data } = args;
  if (typeof filePath !== "string") throw new Error("filePath required");
  if (filePath.includes("..") || path.isAbsolute(filePath)) throw new Error("Path outside sandbox");
  const full = path.join(process.cwd(), "sandbox", filePath);
  if (action === "read") return await fs.readFile(full, "utf8");
  if (action === "write") { await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, data ?? "", "utf8"); return "ok"; }
  throw new Error("Unknown action");
}
