export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["query", "transform", "merge", "diff", "flatten", "unflatten", "validate", "format"],
      description: "JSON action to perform",
    },
    data: { type: "object", description: "Input JSON object or array" },
    data2: { type: "object", description: "Second JSON object (for merge/diff)" },
    path: { type: "string", description: "JSONPath-like dot notation path (e.g. 'users[0].name', 'items[*].price')" },
    value: { description: "Value to set at path (for transform with op=set)" },
    op: {
      type: "string",
      enum: ["get", "set", "delete", "pick", "omit", "sort", "filter", "map", "group"],
      description: "Transform operation (default: get)",
    },
    keys: {
      type: "array",
      items: { type: "string" },
      description: "Keys for pick/omit operations",
    },
    sortBy: { type: "string", description: "Key to sort by (for sort op)" },
    sortOrder: { type: "string", enum: ["asc", "desc"], description: "Sort order (default: asc)" },
    filterExpr: { type: "string", description: "Filter expression: 'key op value' (e.g. 'age > 18', 'status == active')" },
    groupBy: { type: "string", description: "Key to group by (for group op)" },
    separator: { type: "string", description: "Separator for flatten/unflatten (default: '.')" },
    indent: { type: "number", description: "Indentation for format (default: 2)" },
    mergeStrategy: { type: "string", enum: ["shallow", "deep"], description: "Merge strategy (default: deep)" },
  },
  required: ["action"],
};

/* ────────────────────── constants ────────────────────── */

const MAX_INPUT_SIZE = 1024 * 1024; // 1MB when serialized
const MAX_DEPTH = 20;

/* ────────────────────── execute ────────────────────── */

export async function execute(args: any): Promise<string> {
  const start = Date.now();
  const { action, data } = args;

  try {
    // Size guard
    const serialized = JSON.stringify(data ?? {});
    if (serialized.length > MAX_INPUT_SIZE) {
      throw new Error(`Input too large (${(serialized.length / 1024).toFixed(0)}KB, max 1MB)`);
    }

    let result: any;

    switch (action) {
      case "query": {
        const { path: jsonPath } = args;
        if (!jsonPath) throw new Error("path is required for query");
        result = resolvePath(data, jsonPath);
        break;
      }

      case "transform": {
        const { op = "get", path: jsonPath } = args;
        result = applyTransform(data, op, args);
        break;
      }

      case "merge": {
        const { data2, mergeStrategy = "deep" } = args;
        if (!data2) throw new Error("data2 is required for merge");
        result = mergeStrategy === "deep" ? deepMerge(data, data2) : { ...data, ...data2 };
        break;
      }

      case "diff": {
        const { data2 } = args;
        if (!data2) throw new Error("data2 is required for diff");
        result = jsonDiff(data, data2);
        break;
      }

      case "flatten": {
        const { separator = "." } = args;
        result = flattenObj(data, separator);
        break;
      }

      case "unflatten": {
        const { separator = "." } = args;
        result = unflattenObj(data, separator);
        break;
      }

      case "validate": {
        result = validateJson(data);
        break;
      }

      case "format": {
        const { indent = 2 } = args;
        const formatted = JSON.stringify(data, null, Math.min(indent, 8));
        result = { formatted, chars: formatted.length };
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}. Use: query, transform, merge, diff, flatten, unflatten, validate, format`);
    }

    return JSON.stringify({ status: "ok", action, result, elapsedMs: Date.now() - start });
  } catch (err: any) {
    return JSON.stringify({ status: "error", action, error: err.message, elapsedMs: Date.now() - start });
  }
}

/* ────────────────────── path resolution ────────────────────── */

function resolvePath(obj: any, pathStr: string): any {
  if (!pathStr || pathStr === "$" || pathStr === ".") return obj;

  const parts = parsePath(pathStr);
  let current = obj;

  for (const part of parts) {
    if (current == null) return undefined;

    if (part === "*" || part === "[*]") {
      // Wildcard — map over array/object values
      if (Array.isArray(current)) return current;
      if (typeof current === "object") return Object.values(current);
      return undefined;
    }

    const idx = /^\[(\d+)\]$/.exec(part);
    if (idx) {
      current = Array.isArray(current) ? current[parseInt(idx[1], 10)] : undefined;
    } else {
      current = typeof current === "object" && current !== null ? current[part] : undefined;
    }
  }

  return current;
}

function parsePath(pathStr: string): string[] {
  // Handle: "users[0].name", "a.b.c", "items[*].price"
  const parts: string[] = [];
  const re = /([^.\[\]]+)|\[(\d+|\*)\]/g;
  let m;
  while ((m = re.exec(pathStr)) !== null) {
    parts.push(m[2] !== undefined ? `[${m[2]}]` : m[1]);
  }
  return parts;
}

function setAtPath(obj: any, pathStr: string, value: any): any {
  const result = structuredClone(obj);
  const parts = parsePath(pathStr);
  let current = result;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const idx = /^\[(\d+)\]$/.exec(part);
    const key = idx ? parseInt(idx[1], 10) : part;
    if (current[key] == null) {
      // Create array or object based on next part
      const nextIdx = /^\[(\d+)\]$/.exec(parts[i + 1]);
      current[key] = nextIdx ? [] : {};
    }
    current = current[key];
  }

  const lastPart = parts[parts.length - 1];
  const lastIdx = /^\[(\d+)\]$/.exec(lastPart);
  current[lastIdx ? parseInt(lastIdx[1], 10) : lastPart] = value;
  return result;
}

function deleteAtPath(obj: any, pathStr: string): any {
  const result = structuredClone(obj);
  const parts = parsePath(pathStr);
  let current = result;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const idx = /^\[(\d+)\]$/.exec(part);
    current = current[idx ? parseInt(idx[1], 10) : part];
    if (current == null) return result;
  }

  const lastPart = parts[parts.length - 1];
  const lastIdx = /^\[(\d+)\]$/.exec(lastPart);
  if (lastIdx && Array.isArray(current)) {
    current.splice(parseInt(lastIdx[1], 10), 1);
  } else {
    delete current[lastPart];
  }
  return result;
}

/* ────────────────────── transforms ────────────────────── */

function applyTransform(data: any, op: string, args: any): any {
  switch (op) {
    case "get":
      return resolvePath(data, args.path);

    case "set":
      if (!args.path) throw new Error("path is required for set");
      return setAtPath(data, args.path, args.value);

    case "delete":
      if (!args.path) throw new Error("path is required for delete");
      return deleteAtPath(data, args.path);

    case "pick": {
      if (!args.keys || !Array.isArray(args.keys)) throw new Error("keys array required for pick");
      const result: any = {};
      for (const k of args.keys) {
        if (k in data) result[k] = data[k];
      }
      return result;
    }

    case "omit": {
      if (!args.keys || !Array.isArray(args.keys)) throw new Error("keys array required for omit");
      const omitSet = new Set(args.keys);
      const result: any = {};
      for (const [k, v] of Object.entries(data)) {
        if (!omitSet.has(k)) result[k] = v;
      }
      return result;
    }

    case "sort": {
      if (!Array.isArray(data)) throw new Error("sort requires an array");
      const { sortBy, sortOrder = "asc" } = args;
      const sorted = [...data].sort((a, b) => {
        const va = sortBy ? a?.[sortBy] : a;
        const vb = sortBy ? b?.[sortBy] : b;
        if (va < vb) return sortOrder === "asc" ? -1 : 1;
        if (va > vb) return sortOrder === "asc" ? 1 : -1;
        return 0;
      });
      return sorted;
    }

    case "filter": {
      if (!Array.isArray(data)) throw new Error("filter requires an array");
      const { filterExpr } = args;
      if (!filterExpr) throw new Error("filterExpr required (e.g. 'age > 18')");
      return applyFilter(data, filterExpr);
    }

    case "map": {
      if (!Array.isArray(data)) throw new Error("map requires an array");
      const { path: mapPath, keys } = args;
      if (mapPath) {
        return data.map((item) => resolvePath(item, mapPath));
      }
      if (keys && Array.isArray(keys)) {
        return data.map((item: any) => {
          const result: any = {};
          for (const k of keys) result[k] = item?.[k];
          return result;
        });
      }
      throw new Error("map requires path or keys");
    }

    case "group": {
      if (!Array.isArray(data)) throw new Error("group requires an array");
      const { groupBy } = args;
      if (!groupBy) throw new Error("groupBy key required");
      const groups: Record<string, any[]> = {};
      for (const item of data) {
        const key = String(item?.[groupBy] ?? "undefined");
        (groups[key] ??= []).push(item);
      }
      return groups;
    }

    default:
      throw new Error(`Unknown op: ${op}`);
  }
}

function applyFilter(arr: any[], expr: string): any[] {
  // Parse "key op value" expressions
  const match = expr.match(/^(\w+)\s*(==|!=|>|<|>=|<=|contains|startsWith|endsWith)\s*(.+)$/);
  if (!match) throw new Error(`Invalid filter expression: "${expr}". Use format: key op value`);

  const [, key, operator, rawValue] = match;
  const value = parseFilterValue(rawValue.trim());

  return arr.filter((item) => {
    const itemVal = item?.[key];
    switch (operator) {
      case "==":
        return itemVal == value;
      case "!=":
        return itemVal != value;
      case ">":
        return itemVal > value;
      case "<":
        return itemVal < value;
      case ">=":
        return itemVal >= value;
      case "<=":
        return itemVal <= value;
      case "contains":
        return String(itemVal).includes(String(value));
      case "startsWith":
        return String(itemVal).startsWith(String(value));
      case "endsWith":
        return String(itemVal).endsWith(String(value));
      default:
        return false;
    }
  });
}

function parseFilterValue(raw: string): any {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // Strip quotes
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

/* ────────────────────── merge ────────────────────── */

function deepMerge(target: any, source: any, depth = 0): any {
  if (depth > MAX_DEPTH) return source;
  if (!isPlainObject(target) || !isPlainObject(source)) return source;

  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (isPlainObject(source[key]) && isPlainObject(target[key])) {
      result[key] = deepMerge(target[key], source[key], depth + 1);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function isPlainObject(val: any): val is Record<string, any> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

/* ────────────────────── diff ────────────────────── */

interface DiffEntry {
  path: string;
  type: "added" | "removed" | "changed";
  oldValue?: any;
  newValue?: any;
}

function jsonDiff(a: any, b: any, prefix = "", depth = 0): DiffEntry[] {
  if (depth > MAX_DEPTH) return [];
  const diffs: DiffEntry[] = [];

  if (isPlainObject(a) && isPlainObject(b)) {
    const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of allKeys) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (!(key in a)) {
        diffs.push({ path: p, type: "added", newValue: b[key] });
      } else if (!(key in b)) {
        diffs.push({ path: p, type: "removed", oldValue: a[key] });
      } else if (isPlainObject(a[key]) && isPlainObject(b[key])) {
        diffs.push(...jsonDiff(a[key], b[key], p, depth + 1));
      } else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
        diffs.push({ path: p, type: "changed", oldValue: a[key], newValue: b[key] });
      }
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    diffs.push({ path: prefix || "$", type: "changed", oldValue: a, newValue: b });
  }

  return diffs;
}

/* ────────────────────── flatten / unflatten ────────────────────── */

function flattenObj(obj: any, sep: string, prefix = "", depth = 0): Record<string, any> {
  if (depth > MAX_DEPTH) return { [prefix]: obj };
  const result: Record<string, any> = {};

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const key = prefix ? `${prefix}[${i}]` : `[${i}]`;
      if (isPlainObject(obj[i]) || Array.isArray(obj[i])) {
        Object.assign(result, flattenObj(obj[i], sep, key, depth + 1));
      } else {
        result[key] = obj[i];
      }
    }
  } else if (isPlainObject(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}${sep}${k}` : k;
      if (isPlainObject(v) || Array.isArray(v)) {
        Object.assign(result, flattenObj(v, sep, key, depth + 1));
      } else {
        result[key] = v;
      }
    }
  } else {
    result[prefix || "$"] = obj;
  }

  return result;
}

function unflattenObj(obj: Record<string, any>, sep: string): any {
  const result: any = {};

  for (const [flatKey, value] of Object.entries(obj)) {
    const parts = flatKey.split(sep);
    let current = result;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] == null) {
        // Peek next part to decide array or object
        current[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      }
      current = current[part];
    }

    current[parts[parts.length - 1]] = value;
  }

  return result;
}

/* ────────────────────── validate ────────────────────── */

function validateJson(data: any): any {
  const stats = analyzeStructure(data);
  return {
    valid: true,
    type: Array.isArray(data) ? "array" : typeof data,
    ...stats,
  };
}

function analyzeStructure(data: any, depth = 0): any {
  if (depth > MAX_DEPTH) return { depth, truncated: true };

  if (Array.isArray(data)) {
    const types = new Set(data.map((item) => (Array.isArray(item) ? "array" : typeof item)));
    return {
      length: data.length,
      itemTypes: [...types],
      depth,
    };
  }

  if (isPlainObject(data)) {
    const keys = Object.keys(data);
    return {
      keys: keys.length,
      keyNames: keys.slice(0, 50),
      depth,
    };
  }

  return { type: typeof data, depth };
}
