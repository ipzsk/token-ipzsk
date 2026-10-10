import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSkillCalls } from '../src/skill-attribution.mjs';
const call=name=>({name,content_sha256:'a'.repeat(64)});
const registry=(name,plugin)=>({skill_ref:name,plugin_id:plugin,plugin_enabled:true,allowed_models:['model'],content_sha256:'a'.repeat(64),enabled:true});
const db=rows=>({query:async()=>({rows})});
test('the server resolves every marker and retains ambiguous multi-plugin calls',async()=>{
 const calls=[call('one'),call('two')];
 const result=await resolveSkillCalls(db([registry('one','p1'),registry('two','p2')]),JSON.stringify(calls),'model');
 assert.equal(result.pluginId,null);assert.equal(result.state,'ambiguous');
 assert.deepEqual(result.calls.map(row=>row.plugin_id),['p1','p2']);
 const one=await resolveSkillCalls(db([registry('one','p1')]),JSON.stringify([calls[0]]),'model');
 assert.equal(one.pluginId,'p1');assert.equal(one.state,'attributed');
 const local=await resolveSkillCalls(db([]),JSON.stringify([call('local-skill')]),'model');
 assert.equal(local.pluginId,null);assert.equal(local.state,'unregistered');
});
test('client markers cannot set recipient, price, cost or share; invalid/revoked versions fail closed',async()=>{
 for(const value of ['bad','{}',JSON.stringify([call('one'),call('one')]),JSON.stringify(Array(33).fill(call('one'))),...['plugin_id','cost_cny','share_bps','developer_user_id'].map(key=>JSON.stringify([{...call('one'),[key]:1}]))]){
  await assert.rejects(resolveSkillCalls(db([]),value,'model'),{code:'invalid_skill_calls'});
 }
 for(const patch of [{enabled:false},{plugin_enabled:false},{content_sha256:'b'.repeat(64)}]){
  await assert.rejects(resolveSkillCalls(db([{...registry('one','p1'),...patch}]),JSON.stringify([call('one')]),'model'),{code:'skill_version_denied'});
 }
 await assert.rejects(resolveSkillCalls(db([registry('one','p1')]),JSON.stringify([call('one')]),'other-model'),{code:'plugin_model_denied'});
 await assert.rejects(resolveSkillCalls(db([registry('one','p1')]),JSON.stringify([call('one')]),'model','p2'),{code:'skill_plugin_conflict'});
});
