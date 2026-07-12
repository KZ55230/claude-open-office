// claude CLIの子ptyへ渡す環境変数の組み立て。TerminalManagerとUsageMonitorの両方から使う。

// このサーバー自身がClaude Codeセッション内から起動された場合に付与される、
// 「自分はネストされた子セッションだ」を示す環境変数。そのまま子ptyへ継承すると
// 新規雇用したclaude CLIが子セッション扱いになり、独立した会話ログ(.jsonl)を
// 作らなくなってしまうため、子ptyへ渡す前に必ず除去する。
const NESTED_SESSION_ENV_EXACT = new Set(["CLAUDECODE"]);
const NESTED_SESSION_ENV_PREFIX = "CLAUDE_CODE_";

/** claude CLIの子ptyに渡す環境変数を組み立てる（process.env継承 + TERM設定） */
export function buildChildEnv(): { [key: string]: string } {
  const env: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (NESTED_SESSION_ENV_EXACT.has(k)) continue;
    if (k.startsWith(NESTED_SESSION_ENV_PREFIX)) continue;
    env[k] = v;
  }
  env.TERM = "xterm-256color";
  return env;
}
