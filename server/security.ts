import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export const constantEqual = (a: string, b: string) => { const left=Buffer.from(a),right=Buffer.from(b); return left.length===right.length && timingSafeEqual(left,right); };
async function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((ok,reject)=>scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024},(error,key)=>error?reject(error):ok(key)));
}
export async function hashPassword(password: string): Promise<string> { const salt=randomBytes(16).toString('hex');return `scrypt:${salt}:${(await derive(password,salt)).toString('hex')}`; }
export async function checkPassword(password: string, encoded: string): Promise<boolean> {
  const [,salt,expected]=encoded.split(':'); const key=await derive(password,salt||'00000000000000000000000000000000');
  return !!expected && constantEqual(key.toString('hex'),expected);
}
