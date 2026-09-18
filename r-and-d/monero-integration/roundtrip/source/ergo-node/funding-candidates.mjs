export function isUnregisteredFundingBox(box){
  const registers=box?.additionalRegisters;
  return registers!==null&&typeof registers==='object'&&!Array.isArray(registers)&&Object.keys(registers).length===0;
}

export function unregisteredFundingBoxes(boxes){
  return boxes.filter(isUnregisteredFundingBox);
}
