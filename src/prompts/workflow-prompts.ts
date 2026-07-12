export const WORKFLOW_TOOL_DESCRIPTION = `Run a dynamic workflow: a small JavaScript orchestration script that spawns and coordinates isolated sub-agents, keeping intermediate results in variables instead of your chat context. Use this for work that fans out (audit N files, research M angles, compare options) or that benefits from cheap sub-agents doing bulk work while you synthesize.

The script runs in a sandbox with these async globals injected:
- await agent(prompt, opts?) -> string : spawn one isolated sub-agent, return its final text. opts: { tier?: "small"|"medium"|"big", model?: {provider,id}, systemPrompt?: string }.
- await parallel(thunks) -> string[] : run an array of () => agent(...) thunks concurrently (capped), results in input order.
- phase(name) : label the following agents in the live progress panel.
- log(msg, data?) : emit a progress line.
- args : the value passed in the "args" parameter.

Rules: the script body is the program (top-level await is allowed). Return a value to summarize the run. Do NOT define functions you never call, do NOT access the network, filesystem, DOM, or window. Keep it short.

Example:
  phase('scan');
  const files = (await agent('List route files under src/routes, one per line.', { tier: 'small' })).split('\\n').filter(Boolean);
  phase('review');
  const findings = await parallel(files.map((f) => () => agent('Audit ' + f + ' for missing auth checks.', { tier: 'medium' })));
  phase('synthesize');
  return await agent('Synthesize these findings:\\n' + findings.join('\\n\\n'), { tier: 'big' });`;
