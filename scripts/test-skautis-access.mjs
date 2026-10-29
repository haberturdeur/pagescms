import assert from 'node:assert/strict';
import { test, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'pagescms-admission-'));
after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
// Run the actual repository admission, token selection and HTTP auth gate.
const stubs={
 'lib/installation-token.ts':'export const getInstallationToken=async()=>"installation-token";',
 'lib/skautis/account.ts':'export const getSkautisAccount=async()=>globalThis.fixture.account;',
 'lib/github-account.ts':'export const getGithubAccount=async()=>null;',
 'lib/utils/octokit.ts':'export const createOctokitInstance=()=>globalThis.fixture.octokit;',
 'lib/auth.ts':'export const auth={handler:async()=>Response.json({allowed:true})};',
 'db/index.ts':'export const db={query:{collaboratorTable:{findFirst:async()=>({invited:true})}}};',
 'lib/collaborator-access.ts':'export const collaboratorMatchesUserForRepo=()=>true;',
};
const compiled=new Map();
function compile(relative){
 if(compiled.has(relative))return compiled.get(relative);
 const file=path.join(temporary,relative.replace(/\.ts$/,'.mjs')),url=pathToFileURL(file).href;
 compiled.set(relative,url);fs.mkdirSync(path.dirname(file),{recursive:true});
 const code=ts.transpileModule(stubs[relative]??fs.readFileSync(path.join(root,relative),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
 .replace(/^(import[^\n]*?from\s*|import\s*)(["'])([^"']+)\2/gm,(_m,prefix,_q,name)=>{
  const relativeName=name.startsWith('@/')?name.slice(2):path.posix.normalize(path.posix.join(path.posix.dirname(relative),name));
  const target=name.startsWith('@/')||name.startsWith('.')?compile(fs.existsSync(path.join(root,relativeName+'.ts'))||stubs[relativeName+'.ts']?relativeName+'.ts':relativeName+'/index.ts'):import.meta.resolve(name);
  return prefix+JSON.stringify(target);
 });
 fs.writeFileSync(file,code);return url;
}
const tokens=await import(compile('lib/token.ts'));
const repos=await import(compile('lib/skautis/repositories.ts'));
const gate=await import(compile('app/api/auth/[...all]/route.ts'));
let f;
beforeEach(()=>{
 process.env.SKAUTIS_ONLY='true';process.env.SKAUTIS_REPOSITORIES='owner/repo';
 f=globalThis.fixture={account:{accountId:'test:1942'},files:{'.access':{editors:['skautis:test:1942']}},reads:[]};
 f.octokit={rest:{repos:{get:async()=>({data:{default_branch:'main'}}),getContent:async args=>({data:{type:'file',encoding:'base64',size:100,sha:'policy',content:Buffer.from(JSON.stringify(f.files[args.path])).toString('base64')}})},git:{getRef:async()=>({data:{object:{sha:'default-head'}}}),getTree:async args=>{
  f.reads.push(args);if(f.unavailable)throw Error('GitHub unavailable');
  return {data:{sha:'tree',truncated:!!f.truncated,tree:Object.keys(f.files).map(path=>({path,type:'blob',mode:'100644',sha:'policy'}))}};
 }}}};
});
const user={id:'cms-user',email:'no-email@identity.invalid',emailVerified:false};
test('listed skautIS users use the installation token without an invitation',async()=>{
 assert.deepEqual(await tokens.getToken(user,'owner','repo'),{token:'installation-token',source:'installation'});
 assert.equal((await repos.getSkautisRepositoriesForUser(user)).length,1);
 assert.equal(f.reads[0].tree_sha,'default-head');
});
test('revoking the last editor entry removes access from an existing user despite a legacy invitation',async()=>{
 await tokens.getToken(user,'owner','repo');
 f.files['.access'].editors=[];
 await assert.rejects(tokens.getToken(user,'owner','repo'),/not listed/);
 assert.equal((await repos.getSkautisRepositoriesForUser(user)).length,0);
});
test('admins-only users are admitted; removing their admin membership revokes access',async()=>{
 f.files={'.admins':{admins:['skautis:test:1942']}};
 assert.equal((await repos.getSkautisRepositoriesForUser(user)).length,1);
 f.files['.admins'].admins=[];
 await assert.rejects(tokens.getToken(user,'owner','repo'));
});
test('a client cannot forge skautIS identity, use another environment or access an unconfigured repo',async()=>{
 f.account=null;
 await assert.rejects(tokens.getToken({...user,skautisAccountId:'test:1942'},'owner','repo'));
 f.account={accountId:'production:1942'};
 await assert.rejects(tokens.getToken(user,'owner','repo'));
 f.account={accountId:'test:1942'};
 await assert.rejects(tokens.getToken(user,'other','repo'));
});
test('missing, malformed, truncated or unavailable policies deny admission',async()=>{
 for(const files of [{},{'.access':{editors:[]}},{'.access':{units:[123]}}]){
  f.files=files;await assert.rejects(tokens.getToken(user,'owner','repo'));
 }
 f.files={'.access':{editors:['skautis:test:1942']}};f.truncated=true;
 await assert.rejects(tokens.getToken(user,'owner','repo'));
 f.truncated=false;f.unavailable=true;await assert.rejects(tokens.getToken(user,'owner','repo'));
});
test('skautIS-only HTTP gate blocks email/GitHub login, signup, linking and callbacks',async()=>{
 for(const path of ['/sign-in/social','/callback/github','/sign-in/email-otp','/email-otp/send-verification-otp','/sign-up/email','/link-social']){
  assert.equal((await gate.POST(new Request('https://cms.example/api/auth'+path,{method:'POST'}))).status,404);
 }
 for(const path of ['/sign-in/skautis','/skautis/complete','/get-session','/sign-out']){
  assert.equal((await gate.POST(new Request('https://cms.example/api/auth'+path,{method:'POST'}))).status,200);
 }
});
