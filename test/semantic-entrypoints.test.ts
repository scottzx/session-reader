import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { openStore, resetStoreCache } from '../src/store/db.js';
import { createServer } from '../src/serve/http.js';
import { serveWeb } from '../src/web/server.js';
import { apply } from '../src/dsh/plugin.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));

test('CLI, HTTP, Web API and DSH share the opt-in semantic contract', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-entrypoints-'));
  const source = path.join(root, 'structural.db'), semantic = path.join(root, 'semantic.db');
  const vars = ['SESSION_READER_DB','SESSION_READER_SEMANTIC_DB','SESSION_READER_EMBEDDING_GATEWAY'];
  const previous = Object.fromEntries(vars.map(k => [k, process.env[k]]));
  const servers: http.Server[] = [];
  t.after(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    resetStoreCache();
    for (const key of vars) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const profile = { alias: 'qwen3', model: 'qwen3@entrypoint-v1', revision: 'entrypoint-v1', dimensions: 2,
    encoding: 'dreammate.artifact-search.v1:fp32:max512:dim2', task: 'document_search' };
  let documents = 0;
  const gateway = http.createServer(async (req, res) => {
    res.setHeader('Content-Type','application/json');
    if (req.url === '/services') {
      res.end(JSON.stringify({ services: [{ id: 'local-qwen', port: (gateway.address() as AddressInfo).port, execution: 'http', liveness: 'up',
        metadata: { embedding_provider: { protocol:'dreammate.embedding.v1', model:'qwen3', revision:profile.revision,
          dimensions:2, encoding:'dreammate.tool-search.v1:fp32:max512:dim2', ready:true } },
        methods:{ 'embedding.status':{}, 'embedding.encode_text':{} } }] }));
      return;
    }
    const buffers: Buffer[] = []; for await (const chunk of req) buffers.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(buffers).toString());
    if (body.method === 'embedding.status') res.end(JSON.stringify({ embedding_profiles:[{model:'qwen3', revision:profile.revision, dimensions:2, encoding:profile.encoding, task:profile.task}] }));
    else {
      assert.equal(body.params.task, 'document_search');
      if (body.params.input_type === 'document') documents += body.params.texts.length;
      res.end(JSON.stringify({ ...profile, embeddings:body.params.texts.map(() => [1,0]) }));
    }
  });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve)); servers.push(gateway);
  process.env.SESSION_READER_DB = source;
  process.env.SESSION_READER_SEMANTIC_DB = semantic;
  process.env.SESSION_READER_EMBEDDING_GATEWAY = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  resetStoreCache(); const db = await openStore();
  db.prepare('INSERT INTO sessions(id,provider,native_id,source_path,workspace,source_size,source_mtime_ms,event_count) VALUES(?,?,?,?,?,?,?,?)')
    .run('claude:entrypoint-test','claude','entrypoint-test',path.join(root,'transcript.jsonl'),root,1,1000,2);
  for (let i = 0; i < 2; i++) db.prepare('INSERT INTO events(session_id,idx,kind,text,locator) VALUES(?,?,?,?,?)')
    .run('claude:entrypoint-test',i,'user',`phone entry ${i}`,`native-${i}`);
  db.close(); resetStoreCache();
  const cli = (...args: string[]) => exec(process.execPath, ['--import','tsx','bin/1session.ts',...args], { cwd:repo, env:process.env });
  const first = JSON.parse((await cli('index','build','--semantic','--global','--json')).stdout);
  assert.equal(first.encodedVectors,2); assert.equal(documents,2);
  const second = JSON.parse((await cli('index','build','--semantic','--global','--json')).stdout);
  assert.equal(second.encodedVectors,0); assert.equal(documents,2);
  const found = JSON.parse((await cli('search','phone','--mode','semantic','--global','--json')).stdout);
  assert.equal(found.retrieval.mode,'semantic'); assert.equal(found.hits[0].matches[0].locator,'native-0');
  assert.equal(found.retrieval.rawSourceDiscovery,false);
  fs.mkdirSync(path.join(root,'outside'));
  const empty = await cli('search','phone','--mode','semantic','--scope',path.join(root,'outside'));
  assert.match(empty.stdout,/无命中/); assert.match(empty.stdout,/结构化索引快照/);
  const service = createServer(); await new Promise<void>(resolve => service.listen(0,'127.0.0.1',resolve)); servers.push(service);
  const origin = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  const apiResponse = await fetch(origin+'/v1/search?q=phone&mode=semantic&scope=global');
  assert.equal(apiResponse.status,200); const fromHttp = await apiResponse.json() as typeof found;
  assert.deepEqual(fromHttp.hits[0].matches,found.hits[0].matches);
  const web = await serveWeb({port:0,cwd:root}); servers.push(web);
  const webOrigin = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  const fromWeb = await (await fetch(webOrigin+'/api/session-reader/search?q=phone&mode=semantic&scope=global')).json() as typeof found;
  assert.deepEqual(fromWeb.hits[0].matches,found.hits[0].matches);
  const tools = new Map<string,any>();
  apply({ effect:(fn:()=>unknown)=>fn(), tools:{register:(tool:any)=>{tools.set(tool.name,tool);return ()=>{};}} });
  const search = tools.get('session_search');
  assert.deepEqual(search.parameters.properties.mode.enum,['keyword','semantic']);
  const fromDsh = await search.execute({query:'phone',scope:'global',mode:'semantic'}, {agent:{session:{header:{id:'another-session'}}}});
  assert.deepEqual(fromDsh.hits[0].matches,found.hits[0].matches);
  const bad = await fetch(webOrigin+'/api/session-reader/search?q=phone&mode=semantic&model=bad&scope=global');
  assert.equal(bad.status,400); assert.equal((await bad.json() as any).code,'SEMANTIC_INVALID_QUERY');
  process.env.SESSION_READER_SEMANTIC_DB=path.join(root,'missing.db');
  const unavailable = await fetch(webOrigin+'/api/session-reader/search?q=phone&mode=semantic&scope=global');
  assert.equal(unavailable.status,503); assert.equal((await unavailable.json() as any).code,'SEMANTIC_INDEX_REQUIRED');
  assert.equal(fs.existsSync(process.env.SESSION_READER_SEMANTIC_DB),false,'queries must never create the index');
});
