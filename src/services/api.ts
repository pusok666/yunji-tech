export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`/api${path}`, {...options, credentials:'same-origin', signal:controller.signal, headers:{'Content-Type':'application/json',...options.headers}});
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(body?.error || '服务暂时不可用，请稍后重试。',response.status,body?.code);
    if(body===null)throw new Error('服务器返回格式异常，请稍后重试。');
    return body as T;
  } catch(error) {
    if(error instanceof ApiError)throw error;
    throw new Error(error instanceof Error && error.name==='AbortError'?'请求超时。写入结果尚未确认，请重试同一操作或刷新检查。':'连接服务器失败。请检查网络后重试，未确认保存的内容仍保留在表单中。');
  } finally {clearTimeout(timer);}
}
