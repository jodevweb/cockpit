#!/usr/bin/env node
// Outils de mission du cockpit — écrit sur le disque par le cockpit.
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".config", "cockpit", "orchestrator");
mkdirSync(DIR, { recursive: true });

// La mission vient de l'environnement : un maître ne peut agir que sur la
// sienne, quoi qu'il écrive dans ses arguments.
const MISSION = process.env.COCKPIT_MISSION_ID ?? "";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function call(tool, input) {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  writeFileSync(
    join(DIR, `${id}.call`),
    JSON.stringify({ id, mission: MISSION, tool, input, at: new Date().toISOString() }),
  );

  const answerPath = join(DIR, `${id}.result`);
  // Créer un worktree et démarrer un agent prend quelques secondes ; deux
  // minutes laissent la place sans laisser le maître attendre indéfiniment.
  for (let waited = 0; waited < 120_000; waited += 200) {
    if (existsSync(answerPath)) {
      const answer = JSON.parse(readFileSync(answerPath, "utf8"));
      unlinkSync(answerPath);
      return answer;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: false, error: "Cockpit did not answer." };
}

const TOOLS = [
  {
    name: "understand",
    description:
      "Guided mission, first step: submit what you understood of the ticket. 10 lines at most, written for a developer discovering the ticket — what is asked, why, what is out of scope. No plan, no breakdown. Whatever you could not settle goes in `questions`. The user approves or corrects: wait for their answer.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "The summary, one idea per line, 10 lines at most." },
        questions: {
          type: "array",
          items: { type: "string" },
          description: "The ambiguities that really change the work, 5 at most. Empty if everything is clear.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "approach",
    description:
      "Guided mission, second step, once your understanding is approved: submit how you intend to go about it. Steps a human can read (what, where in the code, in which order, which risks), 15 lines at most — without splitting between workers yet. The user approves or corrects: wait for their answer before `plan`.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "The approach, 15 lines at most." },
        questions: {
          type: "array",
          items: { type: "string" },
          description: "The choices you would rather have approved, 5 at most.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "plan",
    description:
      "Submit the mission breakdown. The tasks then wait for the user's approval: nothing starts before that.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "The plan in a few sentences." },
        tasks: {
          type: "array",
          description: "One entry per worker.",
          items: {
            type: "object",
            properties: {
              role: { type: "string", description: "Catalog role: backend, frontend, qa, review." },
              title: { type: "string" },
              brief: { type: "string", description: "Complete instructions, contracts included." },
              scope: {
                type: "array",
                items: { type: "string" },
                description: "Paths this task may write to. File edits elsewhere are refused, and a branch that changes anything else is not merged.",
              },
              base: { type: "string", description: "Starting branch; empty = integration branch." },
              branch: { type: "string" },
            },
            required: ["role", "title"],
          },
        },
      },
      required: ["summary", "tasks"],
    },
  },
  {
    name: "status",
    description: "State of the mission and of each of its tasks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "spawn",
    description:
      "Creates the branch and worktree of an approved task, then launches its worker. Refused until the plan is approved.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "rework",
    description:
      "Sends a task back for rework with what is wrong with it. Call it when QA or a review rejects: the task restarts in its worktree, its work intact, and the checks will judge again afterwards. This is how a verdict travels down to whoever must fix it.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        reason: {
          type: "string",
          description:
            "What must be fixed, precisely: this text is appended to the worker's instructions, and the worker will not have read the report.",
        },
      },
      required: ["taskId", "reason"],
    },
  },
  {
    name: "collect",
    description: "What a task produced: commits and files touched.",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "report",
    description:
      "Records the mission report: what was done, how it works, where to look, how to verify it. Write it for someone who did not follow the work.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "In Markdown, short and concrete: what changes for the user, the entry points in the code, the contracts between the parts, what one needs to know to pick it up.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "pr",
    description:
      "Opens the pull request of the integration branch, closes the mission and cleans up the worktrees. Only call it once everything is integrated and approved. If the team opens its PRs with a repository command, the tool gives it back to you on the first call: run it, then call `pr` again with `url`.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "What the mission changes, and how to verify it." },
        base: {
          type: "string",
          description:
            "Branch to base the PR on. Only fill it in if the mission extends work in progress: the PR then stacks on top of it and only shows what the mission adds. Empty = the repository's default branch.",
        },
        url: {
          type: "string",
          description:
            "URL of a pull request that is already open — the one the team command just produced. When set, Cockpit opens nothing: it closes the mission on this PR.",
        },
      },
    },
  },
  {
    name: "integrate",
    description:
      "Merges the delivered branches into the integration branch. Returns the conflicts to resolve, without forcing anything. When the repository declares checks, a task is merged only once they pass: failed ones come back in `gatesFailed` with their output (send them to `rework`), running ones in `gatesPending`. A task whose branch changes files outside its scope comes back in `scopeFailed` with those files (send it to `rework` too).",
    inputSchema: { type: "object", properties: {} },
  },
];

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "cockpit-mission", version: "1.0.0" },
        },
      });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    } else if (message.method === "tools/call") {
      const answer = await call(message.params?.name, message.params?.arguments ?? {});
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(answer) }],
          isError: answer.ok === false,
        },
      });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
