import test from 'node:test';
import assert from 'node:assert/strict';
import {createImageCaptcha,unavailableCaptcha} from '../src/captcha.mjs';
const context={email:'fixture@example.com',ip:'192.0.2.1',action:'register'};
test('captcha-canvas renders a PNG without exposing its answer or proof',async()=>{
  const calls=[];const captcha=createImageCaptcha({secret:'test-secret-for-image-captcha-12345',db:{async query(sql,args){calls.push({sql,args});return {rows:[],rowCount:0};}}});
  const result=await captcha.issue(context);
  assert.deepEqual(Object.keys(result).sort(),['expires_in','id','image','length']);
  const png=Buffer.from(result.image.split(',')[1],'base64');
  assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),300);assert.equal(png.readUInt32BE(20),110);
  assert.equal(result.length,5);assert.equal(result.expires_in,120);assert.match(result.id,/^[A-Za-z0-9_-]{43}$/);
  assert.match(calls[1].args[2],/^[a-f0-9]{64}$/);
  await assert.rejects(()=>captcha.issue({...context,email:'bad'}),{code:'invalid_captcha_request'});
  await assert.rejects(()=>unavailableCaptcha().verify({}),{code:'captcha_unavailable'});
});
