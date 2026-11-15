import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, headerBlocks } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('原始包络与消息体分开',()=>{
  const result=inspect(primary);assert.ok(result.headers.some(([name])=>name==='message-id'));
  assert.ok(result.bodyBytes>500);
});
test('折行和重复状态头不相互覆盖',()=>{
  const blocks=headerBlocks('Diagnostic-Code: smtp; 550\r\n unavailable\r\nStatus: 5.1.1\r\nStatus: 5.0.0');
  assert.equal(blocks[0][0][1],'smtp; 550 unavailable');assert.equal(blocks[0].filter(([name])=>name==='status').length,2);
});
test('来源包含不同尝试而非地址全局状态',async()=>{
  const attempts=JSON.parse(await resource('/attempts'));assert.equal(attempts.length,2);
  assert.notEqual(attempts[0].id,attempts[1].id);assert.match((await resource('/delayed')).toString(),/Action: delayed/);
  assert.throws(()=>headerBlocks('not a header'));
});
