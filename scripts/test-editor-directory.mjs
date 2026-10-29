import assert from 'node:assert/strict';
import { test, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'pagescms-directory-'));
const originalFetch=globalThis.fetch;
after(()=>{globalThis.fetch=originalFetch;fs.rmSync(temporary,{recursive:true,force:true});});
const stubs={
 'lib/skautis/account.ts':'export const getSkautisAccount=async()=>globalThis.fixture.account;',
 'db/schema.ts':'export const skautisDirectorySessionTable={sessionId:"session_id",expiresAt:"expires_at"};',
 'db/index.ts':`export const db={
  query:{skautisDirectorySessionTable:{findFirst:async()=>globalThis.fixture.row}},
  delete:()=>({where:async()=>{globalThis.fixture.deletes++;}}),
  insert:()=>({values:value=>({onConflictDoUpdate:async()=>{globalThis.fixture.saved=value;globalThis.fixture.row=value;}})})
 };`,
 'lib/folder-management.ts':`export async function getFolderManagement(){if(globalThis.fixture.unauthenticated)throw Object.assign(Error('Not signed in'),{status:401});return globalThis.fixture.management;}
 export const validateFolderDirectory=value=>value;`,
};
const compiled=new Map();
function compile(relative){
 if(compiled.has(relative))return compiled.get(relative);
 const file=path.join(temporary,relative.replace(/\.ts$/,'.mjs')),url=pathToFileURL(file).href;
 compiled.set(relative,url);fs.mkdirSync(path.dirname(file),{recursive:true});
 const code=ts.transpileModule(stubs[relative]??fs.readFileSync(path.join(root,relative),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
 .replace(/^(import[^\n]*?from\s*|import\s*)(["'])([^"']+)\2/gm,(_m,prefix,_q,name)=>{
  let relativeName=name.startsWith('@/')?name.slice(2):path.posix.normalize(path.posix.join(path.posix.dirname(relative),name));
  const target=name.startsWith('@/')||name.startsWith('.')?compile(fs.existsSync(path.join(root,relativeName+'.ts'))||stubs[relativeName+'.ts']?relativeName+'.ts':relativeName+'/index.ts'):import.meta.resolve(name);
  return prefix+JSON.stringify(target);
 });
 fs.writeFileSync(file,code);return url;
}
const directory=await import(compile('lib/skautis/directory.ts'));
const vault=await import(compile('lib/skautis/directory-session.ts'));
const crypto=await import(compile('lib/crypto.ts'));
const route=await import(compile('app/api/[owner]/[repo]/[branch]/folder-access/people/route.ts'));
const token='12345678-1234-1234-1234-123456789abc';
const context={params:Promise.resolve({owner:'owner',repo:'repo',branch:'main'})};
const xml=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const row=values=>Object.entries(values).map(([key,value])=>`<${key}>${xml(value)}</${key}>`).join('');
const envelope=(method,records)=>`<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method}Response><${method}Result>${records.map(record=>`<${method}Output>${row(record)}</${method}Output>`).join('')}</${method}Result></${method}Response></soap:Body></soap:Envelope>`;
let f;
beforeEach(async()=>{
 process.env.BASE_URL='https://cms.example';process.env.SKAUTIS_APP_ID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';process.env.SKAUTIS_ENVIRONMENT='test';process.env.CRYPTO_KEY=Buffer.alloc(32,5).toString('base64');
 f=globalThis.fixture={account:{accountId:'test:1942'},calls:[],deletes:0,
  roles:[{ID_Unit:'25893',Unit:'Kopřivnice',IsActive:'true',RegistrationNumber:'001.02.003'},{ID_Unit:'25893',Unit:'Kopřivnice',IsActive:'true'},{ID_Unit:'123',Unit:'Inactive unit',IsActive:'false'}],
  users:[{ID:'1942',ID_Person:'142312',DisplayName:'Jiří Sudák',UserName:'stredisko.koprivnice',IsEnabled:'true',PasswordRequest:'private-value',Email:'private@example.org'},
   {ID:'1942',ID_Person:'142312',DisplayName:'Jiří Sudák',UserName:'stredisko.koprivnice',IsEnabled:'true'},
   {ID:'2000',DisplayName:'Jiří Disabled',IsEnabled:'false'},{ID:'bad',DisplayName:'Jiří Invalid',IsEnabled:'true'},{ID:'2001',DisplayName:'Other Name',IsEnabled:'true'}],
  management:{user:{id:'cms-user'},session:{id:'cms-session'},permissions:{admin:false,restricted:true,rules:[],folderAdmins:[{directory:'content/wolves',allowed:true}]}}
 };
 const encrypted=await crypto.encrypt(JSON.stringify({token,accountId:'test:1942',unitId:'25893'}));
 f.row={...encrypted,expiresAt:new Date(Date.now()+600000)};
 globalThis.fetch=async(url,init)=>{
  const method=init.headers.SOAPAction.includes('UserRoleAll')?'UserRoleAll':'UserAll';
  f.calls.push({url,init,method});
  const content=f.fault||envelope(method,method==='UserRoleAll'?f.roles:f.users);
  return new Response(content,{status:f.status||200});
 };
});
const get=query=>route.GET(new Request('https://cms.example/api?'+query),context);
const authorized='directory=content%2Fwolves';
test('unit picker deduplicates active role units and uses the authenticated skautIS user ID',async()=>{
 const units=await directory.getDirectoryUnits(token,'test:1942');
 assert.equal(units.length,1);assert.equal(units[0].id,'25893');
 assert.match(f.calls[0].init.body,/<ID_User>1942<\/ID_User>/);
 assert.match(f.calls[0].init.body,/<IsActive>true<\/IsActive>/);
});
test('name search is scoped to the selected accessible unit and saves user IDs, never person IDs',async()=>{
 const result=await directory.searchDirectory(token,'test:1942','25893','Ji');
 assert.deepEqual(result.people,[{identity:'skautis:test:1942',name:'Jiří Sudák',username:'stredisko.koprivnice'}]);
 const call=f.calls.find(call=>call.method==='UserAll');assert.match(call.init.body,/<ID_Unit>25893<\/ID_Unit>/);
 assert.match(call.init.body,/<DisplayName>Ji<\/DisplayName>/);
 assert.ok(!JSON.stringify(result).includes('142312'));assert.ok(!JSON.stringify(result).includes('private'));
});
test('search rejects unknown units before requesting their people',async()=>{
 await assert.rejects(directory.searchDirectory(token,'test:1942','99999','Ji'),error=>error.status===403);
 assert.ok(f.calls.every(call=>call.method==='UserRoleAll'));
});
test('query validation blocks empty, wildcard-only, control-character and oversized searches',async()=>{
 for(const query of ['','J','%%','*?','J\nI','J'.repeat(101)])assert.throws(()=>directory.validateDirectoryQuery(query));
 assert.equal(f.calls.length,0);
});
test('XML text is escaped and returned directory fields are whitelisted',async()=>{
 await directory.searchDirectory(token,'test:1942','25893','Ji & <x>');
 const call=f.calls.find(call=>call.method==='UserAll');
 assert.match(call.init.body,/<DisplayName>Ji &amp; &lt;x&gt;<\/DisplayName>/);
 assert.ok(!call.init.body.includes('<DisplayName>Ji & <x>'));
});
test('results are capped to fifty unique selectable accounts',async()=>{
 f.users=Array.from({length:55},(_,i)=>({ID:String(3000+i),DisplayName:'Ji '+i,IsEnabled:'true'}));
 const result=await directory.searchDirectory(token,'test:1942','25893','Ji');
 assert.equal(result.people.length,50);assert.equal(result.hasMore,true);
});
test('only current folder administrators may query the directory',async()=>{
 assert.equal((await get('directory=content%2Fother')).status,403);assert.equal(f.calls.length,0);
 f.unauthenticated=true;assert.equal((await get(authorized)).status,401);assert.equal(f.calls.length,0);
});
test('route returns units or selected people with no-store and never exposes the upstream token',async()=>{
 const units=await get(authorized);assert.equal(units.status,200);assert.match(units.headers.get('cache-control'),/no-store/);
 const body=await units.json();assert.equal(body.defaultUnit,'25893');
 const people=await get(authorized+'&unit=25893&q=Ji&token=attacker');assert.equal(people.status,200);
 const text=await people.text();assert.ok(text.includes('skautis:test:1942'));assert.ok(!text.includes(token));assert.ok(!text.includes('private-value'));
 assert.ok(f.calls.every(call=>!call.init.body.includes('attacker')));
});
test('malformed directory requests do not reach SOAP',async()=>{
 for(const query of ['',authorized+'&unit=0&q=Ji',authorized+'&unit=25893',authorized+'&q=Ji',authorized+'&unit=25893&q=%%'])assert.equal((await get(query)).status,400);
 assert.equal(f.calls.length,0);
});
test('directory session is encrypted and attached to a specific CMS session',async()=>{
 await vault.saveSkautisDirectorySession('cms-session',{token,accountId:'test:1942'},Date.now()+500000);
 assert.equal(f.saved.sessionId,'cms-session');assert.ok(!JSON.stringify(f.saved).includes(token));
 const recovered=await vault.getSkautisDirectorySession('cms-session','cms-user');assert.equal(recovered.token,token);
});
test('expired, corrupt, missing, different-account and cross-environment sessions fail closed',async()=>{
 const original=f.row;
 f.row=null;assert.equal((await get(authorized)).status,401);
 f.row={...original,expiresAt:new Date(0)};assert.equal((await get(authorized)).status,401);assert.ok(f.deletes>0);
 f.row={...original,ciphertext:'invalid'};assert.equal((await get(authorized)).status,401);
 f.row=original;f.account={accountId:'test:999'};assert.equal((await get(authorized)).status,401);
 f.account={accountId:'test:1942'};process.env.SKAUTIS_ENVIRONMENT='production';assert.equal((await get(authorized)).status,401);
 assert.equal(f.calls.length,0);
});
test('malformed decrypted payload is rejected rather than exposing a server error',async()=>{
 const encrypted=await crypto.encrypt('null');f.row={...encrypted,expiresAt:new Date(Date.now()+10000)};
 assert.equal((await get(authorized)).status,401);
});
test('SOAP access denial and expiry are sanitized even for HTTP 500 faults',async()=>{
 f.status=500;f.fault='<Envelope><Body><Fault><faultstring>Externí aplikace secret-app nemá oprávnění; sensitive-data</faultstring></Fault></Body></Envelope>';
 const response=await get(authorized);assert.equal(response.status,403);assert.ok(!(await response.text()).includes('secret-app'));
 f.fault='<Envelope><Body><Fault><faultstring>Neplatný login</faultstring></Fault></Body></Envelope>';
 assert.equal((await get(authorized)).status,401);
});
test('oversized and entity-containing upstream responses fail closed',async()=>{
 f.fault='x'.repeat(1048577);assert.equal((await get(authorized)).status,502);
 f.fault='<!DOCTYPE x [<!ENTITY a "secret">]><Envelope><Body/></Envelope>';assert.equal((await get(authorized)).status,502);
});
