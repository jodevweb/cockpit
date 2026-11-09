#!/usr/bin/env node
// Outil de revue du cockpit — écrit sur le disque par le cockpit.
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const FINDING = {
  type: "object",
  properties: {
    id: { type: "string", description: "Short, stable identifier, e.g. R1, R2… Keep the identifier of a point already raised in a previous round." },
    severity: { type: "string", enum: ["bloquant", "important", "suggestion"], description: "bloquant = blocking. Use these enum values exactly as written." },
    file: { type: "string", description: "File path, relative to the repository root." },
    lines: { type: "string", description: "Line(s) in the PR version: \"42\" or \"42-57\"." },
    problem: { type: "string", description: "The problem, in one or two sentences." },
    fix: { type: "string", description: "The fix you would make, concretely." },
    comment: { type: "string", description: "The comment, simple and human, that the person will post themselves on this line of the PR." },
  },
  required: ["id", "severity", "file", "lines", "problem", "fix", "comment"],
};
const TOOLS = [
  {
    name: "remettre_revue",
    description:
      "Hands your review over to Cockpit, which displays it point by point. Call it once, at the end. You post nothing yourself on the PR.",
    inputSchema: {
      type: "object",
      properties: {
        pr: { type: "number", description: "The number of the reviewed PR." },
        kind: { type: "string", enum: ["revue", "verification"], description: "revue = full review. Use these enum values exactly as written." },
        summary: { type: "string", description: "What the PR does and how, to understand it: 10 lines at most, no fluff." },
        verdict: { type: "string", enum: ["merge", "corrections", "bloquant"], description: "merge: all good, the person can merge. corrections: changes needed. bloquant: blocking. Use these enum values exactly as written." },
        findings: { type: "array", items: FINDING, description: "The points raised in this round: blocking, important, suggestions. Empty if none." },
        checks: {
          type: "array",
          description: "For a verification: what became of each point from the previous round (corrige = fixed, partiel = partly fixed, non_corrige = not fixed).",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string", enum: ["corrige", "partiel", "non_corrige"] },
              note: { type: "string" },
            },
            required: ["id", "status"],
          },
        },
      },
      required: ["pr", "kind", "summary", "verdict", "findings"],
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
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cockpit-revue", version: "1.0.0" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    } else if (message.method === "tools/call") {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "Review handed over to Cockpit. Finish with one summary sentence, without repeating the points." }] } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});
