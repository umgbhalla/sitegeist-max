export const WORKFLOW_TOOL_DESCRIPTION = `Run a dynamic workflow: a small JavaScript orchestration script that spawns and coordinates isolated sub-agents, keeping intermediate results in local variables instead of your chat context. Use it for work that fans out (audit N files, research M angles, compare options) or where cheap sub-agents do the bulk work while you synthesize.

ISOLATION — READ THIS FIRST. The script runs in a locked-down sandbox, and every sub-agent you spawn is a FRESH, isolated context. Neither the script nor its sub-agents can see your conversation, the user's messages, pages or files you already read, or the output of your earlier tool calls. They know ONLY what you put in the prompt string you pass to agent(). You must hand over everything explicitly.

NEVER USE PLACEHOLDERS. Do not write "PLACEHOLDER", "<paste content here>", "YOUR_DATA", "TODO", "..." (or anything similar) expecting the sandbox to fill it in. It cannot. The script runs on that literal string, or crashes on undefined. Put the REAL data in the "args" parameter (or interpolate it into the prompt) BEFORE calling this tool. Placeholder-looking args are flagged in the result.

PASSING DATA IN — the "args" parameter:
- Whatever JSON value you send as "args" is available inside the script as the global \`args\` (it is \`null\` if you omit it). Use it to inject real file contents, URLs, lists, or config the sub-agents need.
- Example: args = { files: ["src/a.ts","src/b.ts"], style: "strict" }  ->  the script reads args.files and args.style.

ASYNC GLOBALS injected into the sandbox:
- await agent(prompt, opts?) -> string : spawn one isolated sub-agent, return its final text. opts: { tier?: "small"|"medium"|"big", model?: {provider,id}, systemPrompt?: string }.
- await parallel(thunks) -> string[] : run an array of () => agent(...) thunks concurrently (capped at 3), results in input order.
- await listArtifacts() -> string[] : names of the artifacts in this session.
- await getArtifact(name) -> string : the content of an artifact by name (.json artifacts are parsed to objects). PREFER this over pasting large data into args when the data already lives in an artifact.
- phase(name) : label the following agents in the live progress panel.
- log(msg, data?) : emit a progress line (also shown in the workflow debug log).
- args : the value you passed in the "args" parameter (null if omitted).

RULES: the script body IS the program (top-level await allowed). Return a value to summarize the run. agent() returns a plain string with no guaranteed shape — parse it DEFENSIVELY: guard before .split()/JSON.parse and handle empty output. Do NOT access the network, filesystem, DOM, or window. Do NOT define helpers you never call. Keep it short.

Example 1 — inject real data via args (no placeholders):
  // You send args = { diff: "<the ACTUAL diff text>", rules: "no console.log; handle errors" }
  phase('review');
  if (!args || !args.diff) return 'No diff provided in args.';
  return await agent('Review this diff against the rules.\\nRules: ' + args.rules + '\\n\\nDiff:\\n' + args.diff, { tier: 'big' });

Example 2 — fan out then synthesize, parsing agent() output defensively:
  phase('scan');
  const raw = await agent('List route files under src/routes, one per line, no prose.', { tier: 'small' });
  const files = raw.split('\\n').map((s) => s.trim()).filter(Boolean);
  if (files.length === 0) return 'No route files found.';
  phase('review');
  const findings = await parallel(files.map((f) => () => agent('Audit ' + f + ' for missing auth checks.', { tier: 'medium' })));
  phase('synthesize');
  return await agent('Synthesize these findings:\\n' + findings.join('\\n\\n'), { tier: 'big' });

Example 3 — pull a large input from an artifact instead of args:
  phase('load');
  const names = await listArtifacts();
  if (!names.includes('spec.md')) return 'Artifact spec.md not found.';
  const spec = await getArtifact('spec.md');
  return await agent('Turn this spec into a numbered implementation checklist:\\n' + spec, { tier: 'medium' });`;
