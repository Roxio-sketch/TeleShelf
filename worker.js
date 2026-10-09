const HELP = `在任意聊天输入 @机器人 关键词，搜索文字、图片、音频。
/search 关键词 — 当前聊天发送搜索结果
/photo 关键词 /audio 关键词 — 搜索媒体
管理员功能：
/update_file {分类}内容
/batch_add — 批量添加，或上传.txt
/add_photo {分类}标题 https://图片直链
/add_audio {分类}标题 https://音频直链
直接发送图片、音频、语音，说明填写 {分类}标题，即可收录。
/list 关键词 — 查看ID
/delete ID或关键词 /delete_category 分类
/restore ID — 恢复隐藏条目
/export — 导出文字
/refresh /organize — 查看数据库统计
/password 密码 — 获取24小时权限
/add_user ID /remove_user ID /list_temp_users /remove_all_temp_users`;
export function parseLine(line) {
  const m=line.trim().match(/^\{([^}]+)\}\s*(.+)$/u);
  return m ? {category:m[1].trim(),content:m[2].trim()} : null;
}
export function validUrl(value) {
  try {const u=new URL(value);return u.protocol==='https:' && !u.username && !u.password;} catch {return false;}
}
export function inlineResult(row,base) {
  if(row.type==='text') return {type:'article',id:String(row.id),title:row.content,description:row.category,input_message_content:{message_text:row.content}};
  const result={type:row.type,id:String(row.id),title:row.content.slice(0,256),caption:row.content.slice(0,1024)};
  if(row.file_id) result[`${row.type}_file_id`]=row.file_id;
  else {result[`${row.type}_url`]=row.url || `${base}/media/${row.media_key}`;if(row.type==='photo')result.thumbnail_url=result.photo_url;}
  return result;
}
async function api(env,method,body) {
  const response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const data=await response.json();if(!data.ok)throw new Error(`Telegram ${method} failed`);return data.result;
}
const reply=(e,c,t)=>api(e,'sendMessage',{chat_id:c,text:t.slice(0,4000)});
const owner=(e,u)=>JSON.parse(e.ADMIN_IDS || '[]').includes(u);
async function authorized(e,u,c) {
  return owner(e,u) || Number(e.ADMIN_CHAT_ID)===c || !!await e.DB.prepare('SELECT user_id FROM users WHERE bot=? AND user_id=? AND (expires IS NULL OR expires>?)').bind(e.BOT_NAME,u,Date.now()).first();
}
async function search(e,q='',type=null,limit=50,offset=0) {
  const words=q.toLowerCase().trim().split(/\s+/u).filter(Boolean).slice(0,10),clauses=['bot=?','deleted=0'],values=[e.BOT_NAME];
  if(type){clauses.push('type=?');values.push(type);}
  if(words.length){clauses.push('('+words.map(()=>'(instr(lower(category),?)>0 OR instr(lower(content),?)>0)').join(' OR ')+')');words.forEach(w=>values.push(w,w));}
  return (await e.DB.prepare(`SELECT * FROM entries WHERE ${clauses.join(' AND ')} ORDER BY ${words.length?'id':'random()'} LIMIT ? OFFSET ?`).bind(...values,limit,offset).all()).results;
}
async function insert(e,r) {
  return e.DB.prepare('INSERT INTO entries(bot,type,category,content,url,file_id,media_key,mime) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(bot,type,category,content) DO UPDATE SET deleted=0,url=COALESCE(excluded.url,entries.url),file_id=COALESCE(excluded.file_id,entries.file_id)').bind(e.BOT_NAME,r.type || 'text',r.category,r.content,r.url || null,r.file_id || null,r.media_key || null,r.mime || null).run();
}
async function importText(e,text) {
  const parsed=text.split(/\r?\n/u).filter(x=>x.trim()).map(parseLine),unique=[...new Map(parsed.filter(Boolean).map(x=>[JSON.stringify(x),x])).values()];let count=0;
  for(let i=0;i<unique.length;i+=80){const results=await e.DB.batch(unique.slice(i,i+80).map(r=>e.DB.prepare("INSERT INTO entries(bot,type,category,content) VALUES(?,'text',?,?) ON CONFLICT(bot,type,category,content) DO UPDATE SET deleted=0 WHERE entries.deleted=1").bind(e.BOT_NAME,r.category,r.content)));count+=results.reduce((n,r)=>n+(r.meta.changes || 0),0);}
  return `新增或恢复 ${count} 条，重复 ${unique.length-count} 条，无效格式 ${parsed.filter(x=>!x).length} 条。`;
}
async function send(e,c,r,base) {
  if(r.type==='text')return reply(e,c,r.content);
  return api(e,{photo:'sendPhoto',audio:'sendAudio',voice:'sendVoice'}[r.type],{chat_id:c,[r.type]:r.file_id || r.url || `${base}/media/${r.media_key}`,caption:r.content.slice(0,1024)});
}
async function message(e,m,base) {
  // Inline sends and bot replies are deliveries, not administrator uploads.
  if(m.via_bot || m.from?.is_bot)return;
  const c=m.chat.id,u=m.from?.id,t=m.text?.trim() || '',cmd=t.split(/\s/u)[0].split('@')[0],arg=t.includes(' ')?t.slice(t.indexOf(' ')+1).trim():'';
  if(cmd==='/start')return reply(e,c,e.START_TEXT || '欢迎使用语料机器人');
  if(cmd==='/help')return reply(e,c,HELP);
  if(['/search','/photo','/audio'].includes(cmd)){const rows=await search(e,arg,cmd==='/photo'?'photo':cmd==='/audio'?'audio':null,5);if(!rows.length)return reply(e,c,'没有匹配内容。');for(const r of rows)await send(e,c,r,base);return;}
  if(cmd==='/password'){
    if(!e.ADMIN_PASSWORD)return reply(e,c,'未启用密码授权。');
    const key=`password:${e.BOT_NAME}:${u}`,attempts=Number(await e.MEDIA.get(key)||0);if(attempts>=5)return reply(e,c,'尝试过多，请10分钟后重试。');await e.MEDIA.put(key,String(attempts+1),{expirationTtl:600});
    if(arg!==e.ADMIN_PASSWORD)return reply(e,c,'密码错误。');await e.DB.prepare('INSERT OR REPLACE INTO users VALUES(?,?,?)').bind(e.BOT_NAME,u,Date.now()+86400000).run();return reply(e,c,'已获得24小时管理权限。');
  }
  if(!await authorized(e,u,c)){if(cmd.startsWith('/')||m.document||m.photo||m.audio||m.voice)return reply(e,c,'你无权管理语料。');return;}
  if(['/add_user','/remove_user','/list_temp_users','/remove_all_temp_users'].includes(cmd)){
    if(!owner(e,u))return reply(e,c,'仅管理员可以管理授权。');
    if(cmd==='/list_temp_users'){const rows=(await e.DB.prepare('SELECT user_id FROM users WHERE bot=? AND (expires IS NULL OR expires>?)').bind(e.BOT_NAME,Date.now()).all()).results;return reply(e,c,rows.map(r=>r.user_id).join('\n')||'无临时授权用户');}
    if(cmd==='/remove_all_temp_users')await e.DB.prepare('DELETE FROM users WHERE bot=?').bind(e.BOT_NAME).run();
    else{const id=Number(arg);if(!Number.isSafeInteger(id)||id<=0)return reply(e,c,'请提供有效ID。');if(cmd==='/add_user')await e.DB.prepare('INSERT OR REPLACE INTO users VALUES(?,?,NULL)').bind(e.BOT_NAME,id).run();else await e.DB.prepare('DELETE FROM users WHERE bot=? AND user_id=?').bind(e.BOT_NAME,id).run();}
    return reply(e,c,'授权已更新。');
  }
  if(['/refresh','/organize'].includes(cmd)){const r=await e.DB.prepare('SELECT COUNT(*) AS count FROM entries WHERE bot=? AND deleted=0').bind(e.BOT_NAME).first();return reply(e,c,`直接读取数据库，共 ${r.count} 条，无需刷新。导出自动按分类排序。`);}
  if(cmd==='/batch_add'){await e.DB.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)').bind(e.BOT_NAME,u,c,Date.now()+300000).run();return reply(e,c,'请在5分钟内发送多行 {分类}内容。');}
  if(cmd==='/update_file'){const r=parseLine(arg);if(!r)return reply(e,c,'格式：/update_file {分类}内容');await insert(e,r);return reply(e,c,'已保存文字语料。');}
  if(cmd==='/delete_category'){if(!arg)return reply(e,c,'请指定分类。');const r=await e.DB.prepare('UPDATE entries SET deleted=1 WHERE bot=? AND category=? AND deleted=0').bind(e.BOT_NAME,arg.replace(/^\{|\}$/g,'')).run();return reply(e,c,`已隐藏 ${r.meta.changes} 条，可用 /restore ID 恢复。`);}
  if(cmd==='/delete'||cmd==='/restore'){
    if(!arg)return reply(e,c,'请提供ID或关键词。');const numeric=/^\d+$/.test(arg);if(cmd==='/restore'&&!numeric)return reply(e,c,'恢复需要条目ID。');
    const r=await e.DB.prepare(`UPDATE entries SET deleted=? WHERE bot=? AND ${numeric?'id=?':'instr(content,?)>0'}`).bind(cmd==='/restore'?0:1,e.BOT_NAME,numeric?Number(arg):arg).run();return reply(e,c,`已处理 ${r.meta.changes} 条。`);
  }
  if(cmd==='/list'){const rows=await search(e,arg,null,20);return reply(e,c,rows.map(r=>`${r.id} [${r.type}] {${r.category}}${r.content}`).join('\n')||'无匹配条目');}
  if(cmd==='/export'){
    const rows=(await e.DB.prepare("SELECT category,content FROM entries WHERE bot=? AND type='text' AND deleted=0 ORDER BY category,id").bind(e.BOT_NAME).all()).results,form=new FormData();form.set('chat_id',String(c));form.set('document',new Blob([rows.map(r=>`{${r.category}}${r.content}`).join('\n')],{type:'text/plain;charset=utf-8'}),`${e.BOT_NAME}.txt`);
    const response=await fetch(`https://api.telegram.org/bot${e.BOT_TOKEN}/sendDocument`,{method:'POST',body:form});if(!(await response.json()).ok)throw new Error('Export failed');return;
  }
  if(cmd==='/add_photo'||cmd==='/add_audio'){
    const match=arg.match(/^(.*?)\s+(https:\/\/\S+)$/u),r=match&&parseLine(match[1]);if(!r||!validUrl(match[2]))return reply(e,c,'格式：/add_photo {分类}标题 https://图片直链；音频使用 /add_audio（MP3/M4A）');
    const type=cmd==='/add_photo'?'photo':'audio',sent=await api(e,type==='photo'?'sendPhoto':'sendAudio',{chat_id:c,[type]:match[2],caption:r.content}),file=type==='photo'?sent.photo.at(-1):sent.audio;
    await insert(e,{...r,type,url:match[2],file_id:file.file_id});return reply(e,c,'已验证媒体并收录。');
  }
  const media=m.photo?.at(-1)||m.audio||m.voice;
  if(media){const r=parseLine(m.caption||'')||{category:'媒体',content:m.audio?.title||m.audio?.file_name||`媒体 ${m.message_id}`},type=m.photo?'photo':m.audio?'audio':'voice';await insert(e,{...r,type,file_id:media.file_id});return reply(e,c,'已收录媒体，可通过内联搜索发送。');}
  if(m.document){
    if(!m.document.file_name?.toLowerCase().endsWith('.txt'))return reply(e,c,'文字导入请上传.txt，媒体请以图片、音频或语音发送。');if(m.document.file_size>1024*1024)return reply(e,c,'文字文件上限1MB。');
    const file=await api(e,'getFile',{file_id:m.document.file_id}),response=await fetch(`https://api.telegram.org/file/bot${e.BOT_TOKEN}/${file.file_path}`,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('Download failed');return reply(e,c,await importText(e,await response.text()));
  }
  const session=await e.DB.prepare('SELECT expires FROM sessions WHERE bot=? AND user_id=? AND chat_id=?').bind(e.BOT_NAME,u,c).first();if(session&&session.expires>Date.now()&&t&&!t.startsWith('/')){const result=await importText(e,t);await e.DB.prepare('DELETE FROM sessions WHERE bot=? AND user_id=?').bind(e.BOT_NAME,u).run();return reply(e,c,result);}
}
export default {
  async fetch(request,e){
    const url=new URL(request.url);
    if(url.pathname==='/health'){try{await e.DB.prepare('SELECT 1').first();return Response.json({ok:true,bot:e.BOT_NAME,storage:'D1 + KV',version:2});}catch{return Response.json({ok:false},{status:503});}}
    if(url.pathname.startsWith('/media/')&&request.method==='GET'){
      const key=url.pathname.slice(7);if(!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(key))return new Response('Not found',{status:404});const row=await e.DB.prepare('SELECT mime FROM entries WHERE bot=? AND media_key=? AND deleted=0').bind(e.BOT_NAME,key).first();if(!row)return new Response('Not found',{status:404});const data=await e.MEDIA.get(key,'arrayBuffer');return data?new Response(data,{headers:{'Content-Type':row.mime||'application/octet-stream','Cache-Control':'public,max-age=3600','X-Content-Type-Options':'nosniff'}}):new Response('Not found',{status:404});
    }
    if(url.pathname!=='/endpoint')return new Response('Subtitle Bot. /health',{status:404});if(request.method!=='POST')return new Response('Method not allowed',{status:405});if(request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==e.WEBHOOK_SECRET)return new Response('Unauthorized',{status:403});
    let update;try{update=await request.json();}catch{return new Response('Invalid JSON',{status:400});}if(!Number.isSafeInteger(update.update_id))return new Response('Invalid update',{status:400});
    const claimed=await e.DB.prepare('INSERT OR IGNORE INTO updates VALUES(?,?,?)').bind(e.BOT_NAME,update.update_id,Date.now()).run();if(!claimed.meta.changes)return new Response('OK');
    try{
      if(update.inline_query){const q=update.inline_query,query=q.query.trim(),prefix=query.match(/^(photo|audio|voice|图片|音频|语音)\s+/u),types={photo:'photo',audio:'audio',voice:'voice',图片:'photo',音频:'audio',语音:'voice'},offset=Math.max(0,Number(q.offset)||0),rows=await search(e,prefix?query.slice(prefix[0].length):query,prefix?types[prefix[1]]:null,query?50:10,offset);await api(e,'answerInlineQuery',{inline_query_id:q.id,results:rows.map(r=>inlineResult(r,url.origin)),cache_time:5,is_personal:true,next_offset:query&&rows.length===50?String(offset+50):''});}
      if(update.message)await message(e,update.message,url.origin);
      await e.DB.prepare('DELETE FROM updates WHERE bot=? AND created<?').bind(e.BOT_NAME,Date.now()-7*86400000).run();return new Response('OK');
    }catch{console.error('Update failed',e.BOT_NAME,update.update_id);await e.DB.prepare('DELETE FROM updates WHERE bot=? AND update_id=?').bind(e.BOT_NAME,update.update_id).run();return new Response('Processing failed',{status:500});}
  }
};
