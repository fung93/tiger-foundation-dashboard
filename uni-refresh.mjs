/* Bound connection and JSON-body time; a stalled source cannot keep a refresh
   guard locked forever. Browsers and the read-only local tests share this. */
export async function fetchUniJSON(url,{timeoutMs=9000,fetcher=fetch}={}){
 const controller=new AbortController();let timer;
 const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('UNI reading timed out'));},timeoutMs);});
 try{return await Promise.race([(async()=>{const response=await fetcher(url,{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('UNI reading unavailable');return response.json();})(),expired]);}
 finally{clearTimeout(timer);}
}
