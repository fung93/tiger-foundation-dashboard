/* Local HTTP checks for the actual portable preview server. No chain or external network. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {createPreviewServer} from './dev-server.mjs';

const temporary=mkdtempSync(join(tmpdir(),'tiger-dev-server-'));
const root=join(temporary,'repo'),outside=join(temporary,'outside');
mkdirSync(join(root,'api'),{recursive:true});mkdirSync(join(root,'.git'));mkdirSync(outside);
writeFileSync(join(root,'index.html'),'<h1>Tiger Foundation preview</h1>');
writeFileSync(join(root,'module.mjs'),'export const value=42;');
writeFileSync(join(root,'style.css'),'body{color:white}');
writeFileSync(join(root,'data.json'),' {"saved":42} ');
writeFileSync(join(root,'sw.js'),'PRODUCTION CACHE MUST NOT BE SERVED');
writeFileSync(join(root,'.git','config'),'PRIVATE GIT CONTENT');
writeFileSync(join(root,'.env'),'PRIVATE ENV CONTENT');
writeFileSync(join(outside,'secret.txt'),'OUTSIDE WORKSPACE');
symlinkSync(outside,join(root,'escape'),'junction');
symlinkSync(join(root,'.git'),join(root,'hidden-alias'),'junction');
writeFileSync(join(root,'api','lpbook.mjs'),`
export default async function(req,res){
  const host=req.headers['x-forwarded-host'];
  const proto=req.headers['x-forwarded-proto'];
  const data=await fetch(proto+'://'+host+'/data.json').then(r=>r.json());
  res.setHeader('cache-control','s-maxage=10, stale-while-revalidate=5');
  res.status(201).json({host,proto,hostHeader:req.headers.host,query:req.query,data});
}
`);
writeFileSync(join(root,'api','vault.mjs'),'export default async function(){throw new Error("controlled API failure");}');
writeFileSync(join(root,'api','_core.mjs'),'PRIVATE SHARED API SOURCE');
let checks=0,server;
function eq(actual,expected,note){assert.deepEqual(actual,expected,note);checks++;}
function http(path,{method='GET',headers={}}={}){
  return new Promise((success,failure)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path,method,headers},res=>{
      const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>success({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts).toString()}));
    });req.on('error',failure);req.end();
  });
}
try{
  server=await createPreviewServer({root,port:0});
  let r=await http('/');eq(r.status,200,'The root serves the dashboard');eq(r.body,'<h1>Tiger Foundation preview</h1>','The repo root index is used');
  eq(r.headers['cache-control'],'no-store','Static pages do not cache');
  eq(r.headers['x-content-type-options'],'nosniff','Browser type sniffing is disabled');
  r=await http('/index.html');eq(r.status,200,'The explicit index works');
  r=await http('/module.mjs');eq(r.headers['content-type'],'text/javascript; charset=utf-8','Browser modules receive a JavaScript MIME type');
  r=await http('/style.css');eq(r.headers['content-type'],'text/css; charset=utf-8','Styles receive a CSS MIME type');
  r=await http('/data.json?cache-bust=1');eq(JSON.parse(r.body).saved,42,'Static JSON reads ignore query strings');
  r=await http('/module.mjs',{method:'HEAD'});eq(r.status,200,'HEAD serves static metadata');eq(r.body,'','HEAD returns no body');eq(Number(r.headers['content-length']),22,'HEAD preserves file length');
  r=await http('/missing.json');eq(r.status,404,'Missing files fail clearly');
  r=await http('/%ZZ');eq(r.status,400,'Malformed escapes fail safely');
  for(const path of ['/.git/config','/.env','/%2e%2e/outside/secret.txt','/api/%2e%2e/data.json','/escape/secret.txt','/hidden-alias/config']){
    r=await http(path);eq(r.status,403,'Private or out-of-root paths are denied: '+path);
    eq(/PRIVATE|OUTSIDE WORKSPACE/.test(r.body),false,'Denied responses do not reveal file contents');
  }
  for(const path of ['/api/_core','/api/_core.mjs','/api/lpbook.mjs','/api/unknown']){
    r=await http(path);eq(r.status,404,'Only public handler routes are callable: '+path);
  }
  r=await http('/API/_core.mjs');eq([403,404].includes(r.status),true,'Case variants never expose raw API source on Windows');
  r=await http('/_save?name=written.txt',{method:'POST'});eq(r.status,405,'Asset-writing requests are unsupported');eq(existsSync(join(root,'written.txt')),false,'The preview does not write assets');
  r=await http('/sw.js');eq(r.status,200,'Development service worker is served');
  eq(r.body.includes('PRODUCTION CACHE'),false,'The production worker is never served in development');
  eq(r.body.includes('registration.unregister()'),true,'The worker retires itself');
  eq(r.body.includes("key.startsWith('tiger-')"),true,'Only Tiger caches are selected for removal');
  eq(r.body.includes("addEventListener('fetch'"),false,'The development worker never intercepts page fetches');
  r=await http('/api/lpbook?pos=491843',{headers:{host:'untrusted.example','x-forwarded-host':'untrusted.example','x-forwarded-proto':'https'}});
  eq(r.status,201,'Existing API status shims work');const body=JSON.parse(r.body);
  eq(body.host,'127.0.0.1:'+server.address().port,'API self-fetches use internal loopback');
  eq(body.hostHeader,body.host,'Untrusted Host is also replaced');eq(body.proto,'http','API self-fetches do not depend on external TLS/private port access');
  eq(body.data.saved,42,'The actual API can read its saved file through the preview server');eq(body.query.pos,'491843','API queries are available');
  eq(r.headers['cache-control'],'s-maxage=10, stale-while-revalidate=5','API cache headers remain under the handler control');
  r=await http('/api/lpbook',{method:'HEAD'});eq(r.status,201,'HEAD can use the same API route');eq(r.body,'','HEAD API responses have no body');
  r=await http('/api/vault');eq(r.status,502,'A failed API does not crash the server');eq(JSON.parse(r.body).error,'controlled API failure','API failures remain reviewable');
  r=await http('/api/morpho');eq(r.status,404,'A missing allowed handler is not imported from another location');
  r=await http('/');eq(r.status,200,'The server continues after failures');
  await assert.rejects(()=>createPreviewServer({root,host:'untrusted.example',port:0}));checks++;
  await assert.rejects(()=>createPreviewServer({root,port:-1}));checks++;
  console.log('Portable preview server: '+checks+' assertions passed.');
}finally{
  if(server){server.closeAllConnections();await new Promise(success=>server.close(success));}
  if(dirname(resolve(temporary))===resolve(tmpdir())&&basename(temporary).startsWith('tiger-dev-server-'))rmSync(temporary,{recursive:true,force:true});
}
