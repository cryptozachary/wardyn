const BLOCK_PATTERNS = [
  // Destructive filesystem operations
  /\brm\s+-rf\b/i, /\brm\s+-r\b/i, /\brm\s+--recursive\b/i,
  /\bdel\s+\/[sfq]/i, /\brmdir\s+\/s/i,
  // Privilege escalation
  /\bsudo\b/i, /\bsu\s+-?\b/i, /\bchown\b/i, /\bchmod\s+777\b/i, /\bchmod\s+\+s\b/i,
  // Remote execution / exfiltration
  /curl\s+.+\|\s*(bash|sh|python)/i, /wget\s+.+\|\s*(bash|sh)/i,
  /\bscp\b.*@/i, /\brsync\b.*@/i, /\bssh\b\s/i,
  // System-level destructive
  /\bmkfs\b/i, /\bmount\b/i, /\bumount\b/i,
  /\bdd\s+if=/i, /\bformat\b\s/i,
  /\bshutdown\b/i, /\breboot\b/i, /\bhalt\b/i, /\bpoweroff\b/i,
  // Windows-specific dangerous commands
  /\breg\s+(add|delete)/i, /\bnet\s+user\b/i, /\bnet\s+localgroup\b/i,
  /\bwmic\b/i, /\bsc\s+(delete|stop|config)\b/i,
  // Process/system manipulation
  /\bkillall\b/i, /\bpkill\b/i, /kill\s+-9\s+1\b/,
  // Reverse shells / code injection
  /\bnc\s+-[elp]/i, /\/dev\/tcp\//i, /\beval\s*\(/i,
  /python\s+-c\s+.*import\s+os/i, /node\s+-e\s+.*child_process/i
];

export function assertSafe(command: string) {
  const matched = BLOCK_PATTERNS.find(rx => rx.test(command));
  if (matched) throw new Error(`Blocked by SafetySpine: command matches forbidden pattern`);
}
