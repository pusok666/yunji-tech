export type ExpiredResponseReplay = {replayed:true;responseExpired:true;committedRevision:number};
export const REPLAY_COMPLETED_MESSAGE = '该操作此前已完成，已刷新当前数据';

export function mutationMessage(result:ExpiredResponseReplay|undefined, normalMessage:string):string {
  return result?.replayed&&result.responseExpired?REPLAY_COMPLETED_MESSAGE:normalMessage;
}
