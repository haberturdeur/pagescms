import assert from 'node:assert/strict';
import { test, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

// Execute the real policy loader and route handlers with only external services
// replaced. No network, database or credentials are needed.
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pagescms-permissions-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const stubs = {
  'lib/utils/octokit.ts': 'export const createOctokitInstance = () => globalThis.fixture.octokit;',
  'lib/skautis/account.ts': 'export const getSkautisAccount = async () => globalThis.fixture.skautisAccount;',
  'lib/token.ts': 'export const getToken = async () => ({token:"test",source:globalThis.fixture.source});',
  'lib/session-server.ts': 'export const requireApiUserSession = async () => ({user:globalThis.fixture.user});',
  'lib/config-store.ts': 'export const getConfig = async () => globalThis.fixture.config; export const updateConfig = async () => {};',
  'fields/registry.ts': 'export const writeFns = {};',
  'lib/config.ts': 'export const configVersion="test"; export const parseConfig=()=>{}; export const normalizeConfig=()=>{};',
  'lib/serialization.ts': 'export const stringify=JSON.stringify; export const parse=JSON.parse;',
  'lib/schema.ts': 'export const getSchemaByName=(config,name,type="content")=>config[type].find(s=>s.name===name); export const deepMap=x=>x; export const sanitizeObject=x=>x; export const generateZodSchema=()=>{throw Error("Unexpected field schema")};',
  'lib/github-cache-file.ts': 'export const updateFileCache=async()=>{}; export const getBranchHeadSha=async()=>"edit-head"; export const setBranchHeadSha=()=>{};',
  'db/index.ts': 'export const db={select:()=>({from:()=>({where:async()=>[{id:1}]})})};',
  'db/schema.ts': 'export const actionRunTable={};',
  'lib/actions.ts': 'export const resolveActionRef=()=>"main";',
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
      let target;
      if (name.startsWith('@/') || name.startsWith('.')) {
        let resolved = name.startsWith('@/') ? name.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(relative), name));
        resolved = fs.existsSync(path.join(root, resolved + '.ts')) ? resolved + '.ts' : resolved + '/index.ts';
        target = compile(resolved);
      } else target = import.meta.resolve(name === 'next/server' ? 'next/server.js' : name);
      return prefix + JSON.stringify(target);
    });
  fs.writeFileSync(file, code);
  return url;
}
const folderManagement = await import(compile('app/api/[owner]/[repo]/[branch]/folder-access/route.ts'));
const folderPolicy = await import(compile('lib/folder-policy.ts'));
const policy = await import(compile('lib/repo-access.ts'));
const perms = await import(compile('lib/repo-permissions.ts'));
const files = await import(compile('app/api/[owner]/[repo]/[branch]/files/[path]/route.ts'));
const rename = await import(compile('app/api/[owner]/[repo]/[branch]/files/[path]/rename/route.ts'));
const runActions = await import(compile('app/api/[owner]/[repo]/[branch]/actions/[runId]/route.ts'));
const branches = await import(compile('app/api/[owner]/[repo]/[branch]/branches/route.ts'));
const actions = await import(compile('app/api/[owner]/[repo]/[branch]/actions/route.ts'));
const permissionsRoute = await import(compile('app/api/[owner]/[repo]/[branch]/permissions/route.ts'));
const example = { version: 1, groups: { wolves: ['leader@example.org'], common: ['editor@example.org', 'LEADER@example.org'] }, rules: [
  { paths: ['content/wolves/**', 'static/wolves/**'], groups: ['wolves'] },
  { paths: ['content/common/**'], groups: ['common'], operations: ['update'] },
] };
let f;
beforeEach(() => {
  f = globalThis.fixture = {
    source: 'installation', user: { id: 'user', name: 'Leader', email: 'leader@example.org', emailVerified: true },
    policy: JSON.stringify(example), mode: '100644', push: false, writes: [], reads: [],
    tree: [{ path: 'content/wolves/a.md', type: 'blob', mode: '100644', sha: 'blob' }],
    config: { object: { content: [{name:'pages',type:'collection',path:'content',extension:'md'}], media: [{name:'images',input:'static'}] } },
  };
  const write = (name, result = {}) => async args => { f.writes.push({name,...args}); return {data:result}; };
  f.octokit = { rest: {
    repos: {
      get: async () => ({data:{default_branch:'main',permissions:{push:f.push}}}),
      getContent: async args => {
        f.reads.push(args);
        if (f.folderFiles?.[args.path]) {
          const file=f.folderFiles[args.path];
          return {data:{type:'file',encoding:'base64',size:Buffer.byteLength(file.content),content:Buffer.from(file.content).toString('base64'),sha:file.sha||'folder-sha'}};
        }
        if (args.path !== '.pages-access.yml') return {data:[{name:'a.md'}]};
        assert.equal(args.ref, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        if (f.unavailable) throw Error('GitHub unavailable');
        return {data:{type:'file',encoding:'base64',size:Buffer.byteLength(f.policy),content:Buffer.from(f.policy).toString('base64')}};
      },
      createOrUpdateFileContents: async args => {
        f.writes.push({name:'save',...args});
        if (f.conflict) throw Object.assign(Error('exists'),{status:422});
        return {data:{content:{path:args.path,name:args.path.split('/').pop(),sha:'new',type:'file'},commit:{sha:'commit'}}};
      },
      deleteFile: write('delete',{commit:{sha:'commit'}}),
    },
    git: {
      getRef: async args => { f.reads.push(args); return {data:{object:{sha:args.ref==='heads/main'?'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa':'edit-head'}}}; },
      getTree: async args => {
        f.reads.push(args);
        return {data:{sha:'tree',truncated:!!f.truncated,tree:args.recursive ? [...f.tree,...Object.entries(f.folderFiles||{}).map(([path,file])=>({path,type:'blob',mode:file.mode||'100644',sha:file.sha||'folder-sha'}))] : f.policy===null ? [] : [{path:'.pages-access.yml',type:'blob',mode:f.mode}]}};
      },
      createTree: write('tree',{sha:'new-tree'}), createCommit:write('commit',{sha:'new-commit'}),
      updateRef:write('ref'), createRef:write('branch'),
    },
  }};
});
const access = () => policy.getRepoAccess(f.user,'owner','repo','test',f.source);
const context = file => ({params:Promise.resolve({owner:'owner',repo:'repo',branch:'alternate',path:file,runId:'1'})});
async function invoke(route, file, body, method='POST') {
  const request = new Request('https://cms.example/api?sha=old&type=content&name=pages', {method, ...(['POST','PUT'].includes(method)?{body:JSON.stringify(body)}:{})});
  request.nextUrl = new URL(request.url);
  const previous = console.error;
  console.error = () => {};
  try { return await route[method](request,context(file)); } finally { console.error = previous; }
}
const save = (file,extra={}) => invoke(files,file,{type:'content',name:'pages',content:{body:'Hello'},...extra});

test('strict policy parsing rejects ambiguous or malformed permissions', () => {
  assert.deepEqual(policy.parseAccessPolicy(JSON.stringify(example)).rules[0].operations,['create','update','delete']);
  for (const source of ['version: 1\nversion: 1', JSON.stringify({...example,unexpected:true}), JSON.stringify({...example,rules:[{paths:['**'],groups:['missing']}]}), 'version: 1\ngroups: &groups {}\nrules: *groups']) assert.throws(()=>policy.parseAccessPolicy(source));
  for (const pattern of ['/content/**','content/../**','content\\**','content//**','a**b','content/[ab]']) assert.throws(()=>policy.parseAccessPolicy(JSON.stringify({...example,rules:[{paths:[pattern],groups:['wolves']}]})));
});
test('verified email groups are additive; globs respect path boundaries and protected paths', () => {
  const p = perms.permissionsForEmail(policy.parseAccessPolicy(f.policy),'LEADER@example.org',true);
  assert.equal(perms.canWrite(p,'content/wolves/a.md','create'),true);
  assert.equal(perms.canWrite(p,'content/wolves/nested/a.md','delete'),true);
  assert.equal(perms.canWrite(p,'content/wolves-other/a.md','update'),false);
  assert.equal(perms.canWrite(p,'content/common/a.md','update'),true);
  assert.equal(perms.canWrite(p,'content/common/a.md','create'),false);
  assert.equal(perms.matchesPath('content/**/a.md','content/a.md'),true);
  assert.equal(perms.matchesPath('content/*.md','content/nested/a.md'),false);
  assert.equal(perms.canWrite(perms.permissionsForEmail(policy.parseAccessPolicy(f.policy),f.user.email,false),'content/wolves/a.md','update'),false);
  const all = {admin:false,restricted:true,rules:[{paths:['**'],operations:['create','update','delete']}]};
  for (const file of ['.pages.yml','.pages-access.yml','.github/workflows/build.yml','content/../.pages.yml','/content/a.md']) assert.equal(perms.canWrite(all,file,'update'),false);
});
test('administrator requires personal GitHub write access; policy uses default branch snapshot', async () => {
  f.push=true;
  assert.equal((await access()).permissions.admin,false);
  f.source='user';
  assert.equal((await access()).permissions.admin,true);
  f.push=false;
  assert.equal((await access()).permissions.admin,false);
  assert.ok(f.reads.some(x=>x.ref==='heads/main'));
  assert.ok(f.reads.some(x=>x.path==='.pages-access.yml' && x.ref==='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
});
test('missing policy preserves legacy editing; malformed, symlink and unavailable policies fail closed', async () => {
  const valid=f.policy;
  f.policy=null;
  (await access()).assert('content/other/a.md','update');
  assert.throws(() => perms.canonicalRepoPath('content/../a.md'));
  f.policy='invalid'; await assert.rejects(access);
  f.policy=valid; f.mode='120000'; await assert.rejects(access);
  f.mode='100644'; f.unavailable=true; await assert.rejects(access);
});
test('save and upload enforce operation and group permissions before mutation', async () => {
  assert.equal((await save('content/other/a.md',{sha:'old'})).status,403);
  assert.equal((await save('content/common/a.md')).status,403);
  assert.equal((await invoke(files,'static/other/image.png',{type:'media',name:'images',content:'aGVsbG8='})).status,403);
  assert.equal((await save('.pages-access.yml')).status,403);
  assert.equal(f.writes.length,0);
  assert.equal((await save('content/wolves/a.md',{sha:'old'})).status,200);
  assert.equal((await save('content/wolves/new.md')).status,200);
  assert.equal((await invoke(files,'static/wolves/image.png',{type:'media',name:'images',content:'aGVsbG8='})).status,200);
  assert.equal(f.writes.length,3);
});
test('schema boundaries and traversal cannot be bypassed by request paths', async () => {
  f.policy=null;
  assert.equal((await save('content-other/a.md')).status,400);
  assert.equal((await save('content/../a.md')).status,400);
  assert.equal(f.writes.length,0);
});
test('deletion checks the source and update-only grants cannot delete', async () => {
  assert.equal((await invoke(files,'content/common/a.md',null,'DELETE')).status,403);
  assert.equal((await invoke(files,'content/other/a.md',null,'DELETE')).status,403);
  assert.equal(f.writes.length,0);
  assert.equal((await invoke(files,'content/wolves/a.md',null,'DELETE')).status,200);
  assert.equal(f.writes[0].name,'delete');
});
test('rename checks both paths and patches only the authorized files', async () => {
  const move = newPath => invoke(rename,'content/wolves/a.md',{type:'content',name:'pages',newPath});
  assert.equal((await move('content/other/a.md')).status,403);
  assert.equal((await move('content/common/a.md')).status,403);
  assert.equal(f.writes.length,0);
  f.tree.push({path:'content/wolves/taken.md',type:'blob',mode:'100644',sha:'other'});
  assert.equal((await move('content/wolves/taken.md')).status,409);
  assert.equal(f.writes.length,0);
  assert.equal((await move('content/wolves/new.md')).status,200);
  assert.deepEqual(f.writes[0].tree,[{path:'content/wolves/a.md',mode:'100644',type:'blob',sha:null},{path:'content/wolves/new.md',mode:'100644',type:'blob',sha:'blob'}]);
  assert.equal(f.writes[0].base_tree,'tree');
});
test('conflict-generated filenames need their own create permission', async () => {
  f.policy=JSON.stringify({...example,rules:[{paths:['content/wolves/a.md'],groups:['wolves'],operations:['create']}]});
  f.conflict=true;
  assert.equal((await save('content/wolves/a.md')).status,403);
  assert.equal(f.writes.length,1);
  assert.equal(f.writes[0].path,'content/wolves/a.md');
});
test('configured collaborators cannot create branches or dispatch workflows', async () => {
  assert.equal((await invoke(branches,'',{name:'bypass'})).status,403);
  assert.equal((await invoke(actions,'',{workflow:'build.yml'})).status,403);
  assert.equal(f.writes.length,0);
  f.source='user';f.push=true;
  assert.equal((await invoke(branches,'',{name:'admin-branch'})).status,200);
  assert.equal(f.writes[0].name,'branch');
});
test('permissions endpoint returns only effective rules, with no email directory', async () => {
  const response=await permissionsRoute.GET(new Request('https://cms.example'),context(''));
  assert.equal(response.status,200);
  assert.match(response.headers.get('cache-control'),/no-store/);
  const body=await response.text();
  assert.ok(!body.includes('@example.org'));
  assert.ok(body.includes('content/wolves/**'));
});

test('workflow rerun and cancellation also enforce repository permissions', async () => {
  for (const intent of ['cancel','rerun']) assert.equal((await invoke(runActions,'',{intent})).status,403);
  assert.equal(f.writes.length,0);
});
test('rename refuses symlink sources and incomplete trees', async () => {
  f.tree[0].mode='120000';
  assert.equal((await invoke(rename,'content/wolves/a.md',{type:'content',name:'pages',newPath:'content/wolves/b.md'})).status,400);
  f.tree[0].mode='100644'; f.truncated=true;
  assert.equal((await invoke(rename,'content/wolves/a.md',{type:'content',name:'pages',newPath:'content/wolves/b.md'})).status,403);
  assert.equal(f.writes.length,0);
});

const folder = (members,key='editors') => ({content:JSON.stringify({[key]:members})});
test('folder lists accept individual identities and reject ambiguous, invalid or oversized YAML', () => {
  assert.deepEqual(folderPolicy.parseFolderList('editors:\n  - skautis:test:1942','access'),['skautis:test:1942']);
  for(const source of ['editors: []\neditors: []','editors: [skautis:1942]','editors: [skautis:test:0]','admins: []','editors: &x [a@example.org]\nunknown: *x','editors: [not-a-user]']) assert.throws(()=>folderPolicy.parseFolderList(source,'access'));
  assert.throws(()=>folderPolicy.parseFolderList('x'.repeat(32769),'access'));
});
test('nearest .access governs descendants and unmatched folders are denied',async()=>{
  f.policy=null;
  f.folderFiles={'.access':folder([]),'content/wolves/.access':folder(['leader@example.org']),'content/wolves/private/.access':folder([])};
  const a=await access();
  a.assert('content/wolves/a.md','update');
  assert.throws(()=>a.assert('content/wolves/private/a.md','update'));
  assert.throws(()=>a.assert('content/wolves-other/a.md','update'));
  assert.equal(perms.canCreateWithin(a.permissions,'content/wolves'),true);
  assert.equal(perms.canCreateWithin(a.permissions,'content/wolves/private'),false);
});
test('skautIS IDs come from the linked account, not a client-provided user field',async()=>{
  f.policy=null;f.user.emailVerified=false;f.user.skautisAccountId='test:1942';
  f.folderFiles={'content/wolves/.access':folder(['skautis:test:1942'])};
  assert.equal(perms.canWrite((await access()).permissions,'content/wolves/a.md','update'),false);
  f.skautisAccount={accountId:'test:1942'};
  assert.equal(perms.canWrite((await access()).permissions,'content/wolves/a.md','update'),true);
  f.skautisAccount={accountId:'production:1942'};
  assert.equal(perms.canWrite((await access()).permissions,'content/wolves/a.md','update'),false);
});
test('admins admit users without granting content editing; membership is per individual',()=>{
  const policies={access:[{directory:'x',members:['skautis:test:1']}],admins:[{directory:'x',members:['skautis:test:2']}]};
  assert.equal(folderPolicy.admittedByFolders(policies,{skautisAccountId:'test:1'}),true);
  assert.equal(folderPolicy.admittedByFolders(policies,{skautisAccountId:'test:2'}),true);
  assert.equal(folderPolicy.admittedByFolders(policies,{skautisAccountId:'test:3'}),false);
  assert.equal(folderPolicy.actorMatches(['editor@example.org'],{email:'editor@example.org',emailVerified:false}),false);
});
test('no CMS file operation can change .admins or .access, even as a GitHub administrator',async()=>{
  f.source='user';f.push=true;
  for(const path of ['.admins','content/.admins','content/.admins/x.md','.access','content/.access']) {
    assert.equal(perms.canWrite((await access()).permissions,path,'update'),false);
    assert.equal((await save(path,{sha:'old'})).status,403);
    assert.equal((await invoke(files,path,null,'DELETE')).status,403);
  }
  assert.equal(f.writes.length,0);
});
test('malformed and symlink folder policies fail closed',async()=>{
  f.policy=null;f.folderFiles={'.access':{content:'editors: nope'}};
  await assert.rejects(access);
  f.folderFiles={'.admins':{...folder(['leader@example.org'],'admins'),mode:'120000'}};
  await assert.rejects(access);
  f.folderFiles={};f.truncated=true;await assert.rejects(access);
});
test('folder admins can manage editors; nested .admins overrides the parent',async()=>{
  f.policy=null;
  f.folderFiles={'content/wolves/.admins':folder(['leader@example.org'],'admins'),'content/wolves/private/.admins':folder([],'admins')};
  const a=await access();
  assert.equal(perms.canManageFolderAccess(a.permissions,'content/wolves'),true);
  assert.equal(perms.canManageFolderAccess(a.permissions,'content/wolves/new'),true);
  assert.equal(perms.canManageFolderAccess(a.permissions,'content/wolves/private'),false);
  assert.equal(perms.canWrite(a.permissions,'content/wolves/a.md','update'),false);
});
test('folder management checks .admins, hides other lists, and writes only .access on the policy branch',async()=>{
  f.policy=null;f.folderFiles={'content/wolves/.admins':folder(['leader@example.org'],'admins'),'content/wolves/.access':folder(['old@example.org']),'content/other/.access':folder(['secret@example.org'])};
  const index=await folderManagement.GET(new Request('https://cms.example'),context(''));
  assert.equal(index.status,200);assert.ok(!(await index.text()).includes('secret@example.org'));
  const get=directory=>folderManagement.GET(new Request('https://cms.example?directory='+encodeURIComponent(directory)),context(''));
  assert.equal((await get('content/other')).status,403);
  const current=await (await get('content/wolves')).json();assert.deepEqual(current.editors,['old@example.org']);
  const body={directory:'content/wolves',editors:['skautis:test:1942'],head:current.head};
  assert.equal((await invoke(folderManagement,'',body,'PUT')).status,200);
  assert.deepEqual(f.writes[0].tree,[{path:'content/wolves/.access',mode:'100644',type:'blob',content:'editors:\n  - skautis:test:1942\n'}]);
  assert.equal(f.writes[2].ref,'heads/main');assert.equal(f.writes[2].force,false);
});
test('stale management snapshots, forged admin paths and ordinary editors cannot change access',async()=>{
  f.policy=null;f.folderFiles={'content/wolves/.access':folder(['leader@example.org'])};
  const body={directory:'content/wolves',editors:['leader@example.org'],head:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'};
  assert.equal((await invoke(folderManagement,'',body,'PUT')).status,403);
  f.folderFiles['content/wolves/.admins']=folder(['leader@example.org'],'admins');
  assert.equal((await invoke(folderManagement,'',{...body,head:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'},'PUT')).status,409);
  assert.equal((await invoke(folderManagement,'',{...body,directory:'content/wolves/.admins'},'PUT')).status,403);
  assert.equal(f.writes.length,0);
});
test('cross-folder moves enforce both folder lists and denied folders cannot be reached by rename',async()=>{
  f.policy=null;f.folderFiles={'content/wolves/.access':folder(['leader@example.org']),'content/private/.access':folder([])};
  assert.equal((await invoke(rename,'content/wolves/a.md',{type:'content',name:'pages',newPath:'content/private/a.md'})).status,403);
  assert.equal(f.writes.length,0);
});

test('concurrent permission revocation cannot be overwritten by a management save',async()=>{
  f.policy=null;f.folderFiles={'content/wolves/.admins':folder(['leader@example.org'],'admins')};
  f.octokit.rest.git.updateRef=async args=>{assert.equal(args.force,false);throw Object.assign(Error('not fast forward'),{status:422});};
  const body={directory:'content/wolves',editors:['leader@example.org'],head:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'};
  assert.equal((await invoke(folderManagement,'',body,'PUT')).status,409);
  assert.equal(f.writes.filter(write=>write.name==='ref').length,0);
  assert.equal((await invoke(folderManagement,'',{...body,path:'.admins'},'PUT')).status,400);
});
