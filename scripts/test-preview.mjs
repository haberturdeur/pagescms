import assert from 'node:assert/strict';
import { test, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pagescms-preview-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const stubs = {
  'lib/session-server.ts': 'export const requireApiUserSession = async () => globalThis.previewTest.session;',
  'lib/token.ts': 'export const getToken = async () => { if(globalThis.previewTest.denied) throw Object.assign(Error("Forbidden"),{status:403}); return {token:"github-private-token"}; };',
  'lib/config-store.ts': 'export const getConfig = async () => ({object:{settings:{preview:globalThis.previewTest.enabled}}});',
  'lib/utils/octokit.ts': 'export const createOctokitInstance = () => ({rest:{repos:{getBranch:async args=>{globalThis.previewTest.branch=args.branch;return {data:{commit:{sha:"a".repeat(40)}}};}}}});',
};
const compiled = new Map();
function compile(relative) {
  if (compiled.has(relative)) return compiled.get(relative);
  const file=path.join(temporary,relative.replace(/\.ts$/,'.mjs'));
  const url=pathToFileURL(file).href; compiled.set(relative,url);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const code=ts.transpileModule(stubs[relative]??fs.readFileSync(path.join(root,relative),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
    .replace(/^(import[^\n]*?from\s*|import\s*)(["'])([^"']+)\2/gm,(_m,prefix,_quote,name)=>prefix+JSON.stringify(name.startsWith('@/')?compile(name.slice(2)+'.ts'):import.meta.resolve(name)));
  fs.writeFileSync(file,code);return url;
}
const route=await import(compile('app/api/[owner]/[repo]/[branch]/preview/route.ts'));
const realFetch=globalThis.fetch;
after(()=>{globalThis.fetch=realFetch;});
beforeEach(()=>{
  globalThis.previewTest={session:{user:{id:'user'}},enabled:true,requests:[]};
  process.env.PREVIEW_SERVICE_URL='http://preview.internal:8080';
  process.env.PREVIEW_SERVICE_TOKEN='controller-private-token';
  globalThis.fetch=async(url,options)=>{globalThis.previewTest.requests.push({url:String(url),options});return Response.json({status:'queued',sha:'a'.repeat(40)});};
});
const request=method=>route[method](new Request('https://cms.example/api',{method,...(method==='POST'?{body:JSON.stringify({sha:'evil',branch:'main'})}:{})}),{params:Promise.resolve({owner:'owner',repo:'repo',branch:'feature/one'})});

test('anonymous and unauthorized users cannot build or inspect previews',async()=>{
  globalThis.previewTest.session={response:Response.json({}, {status:401})};
  assert.equal((await request('POST')).status,401);
  globalThis.previewTest.session={user:{id:'user'}};globalThis.previewTest.denied=true;
  assert.equal((await request('GET')).status,403);
  assert.equal(globalThis.previewTest.requests.length,0);
});
test('previews are opt-in and require instance service configuration',async()=>{
  globalThis.previewTest.enabled=false;
  assert.equal((await request('POST')).status,404);
  globalThis.previewTest.enabled=true;delete process.env.PREVIEW_SERVICE_TOKEN;
  assert.equal((await request('GET')).status,503);
  assert.equal(globalThis.previewTest.requests.length,0);
});
test('build pins the authorized branch commit and keeps credentials server-side',async()=>{
  const response=await request('POST');assert.equal(response.status,200);
  assert.equal(globalThis.previewTest.branch,'feature/one');
  const {url,options}=globalThis.previewTest.requests[0];
  assert.equal(new URL(url).host,'preview.internal:8080');
  assert.equal(new URL(url).searchParams.get('branch'),'feature/one');
  assert.deepEqual(JSON.parse(options.body),{repository:'owner/repo',branch:'feature/one',sha:'a'.repeat(40),token:'github-private-token'});
  assert.equal(options.headers.Authorization,'Bearer controller-private-token');
  assert.ok(!(await response.text()).includes('private-token'));
});
test('status reads never enqueue a build and are not cached',async()=>{
  const response=await request('GET');assert.equal(response.status,200);
  assert.equal(globalThis.previewTest.requests[0].options.method,'GET');
  assert.equal(globalThis.previewTest.requests[0].options.body,undefined);
  assert.match(response.headers.get('Cache-Control'),/no-store/);
});
