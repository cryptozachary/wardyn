const BLOCK_PATTERNS = [
  /\brm\s+-rf\b/i, /\bsudo\b/i, /\bchown\b/i,
  /curl\s+.+\|\s+bash/i, /\bmkfs\b/i, /\bmount\b/i, /\bscp\b.*@/i
];
export function assertSafe(command: string) {
  if (BLOCK_PATTERNS.some(rx => rx.test(command))) throw new Error(`Blocked command by SafetySpine: ${command}`);
}
