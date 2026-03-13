# database_skill
Purpose: SQLite database operations inside the sandbox. Create tables, query data, track things over time. Each database is a .db file in sandbox/.
Call name: "database_skill"
Actions:
- query: Run a SELECT query. Args: { action: "query", sql: "SELECT * FROM users", database?: "default", format?: "json"|"csv"|"table", safeMode?: true }
- execute: Run INSERT/UPDATE/DELETE/CREATE. Args: { action: "execute", sql: "CREATE TABLE ...", database?: "default", safeMode?: false }
- tables: List all tables. Args: { action: "tables", database?: "default" }
- schema: Show full schema. Args: { action: "schema", database?: "default" }
- export: Dump database to .sql file. Args: { action: "export", database?: "default" }
Security:
- All SQLite dot-commands blocked (not just .system/.shell — includes .output, .import, .read, etc.)
- ATTACH DATABASE, DETACH DATABASE, and LOAD_EXTENSION blocked
- Safe mode: set safeMode=true to block all write/DDL operations (INSERT/UPDATE/DELETE/CREATE/DROP/ALTER)
- Database names strictly validated: letters, digits, hyphens, underscores only (no silent stripping)
- Export path validated to stay within sandbox
- Row limits enforced at query level via LIMIT injection (not post-load truncation)
- sqlite3 CLI auto-detected with platform-specific install instructions on failure
- 10s query timeout, 500 row max, 50KB SQL max
Returns: JSON with { status, action, data, rows, truncated, affectedRows, database, elapsedMs }
