export interface BlockedPattern {
  regex: RegExp;
  label: string;
}

export const BLOCKED_PATTERNS: BlockedPattern[] = [
  // Destructive filesystem operations
  { regex: /\brm\s+-rf\b/i, label: "Destructive filesystem" },
  { regex: /\brm\s+-r\b/i, label: "Destructive filesystem" },
  { regex: /\brm\s+--recursive\b/i, label: "Destructive filesystem" },
  { regex: /\bdel\s+\/[sfq]/i, label: "Destructive filesystem" },
  { regex: /\brmdir\s+\/s/i, label: "Destructive filesystem" },
  // Privilege escalation
  { regex: /\bsudo\b/i, label: "Privilege escalation" },
  { regex: /\bsu\s+-?\b/i, label: "Privilege escalation" },
  { regex: /\bchown\b/i, label: "Privilege escalation" },
  { regex: /\bchmod\s+777\b/i, label: "Privilege escalation" },
  { regex: /\bchmod\s+\+s\b/i, label: "Privilege escalation" },
  // Remote execution / exfiltration
  { regex: /curl\s+.+\|\s*(bash|sh|python)/i, label: "Remote execution" },
  { regex: /wget\s+.+\|\s*(bash|sh)/i, label: "Remote execution" },
  { regex: /\bscp\b.*@/i, label: "Data exfiltration" },
  { regex: /\brsync\b.*@/i, label: "Data exfiltration" },
  { regex: /\bssh\b\s/i, label: "Remote access" },
  // System-level destructive
  { regex: /\bmkfs\b/i, label: "System destructive" },
  { regex: /\bmount\b/i, label: "System destructive" },
  { regex: /\bumount\b/i, label: "System destructive" },
  { regex: /\bdd\s+if=/i, label: "System destructive" },
  { regex: /\bformat\b\s/i, label: "System destructive" },
  { regex: /\bshutdown\b/i, label: "System destructive" },
  { regex: /\breboot\b/i, label: "System destructive" },
  { regex: /\bhalt\b/i, label: "System destructive" },
  { regex: /\bpoweroff\b/i, label: "System destructive" },
  // Windows-specific dangerous commands
  { regex: /\breg\s+(add|delete)/i, label: "Windows system" },
  { regex: /\bnet\s+user\b/i, label: "Windows system" },
  { regex: /\bnet\s+localgroup\b/i, label: "Windows system" },
  { regex: /\bwmic\b/i, label: "Windows system" },
  { regex: /\bsc\s+(delete|stop|config)\b/i, label: "Windows system" },
  // Process/system manipulation
  { regex: /\bkillall\b/i, label: "Process manipulation" },
  { regex: /\bpkill\b/i, label: "Process manipulation" },
  { regex: /kill\s+-9\s+1\b/, label: "Process manipulation" },
  // Reverse shells / code injection
  { regex: /\bnc\s+-[elp]/i, label: "Reverse shell" },
  { regex: /\/dev\/tcp\//i, label: "Reverse shell" },
  { regex: /\beval\s*\(/i, label: "Code injection" },
  { regex: /python\s+-c\s+.*import\s+os/i, label: "Code injection" },
  { regex: /node\s+-e\s+.*child_process/i, label: "Code injection" },
];

export interface CheckResult {
  blocked: boolean;
  patternIndex?: number;
  label?: string;
}

export function checkSafe(command: string): CheckResult {
  for (let i = 0; i < BLOCKED_PATTERNS.length; i++) {
    if (BLOCKED_PATTERNS[i].regex.test(command)) {
      return { blocked: true, patternIndex: i, label: BLOCKED_PATTERNS[i].label };
    }
  }
  return { blocked: false };
}

export function assertSafe(command: string) {
  const result = checkSafe(command);
  if (result.blocked) {
    throw new Error(`Blocked by SafetySpine [${result.label}]: command matches forbidden pattern`);
  }
}
