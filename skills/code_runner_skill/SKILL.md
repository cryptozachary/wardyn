# code_runner_skill
Purpose: Run isolated JavaScript or Python code snippets for computation, math, data processing, and text manipulation. Use this instead of exec_skill when you need to compute something without system access.
Call name: "code_runner_skill"
Args: { language: "javascript"|"python", code: "console.log(2+2)", timeout?: 10000 }
Rules:
- Use console.log() for JavaScript output, print() for Python output.
- File, network, and system access is blocked — use dedicated skills for those.
- Max 30s timeout, 10KB output limit.
- Code runs in sandbox/ directory.
Security: Blocks require('fs'), require('child_process'), import os, import subprocess, process.exit, eval(), exec(), and other system access patterns.
Returns: JSON with { status, language, output, truncated?, elapsedMs }
