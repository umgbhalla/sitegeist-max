import { createServer, type Server } from 'node:http';
import { type BrowserContext, type Page } from '@playwright/test';
import { test, expect } from './fixtures';

let server: Server;
let origin: string;
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/orders') {
      if (!req.headers.cookie?.includes('session=valid') || req.headers['x-page-auth'] !== 'page-only') { res.writeHead(401); res.end('unauthorized'); return; }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ orders: [{id: 'one', total: 10}], access_token: 'must-not-leak' })); return;
    }
    if (req.url === '/invoice/one') {
      if (!req.headers.cookie?.includes('session=valid')) { res.writeHead(401); res.end(); return; }
      res.writeHead(200, {'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="original.pdf"'}); res.end(pdf); return;
    }
    res.writeHead(200, {'Content-Type':'text/html', 'Set-Cookie':'session=valid; HttpOnly; SameSite=Lax; Path=/'});
    res.end(`<html><head><title>Fixture orders</title></head><body><script>window.app={request: config => fetch(config.url,{credentials:'include',headers:{'x-page-auth':'page-only'}})};window.reactMetadata={ready:true};</script><a id="invoice" href="/invoice/one">Invoice</a><div class="address">Complete Address 123 Road City Country</div>${Array.from({length: 12}, (_,i)=>`<div class="item" style="height:150px">Item ${i}</div>`).join('')}</body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
async function rpc<T = Record<string, unknown>>(page: Page, op: string, args: object = {}): Promise<T> {
  return page.evaluate(async ({op,args}) => {
    const result = await chrome.runtime.sendMessage({type:'automation',op,args});
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }, {op,args});
}
async function setup(context: BrowserContext, extensionId: string) {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/debug.html`);
  const page = await context.newPage(); await page.goto(origin);
  const tabs = await panel.evaluate(() => chrome.tabs.query({}));
  const tabId = tabs.find(tab => tab.url?.startsWith('http://127.0.0.1:'))?.id;
  if (!tabId) throw new Error('Fixture tab not found');
  return {panel,page,tabId};
}

test('capture authenticated calls, page adapter, secret redaction, original same-tab invoice', async ({context,extensionId}) => {
  const {panel,page,tabId} = await setup(context,extensionId);
  const capture = await rpc<{id:string}>(panel,'net.start',{tabId,pattern: `${origin}/api/*`});
  const plain = await rpc<{status:number}>(panel,'page.request',{tabId,origin,url:'/api/orders'});
  expect(plain.status).toBe(401);
  const response = await rpc<{body:{orders:unknown[];access_token:string}}>(panel,'page.request',{tabId,origin,url:'/api/orders',adapter:'async config => window.app.request(config)'});
  expect(response.body.orders).toHaveLength(1); expect(response.body.access_token).toBe('[redacted]');
  type Row = {id:string;status:number;finished:boolean};
  let records: Row[] = [];
  await expect.poll(async () => { records = await rpc<Row[]>(panel,'net.list',{id:capture.id}); return records.some(r => r.status===200 && r.finished); }).toBe(true);
  const row = records.find(r=>r.status===200)!;
  const body = await rpc<{body:{access_token:string}}>(panel,'net.body',{id:row.id});
  expect(body.body.access_token).toBe('[redacted]');
  await rpc(panel,'net.save',{id:row.id,packet:'packet',name:'orders.json'});
  await rpc(panel,'net.stop',{id:capture.id});
  const downloadCapture = await rpc<{id:string}>(panel,'net.start',{tabId,pattern:`${origin}/invoice/*`,download:{packet:'packet',name:'one.pdf'}});
  await page.locator('#invoice').click();
  await expect.poll(async () => (await rpc<{name:string}[]>(panel,'files.list',{packet:'packet'})).some(file=>file.name==='one.pdf')).toBe(true);
  const invoice = await rpc<{base64:string}>(panel,'files.read',{packet:'packet',name:'one.pdf'});
  expect(Buffer.from(invoice.base64,'base64')).toEqual(pdf);
  await rpc(panel,'net.stop',{id:downloadCapture.id});
});

test('full-page screenshots and ZIP validation reject missing or changed files', async ({context,extensionId}) => {
  const {panel,page,tabId} = await setup(context,extensionId);
  await expect(rpc(panel,'screenshot',{tabId,packet:'proof',orderId:'wrong',rowSelector:'.item',expectedRows:99})).rejects.toThrow();
  const image = await rpc<{name:string;size:number}>(panel,'screenshot',{tabId,packet:'proof',orderId:'one',rowSelector:'.item',expectedRows:12,addressSelector:'.address'});
  expect(image.name).toBe('one.png'); expect(image.size).toBeGreaterThan(1000);
  const png = await rpc<{base64:string}>(panel,'files.read',{packet:'proof',name:'one.png'});
  expect(Buffer.from(png.base64,'base64').readUInt32BE(20)).toBeGreaterThan(1800);
  const style = await page.addStyleTag({content:'.item {display:none}'});
  await expect(rpc(panel,'screenshot',{tabId,packet:'proof',orderId:'hidden',rowSelector:'.item',expectedRows:12})).rejects.toThrow();
  await style.evaluate(el=>el.remove());
  await expect(rpc(panel,'files.validate',{packet:'proof',expected:['missing.pdf']})).rejects.toThrow('Missing');
  await expect(rpc(panel,'files.write',{packet:'proof',name:'../bad',data:'bad'})).rejects.toThrow('Invalid');
  await rpc(panel,'files.write',{packet:'proof',name:'data.csv',data:'id,total\none,10'});
  await expect(rpc(panel,'files.write',{packet:'proof',name:'data.csv',data:'changed'})).rejects.toThrow('different content');
  const files = await rpc<{name:string}[]>(panel,'files.list',{packet:'proof'});
  const result = await rpc<{downloadId:number;verified:boolean}>(panel,'files.export',{packet:'proof',expected:files.map(file=>file.name)});
  expect(result.verified).toBe(true);
  await expect.poll(async()=> (await rpc<{state:string}>(panel,'downloads.status',{id:result.downloadId})).state).toBe('complete');
});

test('saved code tools run offscreen and persist checkpoints after panel closes', async ({context,extensionId}) => {
  const {panel,tabId} = await setup(context,extensionId);
  await rpc(panel,'tools.save',{name:'batch',description:'Fixture batch',source:`async (args,browser,job) => {
    for (const n of Array.from({length:53},(_,i)=>i+1)) await job.step('item-'+n, async () => {
      await new Promise(r=>setTimeout(r,20));
      const title = await browser.page.evaluate({tabId:args.tabId,expression:'document.title'});
      await browser.files.write({packet:'job',name:n+'.json',data:JSON.stringify({n,title})});
      return n;
    }, {idempotent:true,retries:1});
    return 'complete';
  }`});
  const job = await rpc<{id:string}>(panel,'jobs.start',{tool:'batch',args:{tabId}});
  await panel.close();
  const monitor = await context.newPage(); await monitor.goto(`chrome-extension://${extensionId}/debug.html`);
  await expect.poll(async()=> await rpc<{status:string;error?:string}>(monitor,'jobs.get',{id:job.id}), {timeout:25000}).toMatchObject({status:'done'});
  expect(await rpc<unknown[]>(monitor,'jobs.steps',{id:job.id})).toHaveLength(53);
  expect(await rpc<unknown[]>(monitor,'files.list',{packet:'job'})).toHaveLength(53);
});

test('job resumes completed steps after offscreen restart and blocks uncertain writes', async ({context,extensionId}) => {
  const {panel} = await setup(context,extensionId);
  await rpc(panel,'tools.save',{name:'resume',description:'Resume fixture',source:`async (args,browser,job) => {
    await job.step('first',async()=> browser.files.write({packet:'resume',name:'first.txt',data:String(Date.now())}));
    await job.step('wait',async()=> {await new Promise(r=>setTimeout(r,1500)); return 'done';},{idempotent:true});
    return 'resumed';
  }`});
  const run = await rpc<{id:string}>(panel,'jobs.start',{tool:'resume',args:{}});
  await expect.poll(async()=> (await rpc<{key:string;status:string}[]>(panel,'jobs.steps',{id:run.id})).some(step=>step.key==='first' && step.status==='done')).toBe(true);
  const first = await rpc<{sha256:string}>(panel,'files.read',{packet:'resume',name:'first.txt'});
  await panel.evaluate(()=>chrome.offscreen.closeDocument());
  await rpc(panel,'jobs.resume',{id:run.id});
  await expect.poll(async()=> (await rpc<{status:string}>(panel,'jobs.get',{id:run.id})).status,{timeout:20000}).toBe('done');
  expect((await rpc<{sha256:string}>(panel,'files.read',{packet:'resume',name:'first.txt'})).sha256).toBe(first.sha256);
  await rpc(panel,'tools.save',{name:'uncertain',description:'No write retry',source:'async (args,browser,job) => job.step("write",async()=> { throw new Error("uncertain write"); })'});
  const uncertain = await rpc<{id:string}>(panel,'jobs.start',{tool:'uncertain',args:{}});
  await expect.poll(async()=> (await rpc<{status:string}>(panel,'jobs.get',{id:uncertain.id})).status).toBe('error');
  await rpc(panel,'jobs.resume',{id:uncertain.id});
  await expect.poll(async()=> (await rpc<{error?:string}>(panel,'jobs.get',{id:uncertain.id})).error).toContain('uncertain outcome');
  expect((await rpc<{attempts:number}[]>(panel,'jobs.steps',{id:uncertain.id}))[0].attempts).toBe(1);
});

test('Google append verifies identity and only sends new literal-value tabs', async ({context,extensionId}) => {
  const {panel} = await setup(context,extensionId);
  const worker = context.serviceWorkers().find(w=>w.url().startsWith(`chrome-extension://${extensionId}/`))!;
  await worker.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve,reject)=> {const r=indexedDB.open('sitegeist-automation');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    await new Promise<void>((resolve,reject)=> {const tx=db.transaction('settings','readwrite'); tx.objectStore('settings').put({id:'google-sheets',token:'fixture-token',expires:Date.now()+3600000,email:'right@example.com',sub:'account-1'});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
    db.close();
    const scope = globalThis as unknown as {fetch:typeof fetch; writes:unknown[]}; scope.writes=[];
    scope.fetch=async (input,init) => {
      const url=String(input);
      if (url.includes('userinfo')) return new Response(JSON.stringify({email:'right@example.com',sub:'account-1',email_verified:true}),{status:200});
      if (init?.method==='POST') {scope.writes.push(JSON.parse(String(init.body))); return new Response('{}',{status:200});}
      return new Response(JSON.stringify({sheets:[{properties:{sheetId:7,title:'Existing'}}]}),{status:200});
    };
  });
  await expect(rpc(panel,'sheets.appendTabs',{spreadsheetId:'test-sheet',expectedEmail:'wrong@example.com',tabs:[{title:'New',rows:[['data']]}]})).rejects.toThrow('mismatch');
  await expect(rpc(panel,'sheets.appendTabs',{spreadsheetId:'test-sheet',expectedEmail:'right@example.com',tabs:[{title:'Existing',rows:[['data']]}]})).rejects.toThrow('already exists');
  const result = await rpc<{sharingChanged:boolean}>(panel,'sheets.appendTabs',{spreadsheetId:'test-sheet',expectedEmail:'right@example.com',tabs:[{title:'New',rows:[['=IMPORTXML("bad")',5,true]]}]});
  expect(result.sharingChanged).toBe(false);
  const writes = await worker.evaluate(()=> (globalThis as unknown as {writes:{requests:{addSheet?:{properties:{sheetId:number}};updateCells?:{start:{sheetId:number};rows:{values:{userEnteredValue:object}[]}[]}}[]}[]}).writes);
  expect(writes).toHaveLength(1); expect(writes[0].requests).toHaveLength(2);
  expect(writes[0].requests[0].addSheet!.properties.sheetId).not.toBe(7);
  expect(writes[0].requests[1].updateCells!.rows[0].values[0].userEnteredValue).toEqual({stringValue:'=IMPORTXML("bad")'});
});

test('REPL composes and reuses its own saved tools', async ({context,extensionId}) => {
  const {panel,tabId} = await setup(context,extensionId);
  const code = `await browser.tools.save({name:'learned-title',description:'Read a page title',source: async (args,browser) => browser.page.evaluate({tabId:args.tabId,expression:'document.title'})}); const title = await browser.tools.run('learned-title',{tabId:${tabId}}); await browser.files.write({packet:'code-mode',name:'result.txt',data:title});`;
  const mock = [{tool:{name:'repl',args:{title:'Run generated tool',code}}},{text:'Generated tool completed'}];
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?teststeps=${encodeURIComponent(JSON.stringify(['Run tool']))}&mockresponses=${encodeURIComponent(JSON.stringify(mock))}`);
  await expect(panel.getByText('Generated tool completed')).toBeVisible();
  const file = await rpc<{base64:string}>(panel,'files.read',{packet:'code-mode',name:'result.txt'});
  expect(Buffer.from(file.base64,'base64').toString()).toBe('Fixture orders');
});

test('blob downloads, concurrent immutable writes, and wrong-origin requests', async ({context,extensionId}) => {
  const {panel,page,tabId} = await setup(context,extensionId);
  const url = await page.evaluate(()=>URL.createObjectURL(new Blob(['original bytes'],{type:'application/pdf'})));
  await rpc(panel,'downloads.fetch',{tabId,origin,url,packet:'blob',name:'original.pdf'});
  const file = await rpc<{base64:string}>(panel,'files.read',{packet:'blob',name:'original.pdf'});
  expect(Buffer.from(file.base64,'base64').toString()).toBe('original bytes');
  const writes = await Promise.allSettled([
    rpc(panel,'files.write',{packet:'race',name:'same.txt',data:'first'}),
    rpc(panel,'files.write',{packet:'race',name:'same.txt',data:'second'}),
  ]);
  expect(writes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  await expect(rpc(panel,'page.request',{tabId,origin:'https://wrong.example',url:'/api/orders'})).rejects.toThrow('origin changed');
});
