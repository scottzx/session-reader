#!/usr/bin/env node
/** Validate the actual tarball in a clean consumer. No model/service start or global install. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('..',import.meta.url));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'1session-pack-'));
const env={...process.env,npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_update_notifier:'false',
  SESSION_READER_DB:path.join(tmp,'unbuilt-structural.db'),SESSION_READER_SEMANTIC_DB:path.join(tmp,'unbuilt-semantic.db')};
const npm=process.platform==='win32'?'npm.cmd':'npm';
function run(command,args,cwd) {
  const result=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,shell:false});
  if(result.error||result.status!==0)throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message??result.stderr}`);
  return result.stdout;
}
try {
  const packed=JSON.parse(run(npm,['pack','--ignore-scripts','--json','--pack-destination',tmp],root))[0];
  const archive=path.join(tmp,packed.filename),consumer=path.join(tmp,'consumer');fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer,'package.json'),JSON.stringify({name:'reader-staging-smoke',version:'1.0.0',private:true,type:'module'}));
  run(npm,['install','--ignore-scripts','--no-audit','--no-fund','--save-exact',archive],consumer);
  run(npm,['ci','--ignore-scripts','--no-audit','--no-fund'],consumer);
  const installed=path.join(consumer,'node_modules/@1agents/session-reader');
  const manifest=JSON.parse(fs.readFileSync(path.join(installed,'package.json'),'utf8'));
  for(const rel of [manifest.main,manifest.types,manifest.bin['1session'],manifest.dsh.bundle.patch,'dist/src/dsh/client.js','dist/src/web/app.js','docs/semantic-index.md','skills/1session/SKILL.md']) {
    assert.ok(fs.existsSync(path.join(installed,rel)),`Missing packaged entry: ${rel}`);
  }
  run(process.execPath,['--input-type=module','-e',`const api=await import('@1agents/session-reader');for(const name of ['searchSessions','retrieveSessions','buildSemanticIndex','semanticStatus','forgetSemanticSession'])if(typeof api[name]!=='function')throw new Error('Missing '+name);`],consumer);
  const help=run(process.execPath,[path.join(installed,manifest.bin['1session']),'help'],consumer);
  assert.match(help,/--mode keyword\|semantic/);assert.match(help,/index build\|status\|forget --semantic/);
  const refused=spawnSync(process.execPath,[path.join(installed,manifest.bin['1session']),'search','phone','--global','--mode','semantic','--json'],{cwd:consumer,env,encoding:'utf8',timeout:10000});
  assert.equal(refused.status,1);assert.match(refused.stderr,/Structural index is missing/);
  assert.equal(fs.existsSync(env.SESSION_READER_SEMANTIC_DB),false);
  console.log(JSON.stringify({package:manifest.name,version:manifest.version,tarballSha256:createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    cleanInstall:true,frozenReinstall:true,exports:true,cli:true,dshAssets:true,missingIndexRefused:true,modelInvoked:false}));
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
