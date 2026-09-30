// SPDX-License-Identifier: MPL-2.0
/** Design adapts its authored boxes into the generic text-wrap placement contract. */
import type { TextWrapContextV1,TextWrapPlacementV1,TextWrapObjectV1 } from '@lolly-tools/core';
import type { DesignTextBox } from './text-design.ts';
export function designTextWrap(boxes:readonly DesignTextBox[]):TextWrapContextV1|undefined{
  const enabled=(value:unknown)=>[true,'true',1,'1'].includes(value as string|number|boolean);
  const objects=boxes.filter(box=>box.textWrap&&!enabled(box.hidden));if(!objects.length)return undefined;
  const pose=(box:DesignTextBox):TextWrapPlacementV1=>({id:String(box.id),scope:String(box.frame??''),x:Math.round(Number(box.x)||0),y:Math.round(Number(box.y)||0),width:Math.max(1,Math.round(Number(box.w)||1)),height:Math.max(1,Math.round(Number(box.h)||1)),rotation:Math.round((Number(box.rot)||0)*10)/10,flipX:enabled(box.flipH),flipY:enabled(box.flipV)});
  return {placements:boxes.filter(box=>box.textStory).map(pose),objects:objects.map(box=>{
    if(typeof box.textWrap!=='string'||box.textWrap.length>4096)throw new Error('The text wrap settings are invalid.');const settings=JSON.parse(box.textWrap) as Pick<TextWrapObjectV1,'mode'|'offset'>;
    if(Number(box.rx)||Number(box.ry))throw new Error('Text wrap supports flat objects. Remove the perspective tilt before wrapping text.');
    if(settings.mode==='contour'&&(box.pathPaint||box.clip||box.kind==='image'||!['rect','ellipse','circle','pill',undefined,''].includes(box.shape as string|undefined)&&box.kind!=='path'))throw new Error('This object needs bounding-box text wrap. Its visible contour is not supported.');
    return {...pose(box),mode:settings.mode,offset:settings.offset,geometry:{kind:box.kind==='path'?'path':['ellipse','circle'].includes(String(box.shape))?'ellipse':'rect',radius:box.shape==='pill'?100000:Number(box.radius)||0,...(box.kind==='path'?{path:String(box.path??'')}:{})}};
  })};
}
