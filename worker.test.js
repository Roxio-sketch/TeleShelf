import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {parseLine,validUrl,inlineResult} from './worker.js';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';

function database() {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  return {sqlite,prepare(sql){let values=[];return {bind(...args){values=args;return this},async run(){const r=sqlite.prepare(sql).run(...values);return {meta:{changes:Number(r.changes)}}},async first(){return sqlite.prepare(sql).get(...values)||null},async all(){return {results:sqlite.prepare(sql).all(...values)}}}},async batch(statements){return Promise.all(statements.map(s=>s.run()))}};
}
async function update(env,body){return worker.fetch(new Request('https://bot/endpoint',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'secret'},body:JSON.stringify(body)}),env);}
test('Chinese corpus format and empty content',()=>{
  assert.deepEqual(parseLine('{分类-1}你好！'),{category:'分类-1',content:'你好！'});
  assert.equal(parseLine('{分类}'),null);
  assert.equal(parseLine('plain text'),null);
});
test('media URLs require HTTPS without credentials',()=>{
  assert.equal(validUrl('https://example.com/audio.mp3'),true);
  assert.equal(validUrl('http://example.com/a'),false);
  assert.equal(validUrl('https://user:password@example.com/a'),false);
});
test('inline cached media and hosted photo use Telegram result schemas',()=>{
  assert.equal(inlineResult({id:1,type:'audio',content:'音频',file_id:'file'},'https://bot').audio_file_id,'file');
  const photo=inlineResult({id:2,type:'photo',content:'图片',media_key:'abc.jpg'},'https://bot');
  assert.equal(photo.photo_url,'https://bot/media/abc.jpg');assert.equal(photo.thumbnail_url,photo.photo_url);
  assert.deepEqual(inlineResult({id:3,type:'text',category:'分类',content:'内容'},'https://bot').input_message_content,{message_text:'内容'});
});
test('webhook authentication prevents unauthenticated database access',async()=>{
  const response=await worker.fetch(new Request('https://bot/endpoint',{method:'POST',body:'{}'}),{WEBHOOK_SECRET:'secret'});
  assert.equal(response.status,403);
});
test('duplicate update does not resend messages',async()=>{
  let calls=0;const env={WEBHOOK_SECRET:'secret',BOT_NAME:'test',DB:{prepare(){calls++;return {bind(){return this},async run(){return {meta:{changes:0}}}}}}};
  const response=await worker.fetch(new Request('https://bot/endpoint',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'secret'},body:JSON.stringify({update_id:1,message:{}})}),env);
  assert.equal(response.status,200);assert.equal(calls,1);
});
test('inline search uses real SQL and isolates bot data',async()=>{
  const db=database(),original=globalThis.fetch,calls=[];
  db.sqlite.exec("INSERT INTO entries(bot,category,content) VALUES('a','测试','你好'),('b','测试','你好别的机器人');");
  globalThis.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return Response.json({ok:true,result:true})};
  try {const r=await update({DB:db,BOT_NAME:'a',WEBHOOK_SECRET:'secret',BOT_TOKEN:'test'},{update_id:123,inline_query:{id:'q',query:'你好',offset:''}});assert.equal(r.status,200);assert.equal(calls[0].results.length,1);assert.equal(calls[0].results[0].input_message_content.message_text,'你好');}
  finally{globalThis.fetch=original;db.sqlite.close();}
});
test('management is authorized, persistent and recoverable',async()=>{
  const db=database(),original=globalThis.fetch;globalThis.fetch=async()=>Response.json({ok:true,result:true});
  const env={DB:db,BOT_NAME:'a',WEBHOOK_SECRET:'secret',BOT_TOKEN:'test',ADMIN_IDS:'[1]',ADMIN_CHAT_ID:'-1'};
  try{
    await update(env,{update_id:1,message:{chat:{id:10},from:{id:2},text:'/update_file {类}内容'}});assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM entries').get().n,0);
    await update(env,{update_id:2,message:{chat:{id:10},from:{id:1},text:'/update_file {类}内容'}});assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM entries').get().n,1);
    await update(env,{update_id:3,message:{chat:{id:10},from:{id:1},text:'/delete 1'}});assert.equal(db.sqlite.prepare('SELECT deleted FROM entries').get().deleted,1);
    await update(env,{update_id:4,message:{chat:{id:10},from:{id:1},text:'/restore 1'}});assert.equal(db.sqlite.prepare('SELECT deleted FROM entries').get().deleted,0);
    await update(env,{update_id:5,message:{chat:{id:10},from:{id:1},text:'/batch_add'}});assert.ok(db.sqlite.prepare('SELECT expires FROM sessions').get().expires>Date.now());
    await update(env,{update_id:6,message:{chat:{id:10},from:{id:1},text:'{类}批量内容\n{类}批量内容'}});assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM entries').get().n,2);
  }finally{globalThis.fetch=original;db.sqlite.close();}
});
test('inline deliveries and bot messages never become uploaded media',async()=>{
  const db=database(),original=globalThis.fetch;let sends=0;globalThis.fetch=async()=>{sends++;return Response.json({ok:true,result:true})};
  const env={DB:db,BOT_NAME:'a',WEBHOOK_SECRET:'secret',BOT_TOKEN:'test',ADMIN_IDS:'[1]',ADMIN_CHAT_ID:'-1'};
  try{
    await update(env,{update_id:10,message:{chat:{id:-1},from:{id:1},via_bot:{id:99,is_bot:true},photo:[{file_id:'photo'}],caption:'耳机'}});
    await update(env,{update_id:11,message:{chat:{id:-1},from:{id:99,is_bot:true},audio:{file_id:'audio',title:'美丽之物'}}});
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM entries').get().n,0);assert.equal(sends,0);
    await update(env,{update_id:12,message:{chat:{id:10},from:{id:1},photo:[{file_id:'upload'}],caption:'{图片}新上传'}});
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM entries').get().n,1);assert.equal(sends,1);
  }finally{globalThis.fetch=original;db.sqlite.close();}
});
