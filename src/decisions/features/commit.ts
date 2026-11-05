import { inputHash } from "../../adjudicator/redact.js";
import { loadConfig } from "../../config.js";
import { git } from "../../history/log.js";
import { redactDiff } from "../diff-redact.js";
import type { DecisionFeatureModule } from "../feature.js";
import {
  type Answers,
  type AskInput,
  clears,
  type Decision,
  type DecisionQuestionSpec,
} from "../types.js";

/**
 * Decision feature "commit" (docs/design/jev-integration-options.md, option C): before a
 * `git commit`, ask a few yes/no questions about the staged diff and the commit message and
 * leave ONE advice line. It never blocks the commit and never edits anything.
 *
 * Hook path: PreToolUse only recognises `git commit` and queues one detached job; no git, no
 * network. The job reads the staged diff, strips it down (src/decisions/diff-redact.ts: allow and
 * deny globs, added lines only, secret values and blobs removed, small cut), asks one call and,
 * in live mode, stores the advice line as a note that the next PostToolUse / prompt delivers.
 * Shadow, off, unsupported, timeout and error leave no note: the output is as it was.
 */

const QUESTION_VERSION = 1;
const MESSAGE_CHARS = 600;
const COMMAND_CHARS = 4000;
const GIT_COMMIT = /(^|[;&|]\s*)git\s+commit\b/;

/** Every question is worded so that "yes" is the problem. */
const QUESTIONS: Array<DecisionQuestionSpec & { advice: string }> = [
  {
    name: "message_mismatch",
    kind: "yes_no",
    instructions:
      "The state holds a commit message and, in item {item}, the lines a commit adds. Does the message misdescribe what the added lines do?",
    advice: "the message may not match the change",
  },
  {
    name: "debug_leftover",
    kind: "yes_no",
    instructions:
      "Do the added lines in item {item} contain debugging leftovers such as console.log or print calls, debugger statements, commented-out code, or TODO/FIXME markers added just now?",
    advice: "the diff may contain debug leftovers",
  },
  {
    name: "unmentioned_work",
    kind: "yes_no",
    instructions:
      "Do the added lines in item {item} include a substantial change that the commit message in the state does not mention at all?",
    advice: "the diff may include work the message does not mention",
  },
  {
    name: "credential",
    kind: "yes_no",
    instructions:
      "Do the added lines in item {item} appear to contain a credential, token, password or private key, or an assignment whose value was redacted from a secret-named variable?",
    advice: "the diff may contain a credential",
  },
];

interface Payload {
  command: string;
}

/** The commit message from a `git commit` command line: -m / --message, or a heredoc body. */
export function commitMessage(cmd: string): string {
  const parts: string[] = [];
  const heredoc = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2(?=\s|\)|$)/.exec(cmd);
  if (heredoc) parts.push(heredoc[3] as string);
  const re = /(?:^|\s)(?:-[a-zA-Z]*m|--message)(?:=|\s+)(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/g;
  for (let m = re.exec(cmd); m; m = re.exec(cmd)) {
    const v = m[1] ?? m[2] ?? m[3] ?? "";
    // a $(cat <<EOF ...) argument is the heredoc already read above
    if (!/^\$\(/.test(v)) parts.push(v);
  }
  return parts.join("\n\n").trim().slice(0, MESSAGE_CHARS);
}

function stagedDiff(root: string, cmd: string): string {
  const all = /\s(-[a-zA-Z]*a[a-zA-Z]*|--all)\b/.test(cmd);
  const args = ["diff", "--no-color", "--no-ext-diff", "-U0", all ? "HEAD" : "--cached"];
  return git(root, args, { allowFail: true });
}

/** The ask input for a diff summary and a message; undefined when there is nothing to send. */
function inputOf(
  summary: string,
  message: string,
  sessionId?: string,
): Omit<AskInput, "budgetMs"> | undefined {
  if (!summary) return undefined;
  return {
    feature: "commit",
    subject: `commit:${inputHash(`${message}\n${summary}`).slice(0, 12)}`,
    context: `Commit message:\n${message || "(none given on the command line)"}`,
    items: [{ id: "diff", text: summary, label: "staged diff" }],
    questions: QUESTIONS.map(({ advice: _a, ...q }) => q),
    baseline: { advice: "none" },
    questionVersion: QUESTION_VERSION,
    ...(sessionId ? { sessionId } : {}),
  };
}

function decideCommit(minProb: number) {
  return (answers: Answers): Decision => {
    const per = answers.diff ?? {};
    const hits = QUESTIONS.filter((q) => clears(per[q.name], minProb));
    if (!hits.length) return { decision: { advice: "none" }, changed: 0 };
    const note = `commit advice: ${hits.map((q) => q.advice).join("; ")}; take a second look before pushing`;
    return { decision: { advice: hits.map((q) => q.name) }, changed: 1, note };
  };
}

export const feature: DecisionFeatureModule = {
  questionVersion: QUESTION_VERSION,

  preToolUse(_seam, input) {
    try {
      if (input.tool_name !== "Bash") return undefined;
      const cmd = String(input.tool_input?.command ?? "");
      if (!GIT_COMMIT.test(cmd)) return undefined;
      return { command: cmd.slice(0, COMMAND_CHARS) } satisfies Payload;
    } catch {
      return undefined;
    }
  },

  async runJob(job, client) {
    try {
      const p = job.payload as Partial<Payload> | undefined;
      if (!p || typeof p.command !== "string" || !GIT_COMMIT.test(p.command)) return;
      const fc = loadConfig(job.projectRoot).adjudicator.features.commit;
      const red = redactDiff(stagedDiff(job.projectRoot, p.command), {
        maxChars: fc.maxChars,
        exclude: fc.exclude,
      });
      const input = inputOf(red.text, commitMessage(p.command), job.sessionId);
      if (!input) return;
      await client.ask({ ...input, budgetMs: fc.jobMs }, decideCommit(fc.minProb));
    } catch {
      // a job never throws
    }
  },
};
