# Browser code mode

Sitegeist extends its existing sandboxed REPL. The installed `@earendil-works/pi-agent-core` 0.80.6 provides custom AgentTools, sequential execution and progress events. It does not provide the browser recording or durable execution runtime. The REPL now uses sequential tool execution; JavaScript within a call can still compose independent work.

The agent can inspect a site, capture its normal requests, derive an adapter, save that adapter as a versioned tool, and run a checkpointed job. No site names or order schemas are built into the implementation.

```
REPL / generated tools
          |
          v
extension service worker -- CDP events --> response metadata + bodies
          |                               (IndexedDB)
          +-- pinned page execution --> page request client
          +-- packet files -----------> hashes + validated ZIP
          +-- offscreen sandbox ------> job checkpoints + progress
          +-- Google OAuth -----------> identity-checked new Sheets tabs
```

## Learn a site's requests

Use `browser.help()` and `browser.docs(name)` for the complete runtime API. All new calls use an argument object.

1. Resolve the intended tab ID. Keep it explicit for the whole operation.
2. Start `browser.net.start({tabId, pattern})` before normal page navigation or clicks.
3. Inspect `browser.net.list({id})`. It returns response handles, URL, method, status, type, and sanitized request shape.
4. Read selected bodies with `browser.net.body({id: responseId})`, or save them directly using `browser.net.save({id: responseId, packet, name})`.
5. Use `browser.page.contexts({tabId})` and `browser.page.evaluate({tabId,origin,expression})` to inspect the page's MAIN world. `browserjs()` retains its existing USER_SCRIPT semantics.
6. Test `browser.page.request`. If the site's own client adds authentication or signing, pass an `adapter` function expression that calls that client inside the page. Do not copy authorization headers or cookies into generated code.
7. Save the working function using `browser.tools.save({name,description,source})`. `browser.tools.run(name,args)` loads it into the sandbox. Versions are content-addressed and jobs snapshot the selected version.

`Network.replayXHR` is exposed for captured GET/HEAD XHR requests. It does not replay arbitrary fetch calls. Capture bodies can be unavailable after eviction, redirects, cache behavior or debugger detach; errors are returned explicitly. Captures are bounded and must be stopped when finished. Do not enable raw Fetch interception without an event handler that releases paused requests.

## Durable execution

A saved tool receives `(args, browser, job)`. Use stable checkpoint keys and explicit tab IDs:

```js
async (args, browser, job) => {
  for (const item of args.items) {
    await job.step(item.id, async () => {
      await browser.page.navigate({tabId: args.tabId, url: item.url});
      const result = await browser.page.request({
        tabId: args.tabId, origin: args.origin, url: item.apiUrl,
        adapter: args.adapter
      });
      if (result.ok === false) throw new Error(`HTTP ${result.status}`);
      await browser.files.write({
        packet: args.packet, name: `${item.id}.json`,
        data: JSON.stringify(result), mime: 'application/json'
      });
      return {id: item.id};
    }, {idempotent: true, retries: 2});
  }
}
```

Start with `browser.jobs.start({tool,args})`. The offscreen runner continues when the panel closes. The panel shows progress, Cancel and Resume controls. `jobs.get`, `jobs.steps`, and `jobs.list` provide agent access to the same state.

After an execution restart, the script starts again and completed steps return stored results. Arbitrary JavaScript heap state is not checkpointed. Put durable side effects inside steps. Only explicitly idempotent steps retry. Interrupted non-idempotent steps stop for outcome inspection. Cancellation removes the sandbox; commands already sent to a page may finish. Chrome must be running. Missing or changed tabs require the agent to inspect/rebind the target before resuming.

Files are immutable by name and SHA-256. If a partially completed step already wrote a file, inspect and reuse it or choose a new name; do not silently overwrite evidence.

## Original downloads and screenshots

Arm `net.start({tabId,pattern,download:{packet,name}})` before triggering the page's invoice link. The response-stage handler saves the original attachment/PDF bytes, then releases the original response even if saving fails. This supports a download that uses the current tab. Verify `files.list` and capture status afterwards.

`downloads.fetch({tabId,origin,url,packet,name,adapter?})` reads an HTTP or blob URL in its originating page and saves its bytes. Read blob URLs before their page goes away. `downloads.save` exports stored bytes; `downloads.status` distinguishes started, complete, and interrupted downloads.

`screenshot({tabId,packet,orderId,rowSelector,expectedRows,addressSelector})` scroll-loads the actual page, waits for assets, checks row count and clipping, and saves a full-page PNG and evidence JSON. Virtualized rows, nested clipping and oversized pages fail explicitly. Expand or paginate such views with a site-derived tool before capturing. Without expectedRows/addressSelector, those completeness conditions cannot be asserted.

## Packet export

`files.write` accepts text or base64. `files.validate({packet,expected})` checks existence, sizes and SHA-256. `files.export` requires an exhaustive expected list, adds a manifest, creates and reopens the ZIP, verifies every archived file, and starts a Chrome download. Check download completion. Limits: 64 MiB/file and 250 MiB/export. Response bodies and file bytes are stored separately from metadata so listing records does not load all binary content.

## Google Sheets

`browser.sheets.identity()` returns the configured connection or the required redirect URI. Configure a Google OAuth client with that exact redirect URI, then call `sheets.connect({clientId,expectedEmail})`. Access tokens remain in extension storage and are not returned to the model. The signed-in Google website profile is not proof of API identity.

`appendTabs({spreadsheetId,expectedEmail,tabs:[{title,rows}]})` verifies email and subject with Google immediately before writing. One atomic batch adds new sheet IDs and literal cell values. Existing title collisions fail. No operation changes existing cells or sharing. Token expiry requires reconnect. Live Google OAuth depends on the user's client registration and consent; automated tests use controlled API responses.

## Verification

`tests/e2e/automation.spec.ts` runs a real Chromium extension against a local authenticated server. It covers 401 versus page-client success, response capture and redaction, original download bytes, screenshots, ZIP checks, immutable files, offscreen jobs, checkpoint recovery, uncertain writes, generated tools, and Google identity/append constraints. Tests do not claim compatibility with every site's undocumented client.
