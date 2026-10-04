export type FieldConflict = {field:string;baseline:unknown;latest:unknown;mine:unknown};

// Reapply only the fields this editor changed. Other-device changes survive a refresh.
export function mergeEditedFields<T extends object>(baseline:T, latest:T, values:Partial<T>): {value:T;conflicts:FieldConflict[]} {
  const value={...latest};const conflicts:FieldConflict[]=[];
  for(const field of Object.keys(values) as (keyof T)[]) {
    const mine=values[field];
    if(Object.is(mine,baseline[field]))continue;
    if(!Object.is(latest[field],baseline[field])&&!Object.is(latest[field],mine))conflicts.push({field:String(field),baseline:baseline[field],latest:latest[field],mine});
    else value[field]=mine as T[keyof T];
  }
  return {value,conflicts};
}
