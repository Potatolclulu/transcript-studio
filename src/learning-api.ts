export async function learningApi<T = any>(path:string, body?:unknown, method?:string):Promise<T> {
  const response=await fetch(`/api${path}`,{method:method||(body===undefined?'GET':'POST'),credentials:'same-origin',
    headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json() as {error?:string};
  if(!response.ok)throw new Error(data.error||'The request could not be completed.');
  return data as T;
}
