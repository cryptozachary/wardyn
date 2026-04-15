import { randomUUID } from "crypto";
import { getDb } from "../db.js";

export type CanvasKind = "markdown" | "table" | "chart" | "html" | "code" | "json";

export interface CanvasItem {
  id: string;
  sessionId: string;
  kind: CanvasKind;
  title: string | null;
  data: unknown;
  createdAt: number;
}

export function pushCanvas(sessionId: string, kind: CanvasKind, data: unknown, title?: string): CanvasItem {
  const db = getDb();
  const item: CanvasItem = {
    id: randomUUID(),
    sessionId,
    kind,
    title: title ?? null,
    data,
    createdAt: Date.now(),
  };
  db.prepare(
    `INSERT INTO canvas_items (id, session_id, kind, title, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(item.id, item.sessionId, item.kind, item.title, JSON.stringify(item.data), item.createdAt);
  return item;
}

export function listCanvas(sessionId?: string, limit = 100): CanvasItem[] {
  const db = getDb();
  const rows = sessionId
    ? db.prepare(
        `SELECT * FROM canvas_items WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`
      ).all(sessionId, limit)
    : db.prepare(
        `SELECT * FROM canvas_items ORDER BY created_at DESC LIMIT ?`
      ).all(limit);
  return (rows as any[]).map(mapRow);
}

export function getCanvas(id: string): CanvasItem | null {
  const db = getDb();
  const r = db.prepare("SELECT * FROM canvas_items WHERE id = ?").get(id) as any;
  return r ? mapRow(r) : null;
}

export function clearCanvas(sessionId?: string): number {
  const db = getDb();
  const r = sessionId
    ? db.prepare("DELETE FROM canvas_items WHERE session_id = ?").run(sessionId)
    : db.prepare("DELETE FROM canvas_items").run();
  return r.changes;
}

function mapRow(r: any): CanvasItem {
  let data: unknown;
  try { data = JSON.parse(r.data); } catch { data = r.data; }
  return {
    id: r.id,
    sessionId: r.session_id,
    kind: r.kind,
    title: r.title ?? null,
    data,
    createdAt: r.created_at,
  };
}
