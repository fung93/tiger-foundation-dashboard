/* Portable, dependency-free preview for local and cloud workspaces.
   Runs existing read-only API handlers; never runs data jobs or writes files. */
import {createServer} from 'node:http';
import {readFile, realpath, stat} from 'node:fs/promises';
import {dirname, extname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const DEFAULT_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const API_NAMES=new Set(['lpbook','vault','fables','morpho','lp','strategy','kat-trades']);
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8',
  '.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.gif':'image/gif','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2',
  '.txt':'text/plain; charset=utf-8','.md':'text/markdown; charset=utf-8'};

const DEVELOPMENT_WORKER=`// Development only: use the network, never a cached production shell.
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  await Promise.all((await caches.keys()).filter(key=>key.startsWith('tiger-')).map(key=>caches.delete(key)));
  await self.registration.unregister();
})()));
`;

function inside(root,target){
  const path=relative(root,target);
  return path!== '..'&&!path.startsWith('..'+sep)&&!isAbsolute(path);
}
function hidden(path){return path.split(/[\\/]/).some(part=>part.startsWith('.'));}
function send(response,status,body,type='text/plain; charset=utf-8'){
  response.statusCode=status;
  response.setHeader('content-type',type);
  response.setHeader('cache-control','no-store');
  response.end(body);
}

/** Start a preview and return the listening server. Use port:0 for an unused test port. */
export async function createPreviewServer({root=DEFAULT_ROOT,host='127.0.0.1',port=4200}={}){
  if(!['127.0.0.1','0.0.0.0'].includes(host))throw new Error('HOST must be 127.0.0.1 or 0.0.0.0');
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('PORT must be an integer from 0 to 65535');
  const base=await realpath(root);
  const server=createServer(async(request,response)=>{
    response.setHeader('x-content-type-options','nosniff');
    if(request.method!=='GET'&&request.method!=='HEAD'){
      response.setHeader('allow','GET, HEAD');
      send(response,405,'Only GET and HEAD are supported.');return;
    }
    let pathname;
    try{
      const raw=(request.url||'/').split(/[?#]/,1)[0];
      if(!raw.startsWith('/')||raw.startsWith('//'))throw new Error('Invalid request path');
      pathname=decodeURIComponent(raw);
      if(pathname.includes('\0')||pathname.includes('\\'))throw new Error('Invalid request path');
    }catch{
      send(response,400,'Invalid request path.');return;
    }
    if(hidden(pathname)){send(response,403,'This path is not available in preview.');return;}
    try{
      if(pathname.startsWith('/api/')){
        const name=pathname.slice('/api/'.length);
        if(!API_NAMES.has(name)){send(response,404,'API not found.');return;}
        const target=await realpath(resolve(base,'api',name+'.mjs'));
        if(!inside(base,target)||hidden(relative(base,target))){send(response,403,'API is outside the workspace.');return;}
        const handler=(await import(pathToFileURL(target).href)).default;
        if(typeof handler!=='function')throw new Error('API handler is not a function');
        const internalHost='127.0.0.1:'+server.address().port;
        // Handlers fetch their own JSON files through loopback, not a private cloud URL.
        request.headers.host=internalHost;
        request.headers['x-forwarded-host']=internalHost;
        request.headers['x-forwarded-proto']='http';
        request.query=Object.fromEntries(new URL(request.url,'http://'+internalHost).searchParams);
        response.status=function(code){this.statusCode=code;return this;};
        response.json=function(value){this.setHeader('content-type','application/json; charset=utf-8');this.end(JSON.stringify(value));return this;};
        response.setHeader('cache-control','no-store');
        await handler(request,response);
        if(!response.writableEnded)response.end();
        return;
      }
      if(pathname==='/sw.js'){
        response.setHeader('service-worker-allowed','/');
        send(response,200,DEVELOPMENT_WORKER,MIME['.js']);return;
      }
      const target=await realpath(resolve(base,pathname==='/'?'index.html':pathname.slice(1)));
      const rel=relative(base,target);
      if(!inside(base,target)||hidden(rel)||rel.split(sep)[0].toLowerCase()==='api'){
        send(response,403,'This path is outside the preview files.');return;
      }
      const info=await stat(target);
      if(!info.isFile()){send(response,404,'File not found.');return;}
      response.statusCode=200;
      response.setHeader('content-type',MIME[extname(target).toLowerCase()]||'application/octet-stream');
      response.setHeader('content-length',info.size);
      response.setHeader('cache-control','no-store');
      response.end(request.method==='HEAD'?undefined:await readFile(target));
    }catch(error){
      if(response.writableEnded)return;
      if(response.headersSent){response.destroy(error);return;}
      if(error.code==='ENOENT'||error.code==='ENOTDIR')send(response,404,'File not found.');
      else send(response,502,JSON.stringify({error:String(error.message||error)}),'application/json; charset=utf-8');
    }
  });
  await new Promise((success,failure)=>{server.once('error',failure);server.listen(port,host,()=>{server.removeListener('error',failure);success();});});
  return server;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||4200);
  const server=await createPreviewServer({host,port});
  console.log('Tiger Foundation preview: http://127.0.0.1:'+server.address().port);
  console.log('Existing API handlers run locally. No data job is started and no files are written.');
}
