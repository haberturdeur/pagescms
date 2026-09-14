import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pagescms-skautis-test-'));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const compiled = new Map();
function compile(relative) {
  if (compiled.has(relative)) return compiled.get(relative);
  const file = path.join(temporary, relative.replace(/\.tsx?$/, '.mjs'));
  compiled.set(relative, pathToFileURL(file).href);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let source = fs.readFileSync(path.join(root, relative), 'utf8');
  if (relative === 'db/envConfig.ts') source = '';
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/(from\s*|import\s*)(["'])([^"']+)\2/g, (_match, prefix, _quote, name) => {
      let target;
      if (name.startsWith('@/') || name.startsWith('.')) {
        let resolved = name.startsWith('@/') ? name.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(relative), name));
        resolved = fs.existsSync(path.join(root, resolved + '.ts')) ? resolved + '.ts' : resolved + '/index.ts';
        target = compile(resolved);
      } else target = import.meta.resolve(name === 'next/server' ? 'next/server.js' : name);
      return prefix + JSON.stringify(target);
    });
  fs.writeFileSync(file, code);
  return pathToFileURL(file).href;
}
const protocol = await import(compile('lib/skautis/protocol.ts'));
const config = { appId: '11111111-1111-1111-1111-111111111111', origin: 'https://test-is.skaut.cz', providerId: 'skautis-test' };
const responseXml = (id = '123', active = 'true') => `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><UserDetailResponse xmlns="https://is.skaut.cz/"><UserDetailResult><ID>${id}</ID><IsActive>${active}</IsActive><IsEnabled>true</IsEnabled></UserDetailResult></UserDetailResponse></soap:Body></soap:Envelope>`;

test('SkautIS is opt-in, validates configuration and isolates test identities', () => {
  assert.equal(protocol.getSkautisConfig({}), null);
  assert.equal(protocol.getSkautisConfig({ SKAUTIS_APP_ID: config.appId }).providerId, 'skautis-test');
  assert.equal(protocol.getSkautisConfig({ SKAUTIS_APP_ID: config.appId, SKAUTIS_ENVIRONMENT: 'production' }).providerId, 'skautis-production');
  assert.throws(() => protocol.getSkautisConfig({ SKAUTIS_APP_ID: 'invalid' }));
  assert.throws(() => protocol.getSkautisConfig({ SKAUTIS_APP_ID: config.appId, SKAUTIS_ENVIRONMENT: 'invalid' }));
});
test('callback accepts only the exact local finish URL', () => {
  const state = 'a'.repeat(64);
  const url = protocol.finishUrl('https://cms.example.com', state);
  assert.equal(protocol.callbackState(url.href, 'https://cms.example.com'), state);
  for (const bad of ['https://evil.example/?state=' + state, url.href + '&extra=1', url.href + '#fragment', '/relative', url.href.replace('/finish', '/other')]) {
    assert.throws(() => protocol.callbackState(bad, 'https://cms.example.com'));
  }
  assert.equal(new URL(protocol.loginUrl(config, url)).searchParams.get('ReturnUrl'), url.href);
});
test('SOAP identity must be active, enabled and validated; unsafe XML and tokens fail', () => {
  assert.equal(protocol.parseUserDetail(responseXml()), '123');
  for (const bad of [responseXml('0'), responseXml('123', 'false'), '<broken>', '<!DOCTYPE x><x/>', responseXml().replace('IsEnabled>true', 'IsEnabled>false'), '<Envelope><Body><Fault/></Body></Envelope>']) {
    assert.throws(() => protocol.parseUserDetail(bad));
  }
  assert.throws(() => protocol.userDetailEnvelope('<injection>'));
  assert.match(protocol.userDetailEnvelope(config.appId), /<ID xsi:nil="true"/);
});

test('real email OTP and SkautIS linking/login reject takeover, replay and stale state', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL);
  assert.match(testUrl.pathname, /_test$/, 'Use a disposable database with a name ending in _test');
  process.env.DATABASE_URL = testUrl.href;
  process.env.BASE_URL = 'http://localhost:3000';
  process.env.SKAUTIS_APP_ID = config.appId;
  process.env.SKAUTIS_ENVIRONMENT = 'test';
  const { default: postgres } = await import('postgres');
  const sql = postgres(testUrl.href);
  const { db } = await import(compile('db/index.ts'));
  const schema = await import(compile('db/schema.ts'));
  const { eq } = await import('drizzle-orm');
  const { drizzleAdapter } = await import('better-auth/adapters/drizzle');
  const { betterAuth } = await import('better-auth');
  const { emailOTP } = await import('better-auth/plugins');
  const { skautisAuth } = await import(compile('lib/skautis/plugin.ts'));
  const { POST: callback } = await import(compile('app/(auth)/auth/skautis/callback/route.ts'));
  const { NextRequest } = await import('next/server.js');
  const codes = new Map();
  try {
    await sql.unsafe(`CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL, email_verified boolean DEFAULT false NOT NULL, image text, github_username text, created_at timestamp DEFAULT now() NOT NULL, updated_at timestamp DEFAULT now() NOT NULL);
CREATE TABLE session (id text PRIMARY KEY, expires_at timestamp NOT NULL, token text UNIQUE NOT NULL, created_at timestamp DEFAULT now() NOT NULL, updated_at timestamp DEFAULT now() NOT NULL, ip_address text, user_agent text, user_id text REFERENCES "user"(id) NOT NULL);
CREATE TABLE account (id text PRIMARY KEY, account_id text NOT NULL, provider_id text NOT NULL, user_id text REFERENCES "user"(id) NOT NULL, access_token text, refresh_token text, id_token text, access_token_expires_at timestamp, refresh_token_expires_at timestamp, scope text, password text, created_at timestamp DEFAULT now() NOT NULL, updated_at timestamp DEFAULT now() NOT NULL);
CREATE TABLE verification (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, expires_at timestamp NOT NULL, created_at timestamp DEFAULT now() NOT NULL, updated_at timestamp DEFAULT now() NOT NULL);`);
    const auth = betterAuth({
      baseURL: process.env.BASE_URL, secret: 'test-only-secret-at-least-thirty-two-characters',
      database: drizzleAdapter(db, { provider: 'pg', schema: { user: schema.userTable, session: schema.sessionTable, account: schema.accountTable, verification: schema.verificationTable } }),
      advanced: { disableCSRFCheck: false }, rateLimit: { enabled: false },
      plugins: [skautisAuth(), emailOTP({ sendVerificationOTP: async ({ email, otp }) => codes.set(email, otp) })],
    });
    const request = (route, body, cookie = '') => auth.handler(new Request(process.env.BASE_URL + '/api/auth' + route, {
      method: body === undefined ? 'GET' : 'POST', headers: { origin: process.env.BASE_URL, 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const cookies = response => response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const emailLogin = async email => {
      const sent = await request('/email-otp/send-verification-otp', { email, type: 'sign-in' });
      assert.equal(sent.status, 200);
      assert.ok(codes.has(email));
      const wrong = await request('/sign-in/email-otp', { email, otp: 'invalid' });
      assert.notEqual(wrong.status, 200);
      const result = await request('/sign-in/email-otp', { email, otp: codes.get(email) });
      assert.equal(result.status, 200);
      const cookie = cookies(result);
      const session = await (await request('/get-session', undefined, cookie)).json();
      assert.equal(session.user.emailVerified, true);
      return { cookie, user: session.user };
    };
    delete process.env.SKAUTIS_APP_ID;
    assert.equal((await request('/skautis/start', { mode: 'login' })).status, 404);
    process.env.SKAUTIS_APP_ID = config.appId;
    assert.equal((await request('/skautis/start', { mode: 'link' })).status, 403);
    const alice = await emailLogin('alice@example.com');
    const bob = await emailLogin('bob@example.com');
    const start = async (mode, cookie = '') => {
      const res = await request('/skautis/start', { mode }, cookie);
      assert.equal(res.status, 200);
      const login = new URL((await res.json()).url);
      const finish = new URL(login.searchParams.get('ReturnUrl'));
      return { state: finish.searchParams.get('state'), finish, cookie: cookies(res) + '; ' + cookie };
    };
    const originalFetch = globalThis.fetch;
    let identity = '123';
    globalThis.fetch = async (url, options) => {
      assert.equal(url, config.origin + '/JunakWebservice/UserManagement.asmx');
      assert.match(options.body, /<ID_Login>/);
      return new Response(responseXml(identity));
    };
    try {
      const confirm = async flow => {
        const url = new URL('/auth/skautis/callback', process.env.BASE_URL);
        url.searchParams.set('ReturnUrl', flow.finish.href);
        const res = await callback(new NextRequest(url, { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ skautIS_Token: config.appId }) }));
        assert.equal(res.status, 303);
      };
      const finish = flow => request('/skautis/finish?state=' + flow.state, undefined, flow.cookie);
      const linking = await start('link', alice.cookie);
      await confirm(linking);
      // A different browser cannot consume a valid callback.
      const wrongBrowser = await request('/skautis/finish?state=' + linking.state, undefined, bob.cookie);
      assert.match(wrongBrowser.headers.get('location'), /error=/);
      assert.equal((await finish(linking)).headers.get('location'), '/settings?skautis=connected');
      assert.match((await finish(linking)).headers.get('location'), /error=/);
      const login = await start('login');
      await confirm(login);
      const signedIn = await finish(login);
      assert.equal(signedIn.headers.get('location'), '/');
      const session = await (await request('/get-session', undefined, cookies(signedIn))).json();
      assert.equal(session.user.id, alice.user.id);
      const takeover = await start('link', bob.cookie);
      await confirm(takeover);
      assert.match((await finish(takeover)).headers.get('location'), /error=/);
      const stale = await start('link', alice.cookie);
      await confirm(stale);
      stale.cookie = stale.cookie.split('; ').filter(c => !c.startsWith('better-auth.')).join('; ') + '; ' + bob.cookie;
      assert.match((await finish(stale)).headers.get('location'), /error=/);
      identity = '999';
      const unknown = await start('login');
      await confirm(unknown);
      assert.match((await finish(unknown)).headers.get('location'), /email/);
      const expired = await start('login');
      await db.update(schema.verificationTable).set({ expiresAt: new Date(0) }).where(eq(schema.verificationTable.id, 'skautis:' + expired.state));
      assert.match((await finish(expired)).headers.get('location'), /error=/);
      assert.equal((await request('/skautis/disconnect', {}, alice.cookie)).status, 200);
      assert.equal((await sql`select * from account where provider_id = 'skautis-test'`).length, 0);
    } finally { globalThis.fetch = originalFetch; }
  } finally {
    await sql.end();
    await globalThis.__pagesCmsPostgresClient?.end();
  }
});
