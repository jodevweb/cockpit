#!/usr/bin/env node
// Outils de tri de la Permanence — écrit sur le disque par le cockpit.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DIR = join(homedir(), ".config", "cockpit", "permanence-triage");
mkdirSync(DIR, { recursive: true });

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

let count = 0;
const record = (verdict, input) => {
  count += 1;
  writeFileSync(
    join(DIR, `${String(count).padStart(4, "0")}-${Date.now()}.json`),
    JSON.stringify({ verdict, ...input }),
  );
};

const TOOLS = [
  {
    name: "signal",
    description:
      "Keep this signal: it matches an active rule and deserves an engagement. Only call this tool if a rule truly applies — keeping one wrongly costs an agent, a branch and quota.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The signal key, exactly as it was given to you." },
        rule: { type: "string", description: "Identifier of the rule that applies." },
        why: { type: "string", description: "In one sentence: why this rule applies here." },
      },
      required: ["key", "rule", "why"],
    },
  },
  {
    name: "intend",
    description:
      "Declare what you intend to do, before doing it. The goal in one sentence a human can read, then the planned actions in order. Call this tool only once, and do not act before: that is what lets your plan be judged without having to suffer it.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "One sentence, in the first person, saying what you will achieve — not how.",
        },
        plan: {
          type: "array",
          description: "The planned actions, in order.",
          items: {
            type: "object",
            properties: {
              what: { type: "string", description: "The action, in plain words." },
              why: { type: "string", description: "Why it is needed." },
            },
            required: ["what"],
          },
        },
        mission: {
          type: "boolean",
          description:
            "True if code must be written: the cockpit will open a mission rather than let you act alone. False for a simple action — rerun, label, report.",
        },
        acts: {
          type: "array",
          description:
            "The actions to take, in order. You do not execute them yourself: the cockpit will play them after checking they are allowed. Request none if none is needed.",
          items: {
            type: "object",
            properties: {
              tool: {
                type: "string",
                description:
                  "rerun_pipeline · set_label · run_command · comment. Nothing else exists.",
              },
              value: {
                type: "string",
                description:
                  "What the action applies to: the label name, the command identifier, the comment text. Empty when the action does not need it.",
              },
            },
            required: ["tool"],
          },
        },
      },
      required: ["goal", "plan"],
    },
  },
  {
    name: "silence",
    description:
      "Dismiss this signal. It is the expected answer most of the time, and it costs nothing: just say why no rule applies.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The signal key, exactly as it was given to you." },
        why: { type: "string", description: "In a few words: why nothing happens." },
      },
      required: ["key", "why"],
    },
  },
];

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
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
          serverInfo: { name: "permanence", version: "1" },
        },
      });
      continue;
    }
    if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
      continue;
    }
    if (message.method === "tools/call") {
      const { name, arguments: input } = message.params ?? {};
      if (name === "signal" || name === "silence" || name === "intend") {
        record(name, input ?? {});
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "noted" }] },
        });
        continue;
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "unknown tool" }], isError: true },
      });
    }
  }
});
