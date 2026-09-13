/** Checks retained authority on both sides of each asynchronous participant operation. */
export function guardParticipantIO(actors,current){
  if(typeof current!=='function')throw Error('Participant current authority required');
  return actors.map(actor=>Object.freeze({child:actor.child,
    send:async(...args)=>{current();const value=await actor.send(...args);current();return value;},
    next:async(...args)=>{current();const value=await actor.next(...args);current();return value;},
  }));
}
