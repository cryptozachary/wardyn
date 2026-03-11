# database_skill
Purpose: SQLite database operations inside the sandbox. Create tables, query data, track things over time. Each database is a .db file in /sandbox.
Call name: "database_skill"
Actions:
- query: Run a SELECT query. Args: { action: "query", sql: "SELECT * FROM users", database?: "default", format?: "json"|"csv"|"table" }
- execute: Run INSERT/UPDATE/DELETE/CREATE. Args: { action: "execute", sql: "CREATE TABLE ...", database?: "default" }
- tables: List all tables. Args: { action: "tables", database?: "default" }
- schema: Show full schema. Args: { action: "schema", database?: "default" }
- export: Dump database to .sql file. Args: { action: "export", database?: "default" }
Security: ATTACH DATABASE and LOAD_EXTENSION are blocked. Databases confined to sandbox/. 10s query timeout. Max 500 rows returned.
Returns: Structured JSON with status, action, data, rows, elapsedMs.
