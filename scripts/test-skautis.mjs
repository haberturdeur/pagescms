import assert from 'node:assert/strict';
import { test, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';

// Exercise real Better Auth endpoints, cookie signatures, callback encryption
// and SOAP parsing. Only persistence and the remote SOAP server are replaced.
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pagescms-skautis-test-'));
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; fs.rmSync(temporary, { recursive: true, force: true }); });
const stubs = {
  'lib/skautis/store.ts': `
    export async function saveSkautisFlow(state, flow) { globalThis.fixture.flows.set(state, flow); }
    export async function consumeSkautisFlow(state) { const flow=globalThis.fixture.flows.get(state); globalThis.fixture.flows.delete(state); return flow ?? null; }
    export async function linkSkautisAccount(accountId, userId) {
      const accounts=globalThis.fixture.data.account;
      const existing=accounts.find(a=>a.providerId==='skautis' && (a.accountId===accountId || a.userId===userId));
      if(existing && (existing.accountId!==accountId || existing.userId!==userId)) throw Error('Already connected');
      if(!existing) accounts.push({id:crypto.randomUUID(),accountId,providerId:'skautis',userId,createdAt:new Date(),updatedAt:new Date()});
    }
  `,
};
const compiled = new Map();
function compile(relative) {
  if (compiled.has(relative)) return compiled.get(relative);
  const file = path.join(temporary, relative.replace(/\.tsx?$/, '.mjs'));
  const url = pathToFileURL(file).href;
  compiled.set(relative, url);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const source = stubs[relative] ?? fs.readFileSync(path.join(root, relative), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/^(import[^\n]*?from\s*|import\s*)(["'])([^"']+)\2/gm, (_match, prefix, _quote, name) => {
      const resolved = name.startsWith('@/') ? name.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(relative), name));
      const target = name.startsWith('@/') || name.startsWith('.') ? compile(resolved + '.ts')
        : import.meta.resolve(name === 'next/server' ? 'next/server.js' : name);
      return prefix + JSON.stringify(target);
    });
  fs.writeFileSync(file, code);
  return url;
}
const { skautis } = await import(compile('lib/skautis/plugin.ts'));
const callback = await import(compile('app/api/skautis/callback/route.ts'));
const { parseLoginDetail, verifySkautisLogin } = await import(compile('lib/skautis/client.ts'));
const { skautisRedirect } = await import(compile('lib/skautis/config.ts'));
const base = 'https://cms.example';
const token = '12345678-1234-1234-1234-123456789abc';
const soap = (id = '42', date = new Date(Date.now() + 600000).toISOString()) => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><LoginDetailResponse xmlns="https://is.skaut.cz/"><LoginDetailResult><ID_User>${id}</ID_User><DateLogout>${date}</DateLogout></LoginDetailResult></LoginDetailResponse></soap:Body></soap:Envelope>`;
let f;
beforeEach(() => {
  process.env.BASE_URL = base;
  process.env.SKAUTIS_APP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  process.env.SKAUTIS_ENVIRONMENT = 'test';
  process.env.CRYPTO_KEY = Buffer.alloc(32, 7).toString('base64');
  f = globalThis.fixture = { data: {user:[],session:[],account:[],verification:[]}, flows:new Map(), soap:soap(), calls:[] };
  f.auth = betterAuth({ baseURL:base, secret:'test-only-secret-with-at-least-thirty-two-characters', database:memoryAdapter(f.data),
    advanced:{disableCSRFCheck:false,disableOriginCheck:false}, plugins:[skautis()], rateLimit:{enabled:false} });
  globalThis.fetch = async (url, init) => {
    f.calls.push({url,init});
    return new Response(f.soap,{status:f.soapStatus || 200});
  };
});
const request = (pathname, body, cookie) => f.auth.handler(new Request(base + '/api/auth' + pathname, {
  method:body ? 'POST' : 'GET', headers:{origin:base,...(body ? {'content-type':'application/json'} : {}),...(cookie ? {cookie} : {})},
  ...(body ? {body:JSON.stringify(body)} : {}),
}));
const cookieHeader = response => response.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
async function localSession(id='local-user') {
  const context=await f.auth.$context;
  const user=await context.internalAdapter.createUser({id,name:'Leader',email:`${id}@example.org`,emailVerified:true});
  const session=await context.internalAdapter.createSession(user.id);
  // Use the framework to produce its signed session cookie.
  const { makeSignature }=await import('better-auth/crypto');
  const signature=await makeSignature(session.token,context.secret);
  const cookie=context.authCookies.sessionToken.name + '=' + encodeURIComponent(session.token+'.'+signature);
  return {user,session,cookie};
}
async function start(body={}, cookie) {
  const response=await request('/sign-in/skautis',body,cookie);
  assert.equal(response.status,200,await response.clone().text());
  const url=new URL((await response.json()).url);
  const callbackUrl=new URL(url.searchParams.get('ReturnUrl'));
  return {response,url,callbackUrl,cookie:cookieHeader(response),state:callbackUrl.searchParams.get('state')};
}
async function relay(flow, extraFields={}) {
  return callback.POST(new Request(flow.callbackUrl,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({skautIS_Token:token,skautIS_IDRole:'999999',skautIS_IDUnit:'999999',...extraFields})}));
}
async function complete(flow, sessionCookie='') {
  const post=await relay(flow);
  assert.equal(post.status,303);
  assert.equal(post.headers.get('location'),base+'/api/auth/skautis/complete');
  return request('/skautis/complete',null,[flow.cookie,cookieHeader(post),sessionCookie].filter(Boolean).join('; '));
}

test('disabled integration has no usable entry point',async()=>{
  delete process.env.SKAUTIS_APP_ID;
  assert.equal((await request('/sign-in/skautis',{})).status,404);
  assert.equal((await callback.POST(new Request(base+'/api/skautis/callback',{method:'POST'}))).status,404);
});
test('start uses configured test host, canonical callback, random signed state and safe redirect',async()=>{
  const flow=await start({redirect:'//evil.example'});
  assert.equal(flow.url.origin,'https://test-is.skaut.cz');
  assert.equal(flow.callbackUrl.origin,base);
  assert.equal(flow.callbackUrl.pathname,'/api/skautis/callback');
  assert.match(flow.state,/^[a-f0-9]{64}$/);
  assert.equal(f.flows.get(flow.state).redirect,'/');
  assert.match(flow.response.headers.get('set-cookie'),/HttpOnly/i);
  assert.match(flow.response.headers.get('set-cookie'),/SameSite=Lax/i);
  for(const value of ['//evil.example','/\\evil.example','/\nevil','https://evil.example']) assert.equal(skautisRedirect(value),'/');
});
test('initiation rejects foreign origins and linking requires a local session',async()=>{
  const response=await f.auth.handler(new Request(base+'/api/auth/sign-in/skautis',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'}));
  assert.equal(response.status,403);
  assert.equal((await request('/sign-in/skautis',{link:true})).status,401);
});
test('callback rejects missing state, malformed tokens and oversized bodies',async()=>{
  assert.equal((await callback.POST(new Request(base+'/api/skautis/callback',{method:'POST'}))).status,400);
  const flow=await start();
  assert.equal((await relay(flow,{skautIS_Token:'forged'})).status,400);
  assert.equal((await relay(flow,{padding:'x'.repeat(9000)})).status,413);
  assert.equal(f.calls.length,0);
});
test('unknown skautIS identity cannot create or claim a CMS account',async()=>{
  const response=await complete(await start());
  assert.match(response.headers.get('location'),/skautis_not_connected/);
  assert.equal(f.data.user.length,0);
  assert.equal(f.data.account.length,0);
  assert.equal(f.data.session.length,0);
});
test('link then sign in uses server identity and preserves the existing CMS user',async()=>{
  const local=await localSession();
  const linked=await complete(await start({link:true},local.cookie),local.cookie);
  assert.equal(linked.headers.get('location'),base+'/settings?skautis=connected');
  assert.equal(f.data.account[0].accountId,'test:42');
  assert.equal(f.data.account[0].userId,local.user.id);
  assert.equal(f.data.account[0].accessToken,undefined);
  const signedIn=await complete(await start({redirect:'/owner/repo/main'}));
  assert.equal(signedIn.headers.get('location'),base+'/owner/repo/main');
  const session=await request('/get-session',null,cookieHeader(signedIn));
  assert.equal((await session.json()).user.id,local.user.id);
  assert.equal(f.data.user.length,1);
  assert.match(f.calls[0].init.body,/<loginDetailInput><ID_Login>/);
  assert.equal(f.calls[0].url,'https://test-is.skaut.cz/JunakWebservice/UserManagement.asmx');
});
test('callback requires original browser state and is single-use',async()=>{
  const flow=await start();
  const post=await relay(flow);
  const denied=await request('/skautis/complete',null,cookieHeader(post));
  assert.match(denied.headers.get('location'),/skautis_failed/);
  assert.equal(f.calls.length,0);
  const validCookie=flow.cookie+'; '+cookieHeader(post);
  await request('/skautis/complete',null,validCookie);
  const calls=f.calls.length;
  assert.match((await request('/skautis/complete',null,validCookie)).headers.get('location'),/skautis_failed/);
  assert.equal(f.calls.length,calls);
});
test('linking cannot switch local sessions or steal an existing linked identity',async()=>{
  const first=await localSession('first');
  const second=await localSession('second');
  assert.match((await complete(await start({link:true},first.cookie),second.cookie)).headers.get('location'),/skautis_session_changed/);
  assert.equal(f.data.account.length,0);
  await complete(await start({link:true},first.cookie),first.cookie);
  assert.match((await complete(await start({link:true},second.cookie),second.cookie)).headers.get('location'),/skautis_already_connected/);
  assert.equal(f.data.account[0].userId,first.user.id);
});
test('expired state, SOAP faults and invalid identities fail closed',async()=>{
  const flow=await start(); f.flows.clear();
  assert.match((await complete(flow)).headers.get('location'),/skautis_failed/);
  for(const xml of [soap('42','2000-01-01T00:00:00Z'),soap('0'),soap('<x/>'),'<broken>',
    '<!DOCTYPE x [<!ENTITY a "bad">]>'+soap(),'<Envelope><Body><Fault><faultstring>secret</faultstring></Fault></Body></Envelope>']) {
    assert.throws(()=>parseLoginDetail(xml));
  }
  f.soapStatus=503;
  assert.match((await complete(await start())).headers.get('location'),/skautis_failed/);
  assert.equal(f.data.session.length,0);
});
test('SOAP response limit and token validation apply before accepting identity',async()=>{
  await assert.rejects(verifySkautisLogin('malformed'));
  assert.equal(f.calls.length,0);
  f.soap='x'.repeat(65537);
  await assert.rejects(verifySkautisLogin(token));
  process.env.SKAUTIS_ENVIRONMENT='typo';
  await assert.rejects(start());
});
