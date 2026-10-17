// Isolated UI fixtures: no database, model requests, imports, or production credentials.
// Start: node .qa/ui-fixture-server.mjs   (localhost:8790)
import http from 'node:http';
import fs from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const title = 'The art of staying curious: a conversation about learning, technology and the ideas that shape our everyday lives';
const sentences = [
  'Stay curious and keep reading every day.',
  'Understanding a new idea starts with a thoughtful question.',
  'Good conversations help us discover a different perspective.',
  'A little practice makes unfamiliar words feel like old friends.',
  'We can always learn something from the world around us.',
  'Listen closely and give yourself time to understand.',
  'Every story offers a chance to see things differently.',
  'The most important thing is to keep exploring.',
];
const segments = sentences.map((text,idx)=>({idx,text,start_sec:idx*6,end_sec:idx*6+5}));
const episodes = [
  {id:'uifixture01',title,show_title:'The Curious Reader · UI 测试内容',state:'ready',duration_sec:60,seg_count:8},
  {id:'uifixture02',title:'A second episode for navigation checks',show_title:'UI 测试内容',state:'ready',duration_sec:60,seg_count:8},
  {id:'uifixture03',title:'正在准备的新内容',show_title:'UI 测试内容',state:'failed',error:'示例：链接暂时无法访问'},
];
const word = {id:1,lemma:'curious',surface:'curious',sentence:sentences[0],seg_idx:0,episode_id:episodes[0].id,count:1,created_at:'2026-10-17',explanation_key:'fixture'};
const explanation = {cached:true,payload:{sense_here:'好奇的；愿意了解新事物的。',pos:'形容词',ipa:'/ˈkjʊəriəs/',roots:{available:false},related:{words:['curiosity — 好奇心'],sentences:['Stay curious and keep reading.']}}};
http.createServer(async (req,res)=>{
  try{
    const pathname=new URL(req.url,'http://localhost').pathname;
    const send=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data))};
    if(pathname==='/'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      return res.end(await fs.readFile(new URL('web/index.html',root)));
    }
    if(pathname==='/icon.svg'||pathname==='/manifest.webmanifest'){
      res.writeHead(200,{'Content-Type':pathname.endsWith('svg')?'image/svg+xml':'application/manifest+json'});
      return res.end(await fs.readFile(new URL('web'+pathname,root)));
    }
    if(pathname.endsWith('/audio')){
      const data=await fs.readFile(new URL('.qa/fixtures/short.mp3',root));
      const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');
      if(range){
        const start=Number(range[1]),end=Math.min(Number(range[2]||data.length-1),data.length-1);
        if(start>end){res.writeHead(416,{'Content-Range':`bytes */${data.length}`});return res.end()}
        res.writeHead(206,{'Content-Type':'audio/mpeg','Accept-Ranges':'bytes','Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${data.length}`});
        return res.end(data.subarray(start,end+1));
      }
      res.writeHead(200,{'Content-Type':'audio/mpeg','Accept-Ranges':'bytes','Content-Length':data.length});return res.end(data);
    }
    if(pathname==='/health') return send({ok:true,running:true,worker_healthy:true});
    if(pathname==='/episodes') return send(episodes);
    if(pathname==='/vocab/grouped') return send({total:1,raw:1,groups:[{episode_id:episodes[0].id,episode_title:title,items:[word]}]});
    if(pathname==='/vocab') return send([word]);
    if(pathname.includes('/explain')||pathname==='/define') return send(explanation);
    const episode=episodes.find(ep=>pathname==='/episodes/'+ep.id);
    if(episode) return send({episode,segments,paragraphs:[{start_seg_idx:0,end_seg_idx:3},{start_seg_idx:4,end_seg_idx:7}],vocab_lemmas:['curious'],translations:segments.map(s=>({seg_idx:s.idx,text:'保持好奇，继续探索。'}))});
    if(pathname==='/import') return send({id:episodes[0].id,title:'UI 测试导入'});
    send({detail:'Fixture route not found'},404);
  }catch(err){res.writeHead(500);res.end(String(err))}
}).listen(8790,'127.0.0.1',()=>console.log('UI fixture server: http://127.0.0.1:8790'));
