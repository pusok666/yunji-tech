export type AuthLinkKind = 'verify-email' | 'reset-password';
type PendingLink = {kind:AuthLinkKind;token:string};

function captureFragment():PendingLink|null {
  if(typeof window==='undefined')return null;
  const fragment=window.location.hash.slice(1);
  const index=fragment.indexOf('?');
  if(index<0)return null;
  const route=fragment.slice(0,index);
  if(route!=='/verify-email'&&route!=='/reset-password')return null;
  const params=new URLSearchParams(fragment.slice(index+1));
  if(!params.has('token'))return null;
  const values=params.getAll('token');
  const token=values.length===1&&values[0].length<=512?values[0]:'';
  // A fragment is never sent as a request URL. Remove it before mounting a page or making requests.
  window.history.replaceState(window.history.state,'',`${window.location.pathname}${window.location.search}#${route}`);
  return {kind:route.slice(1) as AuthLinkKind,token};
}

// Memory only. Repeated initializers (including React StrictMode) read the same value.
let pending=captureFragment();
export function readAuthLinkToken(kind:AuthLinkKind):string {
  const incoming=captureFragment();if(incoming)pending=incoming;
  return pending?.kind===kind?pending.token:'';
}
export function forgetAuthLinkToken(token:string){if(pending?.token===token)pending=null;}
