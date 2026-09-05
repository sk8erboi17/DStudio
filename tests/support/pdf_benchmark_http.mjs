// Explicit total timeout for slow, non-streaming local PDF indexing requests.
// Node fetch's independent default headers timeout can fire before AbortSignal.
import http from 'node:http';

export async function postJson(url,body,headers,timeoutMs=1_800_000) {
  const started=performance.now(),payload=JSON.stringify(body);
  try {
    const response=await new Promise((resolve,reject)=>{
      const req=http.request(url,{method:'POST',agent:false,headers:{...headers,
        'content-length':Buffer.byteLength(payload)}},res=>{
        const chunks=[];
        res.on('data',chunk=>chunks.push(chunk));
        res.on('error',reject);
        res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString('utf8')}));
      });
      const timer=setTimeout(()=>{
        const error=new Error(`PDF benchmark request exceeded ${timeoutMs} ms`);
        error.code='DSTUDIO_BENCH_TIMEOUT';req.destroy(error);
      },timeoutMs);
      req.on('error',reject);
      req.on('close',()=>clearTimeout(timer));
      req.end(payload);
    });
    let result;
    try{result=JSON.parse(response.text);}catch{throw Error(`invalid JSON (${response.status}): ${response.text.slice(0,200)}`);}
    return {ms:performance.now()-started,httpStatus:response.status,result};
  }catch(error){error.elapsedMs=performance.now()-started;throw error;}
}
