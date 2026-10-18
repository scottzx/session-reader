import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { embeddingProfile, type EmbeddingProfile, type EmbeddingResult } from '@1agents/artifact-index/embeddings';
import { openStore, resetStoreCache, defaultDbPath } from '../src/store/db.js';
import { SCHEMA_VERSION } from '../src/store/schema.js';
import { buildSemanticIndex, forgetSemanticSession, semanticStatus, searchSemanticSessions, type SemanticClient, type SemanticOptions } from '../src/semantic/index.js';
import { chunkText } from '../src/semantic/chunks.js';

const profile = (alias: 'qwen3'|'embeddinggemma2'='qwen3', revision='fixture-v1'): EmbeddingProfile => embeddingProfile({model:alias,revision,dimensions:2,encoding:alias==='qwen3'?'dreammate.artifact-search.v1:fp32:max512:dim2':'dreammate.gemma2.v1:fp32:max2048:dim2',...(alias==='qwen3'?{task:'document_search' as const}:{})});
function fake() {
  const calls: {type:string;texts:string[]}[]=[];
  const encode=(texts:string[],p:EmbeddingProfile,type:string):EmbeddingResult=>{calls.push({type,texts});return {profile:p,vectors:texts.map(s=>s.includes('phone')?[1,0]:[0,1])};};
  const client:SemanticClient={
    getProfile:async kind=>profile(kind==='text'?'qwen3':'embeddinggemma2'),
    getTextProfile:async alias=>profile(alias),
    embedText:async(texts)=>encode(texts,profile(),'document'),
    embedDocuments:async(texts,p)=>encode(texts,p,'document'),
    embedQuery:async(text,p)=>encode([text],embeddingProfile(p),'query'),
  };
  return {client,calls};
}
async function fixture(t: import('node:test').TestContext) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'semantic-test-'));
  const sourceDbPath=path.join(dir,'structural.db'),dbPath=path.join(dir,'semantic.db');
  resetStoreCache();const db=await openStore(sourceDbPath);db.close();resetStoreCache();
  t.after(()=>{resetStoreCache();fs.rmSync(dir,{recursive:true,force:true});});
  const f=fake();
  const options:SemanticOptions={sourceDbPath,dbPath,client:f.client};
  function add(id:string, text:string, workspace='/tmp/project-a', idx=0, kind='user') {
    const s=new DatabaseSync(sourceDbPath);
    try {
      s.prepare('INSERT OR IGNORE INTO sessions(id,provider,native_id,source_path,workspace,source_size,source_mtime_ms) VALUES(?,?,?,?,?,?,?)').run(`claude:${id}`,'claude',id,`/tmp/${id}.jsonl`,workspace,1,1000);
      s.prepare('INSERT OR REPLACE INTO events(session_id,idx,kind,text,locator,ts) VALUES(?,?,?,?,?,?)').run(`claude:${id}`,idx,kind,text,`event-${id}-${idx}`,'2026-01-01T00:00:00Z');
      s.prepare('UPDATE sessions SET event_count=(SELECT count(*) FROM events WHERE session_id=?),source_size=source_size+1,source_mtime_ms=source_mtime_ms+1 WHERE id=?').run(`claude:${id}`,`claude:${id}`);
    }finally{s.close();}
  }
  return {dir,options,add,...f};
}

test('version-isolated default path never targets the legacy index.db',()=>{
  const previous=process.env.SESSION_READER_DB;delete process.env.SESSION_READER_DB;
  try{assert.equal(path.basename(defaultDbPath()),`index-v${SCHEMA_VERSION}.db`);}finally{if(previous!==undefined)process.env.SESSION_READER_DB=previous;}
});

test('schema mismatch preserves populated old/new/unknown core databases byte-for-byte',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'schema-guard-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const version of ['1','999','not-a-version',null]) {
    const file=path.join(dir,`${version}.db`);const db=new DatabaseSync(file);db.exec("CREATE TABLE precious(value TEXT); INSERT INTO precious VALUES('keep me');");
    if(version!==null){db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)');db.prepare('INSERT INTO meta VALUES(?,?)').run('schema_version',version);}db.close();
    const before=fs.readFileSync(file);resetStoreCache();await assert.rejects(()=>openStore(file),{code:'INDEX_SCHEMA_MISMATCH'});
    assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(file+'-wal'),false);
    const read=new DatabaseSync(file,{readOnly:true});assert.equal((read.prepare('SELECT value FROM precious').get() as {value:string}).value,'keep me');read.close();
  }
});

test('chunking is deterministic, byte-bounded and preserves unicode offsets',()=>{
  const text=('手机 phone🙂 文档\n').repeat(100);const a=chunkText(text),b=chunkText(text);assert.deepEqual(a,b);assert.ok(a.length>1);
  assert.equal(a[0]!.start,0);assert.equal(a.at(-1)!.end,text.length);
  for(const c of a){assert.ok(Buffer.byteLength(c.text)<=320);assert.equal(text.slice(c.start,c.end),c.text);assert.equal(c.text.includes('�'),false);}
  assert.deepEqual(chunkText(''),[]);
});

test('unchanged second build performs zero document encoding; append reuses old vectors',async t=>{
  const f=await fixture(t);f.add('session-one','phone is the personal entry');
  const first=await buildSemanticIndex(f.options);assert.equal(first.encodedVectors,1);assert.equal(first.partial,false);
  f.calls.length=0;const second=await buildSemanticIndex(f.options);assert.equal(second.encodedVectors,0);assert.equal(second.reusedVectors,1);assert.equal(f.calls.length,0);
  f.add('session-one','desktop does tasks','/tmp/project-a',1,'assistant');
  assert.equal((await semanticStatus(f.options)).pendingEvents,2);
  const third=await buildSemanticIndex(f.options);assert.equal(third.encodedVectors,1);assert.equal(third.reusedVectors,1);assert.equal(third.totalEvents,2);
});

test('changed text is re-encoded and source mismatch is not returned as current evidence',async t=>{
  const f=await fixture(t);f.add('session-one','phone old decision');await buildSemanticIndex(f.options);
  f.add('session-one','desktop new decision');
  const stale=await searchSemanticSessions('phone',f.options);assert.equal(stale.hits.length,0);assert.equal(stale.retrieval.partial,true);
  const next=await buildSemanticIndex(f.options);assert.equal(next.encodedVectors,1);
  const result=await searchSemanticSessions('desktop',f.options);assert.equal(result.hits[0]!.matches[0]!.excerpt,'desktop new decision');
});

test('failed revision build preserves last active profile and marks failure',async t=>{
  const f=await fixture(t);f.add('session-one','phone');await buildSemanticIndex(f.options);
  const client:SemanticClient={...f.client,getTextProfile:async()=>profile('qwen3','new-revision'),embedDocuments:async()=>{throw Object.assign(new Error('offline'),{code:'EMBEDDING_UNAVAILABLE'});}};
  await assert.rejects(()=>buildSemanticIndex({...f.options,client}),/offline/);
  const state=await semanticStatus(f.options);assert.equal(state.profile!.revision,'fixture-v1');assert.equal(state.lastBuild!.status,'failed');
  assert.equal((await searchSemanticSessions('phone',f.options)).hits.length,1);
});

test('failed later batch can resume using committed vector cache without partial activation',async t=>{
  const f=await fixture(t);for(let i=0;i<20;i++)f.add('session-one',`phone event ${i}`,'/tmp/project-a',i);
  let batches=0;const client:SemanticClient={...f.client,embedDocuments:async(texts,p)=>{if(++batches===2)throw new Error('batch failed');return f.client.embedDocuments!(texts,p);}};
  await assert.rejects(()=>buildSemanticIndex({...f.options,client}),/batch failed/);
  assert.equal((await semanticStatus(f.options)).profile,null);
  const result=await buildSemanticIndex(f.options);assert.equal(result.encodedVectors,4);assert.equal(result.reusedVectors,16);assert.equal(result.pendingEvents,0);
});

test('writer lease prevents competing builds, and is released on success',async t=>{
  const f=await fixture(t);f.add('session-one','phone');let unblock!:()=>void;let ready!:()=>void;
  const started=new Promise<void>(r=>{ready=r;});const wait=new Promise<void>(r=>{unblock=r;});
  const client:SemanticClient={...f.client,embedDocuments:async(texts,p)=>{ready();await wait;return f.client.embedDocuments!(texts,p);}};
  const first=buildSemanticIndex({...f.options,client});await started;
  await assert.rejects(()=>buildSemanticIndex(f.options),{code:'SEMANTIC_BUILD_BUSY'});unblock();await first;
  assert.equal(fs.existsSync(f.options.dbPath+'.build.lock'),false);
});

test('source mutation during encoding refuses promotion',async t=>{
  const f=await fixture(t);f.add('session-one','phone');
  const client:SemanticClient={...f.client,embedDocuments:async(texts,p)=>{f.add('session-one','changed');return f.client.embedDocuments!(texts,p);}};
  await assert.rejects(()=>buildSemanticIndex({...f.options,client}),{code:'SEMANTIC_SOURCE_CHANGED'});
  assert.equal((await semanticStatus(f.options)).profile,null);
});

test('unknown semantic schema is not altered by a build attempt',async t=>{
  const f=await fixture(t);f.add('session-one','phone');
  const db=new DatabaseSync(f.options.dbPath!);db.exec("CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('schema_version','99');");db.close();
  const before=fs.readFileSync(f.options.dbPath!);await assert.rejects(()=>buildSemanticIndex(f.options),{code:'SEMANTIC_SCHEMA_MISMATCH'});assert.deepEqual(fs.readFileSync(f.options.dbPath!),before);
});

test('Qwen and Gemma are separate vector spaces; mismatched vectors are refused',async t=>{
  const f=await fixture(t);f.add('session-one','phone');await buildSemanticIndex(f.options);
  const gemma=await buildSemanticIndex({...f.options,model:'embeddinggemma2'});assert.equal(gemma.profile!.alias,'embeddinggemma2');assert.equal(gemma.encodedVectors,1);
  assert.equal((await searchSemanticSessions('phone',{...f.options,model:'embeddinggemma2'})).retrieval.profile!.alias,'embeddinggemma2');
  const bad:SemanticClient={...f.client,embedQuery:async()=>({profile:profile('embeddinggemma2'),vectors:[[1,0]]})};
  await assert.rejects(()=>searchSemanticSessions('phone',{...f.options,client:bad}),{code:'SEMANTIC_PROFILE_MISMATCH'});
});

test('published old client supports Qwen only and refuses Gemma before encoding',async t=>{
  const f=await fixture(t);f.add('session-one','phone');
  const old:SemanticClient={getProfile:f.client.getProfile,embedText:f.client.embedText,embedQuery:f.client.embedQuery};
  await buildSemanticIndex({...f.options,client:old});f.calls.length=0;
  await assert.rejects(()=>buildSemanticIndex({...f.options,client:old,model:'embeddinggemma2'}),{code:'SEMANTIC_CLIENT_UPGRADE_REQUIRED'});assert.equal(f.calls.length,0);
});

test('scope is applied before ranking with no hidden candidate truncation',async t=>{
  const f=await fixture(t);for(let i=0;i<210;i++)f.add(`session-${String(i).padStart(4,'0')}`,i===209?'phone relevant':'desktop generic');
  f.add('other-workspace','phone private','/tmp/project-b');await buildSemanticIndex(f.options);
  const result=await searchSemanticSessions('phone',{...f.options,workspace:'/tmp/project-a',limit:1});
  assert.equal(result.hits[0]!.session.id,'session-0209');assert.equal(result.retrieval.indexedSessions,210);assert.equal(result.hits[0]!.matches[0]!.locator,'event-session-0209-0');
  assert.deepEqual(result.hits[0]!.matches[0]!.chunkRange,[0,14]);
  const own=await searchSemanticSessions('phone',{...f.options,workspace:'/tmp/project-a',sessionId:'session-0209',selfSessionId:'claude:session-0209'});assert.equal(own.hits.length,0);
  const outside=await searchSemanticSessions('phone',{...f.options,workspace:'/tmp/project-a',sessionId:'other-workspace'});assert.equal(outside.hits.length,0);
});

test('unsupported semantic modes reject explicitly; queries never build',async t=>{
  const f=await fixture(t);f.add('session-one','phone');
  await assert.rejects(()=>searchSemanticSessions('phone',f.options),{code:'SEMANTIC_INDEX_REQUIRED'});assert.equal(fs.existsSync(f.options.dbPath!),false);
  for(const opt of [{regex:true},{area:'tools' as const},{terms:['x']},{cursor:'abc'},{limit:0},{model:'bad' as never},{since:'bad-date'}]){
    await assert.rejects(()=>searchSemanticSessions('x',{...f.options,...opt}),{code:'SEMANTIC_INVALID_QUERY'});
  }
  await buildSemanticIndex(f.options);const client:SemanticClient={...f.client,embedQuery:async()=>{throw Object.assign(new Error('model offline'),{code:'EMBEDDING_UNAVAILABLE'});}};
  await assert.rejects(()=>searchSemanticSessions('phone',{...f.options,client}),{code:'EMBEDDING_UNAVAILABLE'});
});

test('tool/thinking text is never indexed; unlocatable dialogue is explicitly counted',async t=>{
  const f=await fixture(t);f.add('session-one','phone user');f.add('session-one','secret tool','/tmp/project-a',1,'tool_result');f.add('session-one','hidden thinking','/tmp/project-a',2,'thinking');
  f.add('session-one','no locator','/tmp/project-a',3);const db=new DatabaseSync(f.options.sourceDbPath!);db.prepare('UPDATE events SET locator=NULL WHERE idx=3').run();db.close();
  const result=await buildSemanticIndex(f.options);assert.equal(result.totalEvents,1);assert.equal(result.skippedEvents,1);assert.equal(result.partial,true);
  assert.deepEqual(f.calls.filter(c=>c.type==='document').flatMap(c=>c.texts),['phone user']);
});

test('semantic database cannot overwrite the structural database',async t=>{
  const f=await fixture(t);await assert.rejects(()=>buildSemanticIndex({...f.options,dbPath:f.options.sourceDbPath}),{code:'SEMANTIC_SCHEMA_MISMATCH'});
});


test('explicit exact eviction keeps shared vectors and never changes the source index',async t=>{
  const f=await fixture(t);f.add('session-one','phone');f.add('session-two','phone');await buildSemanticIndex(f.options);
  const before=fs.readFileSync(f.options.sourceDbPath!);
  await assert.rejects(()=>forgetSemanticSession('session-one',f.options),{code:'SEMANTIC_INVALID_QUERY'});
  const removed=await forgetSemanticSession('claude:session-one',f.options);assert.equal(removed.removedChunks,1);
  assert.deepEqual(fs.readFileSync(f.options.sourceDbPath!),before);
  const result=await searchSemanticSessions('phone',f.options);assert.deepEqual(result.hits.map(h=>h.session.id),['session-two']);
  assert.equal(result.retrieval.pendingEvents,1);
  const db=new DatabaseSync(f.options.dbPath!,{readOnly:true});assert.equal((db.prepare('SELECT count(*) AS n FROM vectors').get() as {n:number}).n,1);db.close();
});

test('empty scope does not activate a new index',async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>buildSemanticIndex(f.options),{code:'SEMANTIC_SOURCE_REQUIRED'});
  assert.equal((await semanticStatus(f.options)).profile,null);
});

test('query rechecks the structural snapshot after embedding',async t=>{
  const f=await fixture(t);f.add('session-one','phone');await buildSemanticIndex(f.options);
  const client:SemanticClient={...f.client,embedQuery:async(text,p)=>{f.add('session-one','updated');return f.client.embedQuery(text,p);}};
  const result=await searchSemanticSessions('phone',{...f.options,client});assert.equal(result.hits.length,0);assert.equal(result.retrieval.partial,true);
});


test('semantic excerpts round-trip NUL bytes without corrupting locators or ranges', async t => {
  const f = await fixture(t);
  f.add('nul-text', 'phone placeholder');
  const body = 'phone\0tail 保持原文';
  const db = new DatabaseSync(f.options.sourceDbPath!);
  const { encodeText } = await import('../src/store/nul.js');
  db.prepare('UPDATE events SET text=? WHERE session_id=?').run(encodeText(body), 'claude:nul-text');
  db.close();
  await buildSemanticIndex(f.options);
  const result = await searchSemanticSessions('phone', f.options);
  assert.equal(result.hits[0]!.matches[0]!.excerpt, body);
  assert.deepEqual(result.hits[0]!.matches[0]!.chunkRange, [0, body.length]);
});

test('semantic totalMatches counts all distinct events before the output limit', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) f.add('many-events', `phone event ${i}`, '/tmp/project-a', i);
  await buildSemanticIndex(f.options);
  const result = await searchSemanticSessions('phone', { ...f.options, maxPerSession: 2 });
  assert.equal(result.hits[0]!.matches.length, 2);
  assert.equal(result.hits[0]!.totalMatches, 8);
  assert.equal(result.hits[0]!.hasMore, true);
});
