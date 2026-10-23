import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { extractPluginRepository } from '../extract-plugin-repository.mjs';
import { validatePluginReleaseIndex } from '../plugin-release-lock.mjs';
const require=createRequire(new URL('../../../apps/readest-app/package.json',import.meta.url));
const {ZipWriter,Uint8ArrayWriter,Uint8ArrayReader}=require('@zip.js/zip.js');
const plugin={id:'io.github.wenhe233.venera',version:'0.3.0-x1',fingerprint:'a'.repeat(64)};
const pin={plugins:[plugin]};
const validate=(staging)=>validatePluginReleaseIndex(JSON.parse(readFileSync(join(staging,'index.json'))),pin);
async function archive(extra=[],index=JSON.stringify({schemaVersion:1,plugins:[plugin]})) {
 const writer=new ZipWriter(new Uint8ArrayWriter(),{useWebWorkers:false});
 for(const [name,value] of [['repo.json','{}'],['index.json',index],['plugins/venera-0.3.0-x1.readest-plugin','new'],...extra])
  await writer.add(name,new Uint8ArrayReader(new TextEncoder().encode(value)));
 return writer.close();
}
test('replaces an extracted release without retaining packages from the previous version',async()=>{
 const root=mkdtempSync(join(tmpdir(),'readest-plugin-extract-'));
 try {
  const previous=join(root,'.v2-artifacts/repository/plugins');mkdirSync(previous,{recursive:true});
  writeFileSync(join(previous,'venera-0.2.0-x1.readest-plugin'),'old');
  const output=await extractPluginRepository(await archive(),root,validate);
  assert.equal(output,join(root,'.v2-artifacts/repository'));
  assert.deepEqual(readdirSync(join(output,'plugins')),['venera-0.3.0-x1.readest-plugin']);
  assert.equal(readFileSync(join(output,'plugins/venera-0.3.0-x1.readest-plugin'),'utf8'),'new');
 } finally {if(!realpathSync(root).startsWith(realpathSync(tmpdir())+sep))throw new Error('Invalid test cleanup');rmSync(root,{recursive:true});}
});
test('retains the previous extraction when an archive contains an unexpected path',async()=>{
 const root=mkdtempSync(join(tmpdir(),'readest-plugin-extract-'));
 try {
  const previous=join(root,'.v2-artifacts/repository/plugins');mkdirSync(previous,{recursive:true});
  writeFileSync(join(previous,'venera-0.2.0-x1.readest-plugin'),'old');
  const invalid=await archive([['unexpected.txt','no']]);
  await assert.rejects(()=>extractPluginRepository(invalid,root,validate),/Unexpected/);
  assert.equal(readFileSync(join(previous,'venera-0.2.0-x1.readest-plugin'),'utf8'),'old');
 } finally {if(!realpathSync(root).startsWith(realpathSync(tmpdir())+sep))throw new Error('Invalid test cleanup');rmSync(root,{recursive:true});}
});
test('refuses a repository junction before replacing or deleting its target',async()=>{
 const root=mkdtempSync(join(tmpdir(),'readest-plugin-extract-'));
 try {
  const outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep.txt'),'keep');
  mkdirSync(join(root,'.v2-artifacts'));
  symlinkSync(outside,join(root,'.v2-artifacts/repository'),'junction');
  const bytes=await archive();
  await assert.rejects(()=>extractPluginRepository(bytes,root,validate),/real artifact directory/);
  assert.equal(readFileSync(join(outside,'keep.txt'),'utf8'),'keep');
 } finally {if(!realpathSync(root).startsWith(realpathSync(tmpdir())+sep))throw new Error('Invalid test cleanup');rmSync(root,{recursive:true});}
});
for(const [name,index] of [['invalid JSON','{broken'],['wrong version',JSON.stringify({plugins:[{...plugin,version:'wrong'}]})]])
test(`retains the previous extraction when the staged index has ${name}`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'readest-plugin-extract-'));
 try {
  const previous=join(root,'.v2-artifacts/repository/plugins');mkdirSync(previous,{recursive:true});
  writeFileSync(join(previous,'venera-0.2.0-x1.readest-plugin'),'old');
  const bytes=await archive([],index);
  await assert.rejects(()=>extractPluginRepository(bytes,root,validate));
  assert.equal(readFileSync(join(previous,'venera-0.2.0-x1.readest-plugin'),'utf8'),'old');
 } finally {if(!realpathSync(root).startsWith(realpathSync(tmpdir())+sep))throw new Error('Invalid test cleanup');rmSync(root,{recursive:true});}
});
