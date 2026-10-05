import nodemailer from 'nodemailer';

export interface MailMessage { to: string; subject: string; text: string; html?: string }
export interface Mailer { send: (message: MailMessage, signal?: AbortSignal) => Promise<void> }
export interface SmtpConfig { host: string; port: number; user: string; password: string; from: string; secure?: boolean }
export function validateSmtp(config: SmtpConfig): void {
  if(!config || typeof config.host!=='string' || !config.host.trim() || /[\s/:]/.test(config.host) || !Number.isInteger(config.port) || config.port<1 || config.port>65535 || typeof config.user!=='string' || !config.user || typeof config.password!=='string' || !config.password || typeof config.from!=='string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(config.from) || /[\r\n]/.test(config.user+config.from)) throw new Error('SMTP 配置不完整或格式无效');
  if(config.port===465 && config.secure===false) throw new Error('SMTP 465 必须使用 TLS');
}
export function createSmtpMailer(config: SmtpConfig): Mailer {
  validateSmtp(config);
  return { async send(message,signal) {
    if(signal?.aborted) throw new Error('MAIL_TIMEOUT');
    const secure=config.secure??config.port===465;
    const transport=nodemailer.createTransport({host:config.host,port:config.port,secure,requireTLS:!secure,auth:{user:config.user,pass:config.password},tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},connectionTimeout:5000,greetingTimeout:5000,socketTimeout:10000,dnsTimeout:5000,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true});
    const close=()=>transport.close(); signal?.addEventListener('abort',close,{once:true});
    try { const result=await transport.sendMail({from:config.from,to:message.to,subject:message.subject,text:message.text,html:message.html}); if(!result.accepted?.length || result.rejected?.length) throw new Error('MAIL_REJECTED'); }
    finally { signal?.removeEventListener('abort',close);transport.close(); }
  } };
}

// Deliberately bounded and non-durable: queued work is retried by the user after
// a process restart. No plaintext messages or recovery tokens are persisted.
export class MailQueue {
  private tasks: Array<()=>Promise<void>>=[];
  private active=0;
  private waiters: Array<()=>void>=[];
  private limit: number;
  private concurrency: number;
  private closed=false;
  constructor(options: { max?: number; concurrency?: number }={}) { this.limit=options.max??100;this.concurrency=options.concurrency??2; }
  enqueue(task: ()=>Promise<void>): boolean {
    if(this.closed || this.tasks.length+this.active>=this.limit) return false;
    this.tasks.push(task);this.pump();return true;
  }
  private pump() {
    while(this.active<this.concurrency && this.tasks.length) {
      const task=this.tasks.shift()!;this.active++;
      // Errors are handled without logging message content or SMTP credentials.
      void Promise.resolve().then(task).catch(()=>undefined).finally(()=>{this.active--;this.pump();if(!this.active&&!this.tasks.length) this.waiters.splice(0).forEach(done=>done());});
    }
  }
  async drain(): Promise<void> { if(!this.active&&!this.tasks.length)return; await new Promise<void>(resolve=>this.waiters.push(resolve)); }
  async close(): Promise<void> { this.closed=true;await this.drain(); }
  get size() { return this.active+this.tasks.length; }
}
export async function deliver(mailer: Mailer, message: MailMessage, timeoutMs: number): Promise<void> {
  const controller=new AbortController();let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([mailer.send(message,controller.signal),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('MAIL_TIMEOUT'));},timeoutMs);})]);
  } finally { if(timer)clearTimeout(timer); }
}
