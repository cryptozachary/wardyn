# json_transform_skill
Purpose: Query, transform, merge, diff, flatten, and manipulate JSON data without code execution.
Call name: "json_transform_skill"
Actions:
- query: Extract values using dot-notation paths. Args: { action: "query", data: {...}, path: "users[0].name" }
- transform: Modify JSON with operations. Args: { action: "transform", data: {...}, op: "get|set|delete|pick|omit|sort|filter|map|group", ... }
  - get: Extract at path. { op: "get", path: "a.b.c" }
  - set: Set value at path. { op: "set", path: "a.b", value: 42 }
  - delete: Remove at path. { op: "delete", path: "a.b" }
  - pick: Keep only specified keys. { op: "pick", keys: ["name", "age"] }
  - omit: Remove specified keys. { op: "omit", keys: ["password", "secret"] }
  - sort: Sort array. { op: "sort", sortBy: "name", sortOrder: "asc"|"desc" }
  - filter: Filter array. { op: "filter", filterExpr: "age > 18" }
  - map: Extract fields from array items. { op: "map", path: "name" } or { op: "map", keys: ["name", "email"] }
  - group: Group array by key. { op: "group", groupBy: "category" }
- merge: Deep or shallow merge two objects. Args: { action: "merge", data: {...}, data2: {...}, mergeStrategy?: "deep"|"shallow" }
- diff: Compare two JSON objects. Args: { action: "diff", data: {...}, data2: {...} }
- flatten: Flatten nested object to dot-notation. Args: { action: "flatten", data: {...}, separator?: "." }
- unflatten: Restore flattened object. Args: { action: "unflatten", data: {...}, separator?: "." }
- validate: Analyze JSON structure. Args: { action: "validate", data: {...} }
- format: Pretty-print JSON. Args: { action: "format", data: {...}, indent?: 2 }
Filter operators: ==, !=, >, <, >=, <=, contains, startsWith, endsWith
Path syntax: dot notation with array indices — "users[0].name", "items[*].price"
Limits: 1MB max input, 20 levels max nesting depth.
Returns: JSON with { status, action, result, elapsedMs }
