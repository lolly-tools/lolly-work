// SPDX-License-Identifier: MPL-2.0
/** Explicit same-artboard obstacles produce bounded line-band exclusions. */
import type { TextFrameV1,TextWrapContextV1,TextWrapPlacementV1,TextWrapObjectV1 } from '@lolly-tools/core';
import { TextSourceError } from './text-source.ts';
import { toCubics } from './geom/spline.ts';
import { decodeAuthoredPathsResult } from './geom/authored-url.ts';
import { pathFromSubPaths } from './geom/path.ts';
import { parseSvgPath } from './svg-path.ts';
import { inverseVectorMatrix,multiplyVectorMatrix } from './vector-paint.ts';
type Point={x:number;y:number};
export interface TextWrapExclusion {id:string;contours:Point[][];offset:TextWrapObjectV1['offset'];bottom:number}
function fail(message:string):never{throw new TextSourceError('text-wrap',message);}
function pose(item:TextWrapPlacementV1){
  if(!item||typeof item.id!=='string'||typeof item.scope!=='string'||item.id.length>128||item.scope.length>128||![item.x,item.y,item.width,item.height,item.rotation].every(value=>Number.isFinite(value)&&Math.abs(value)<=1000000)||item.width<=0||item.height<=0)fail('A text wrap placement is invalid.');
  const a=item.rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a),x=item.flipX?-1:1,y=item.flipY?-1:1;
  return [c*x,s*x,-s*y,c*y,item.x+item.width/2-c*x*item.width/2+s*y*item.height/2,item.y+item.height/2-s*x*item.width/2-c*y*item.height/2] as [number,number,number,number,number,number];
}
function outline(item:TextWrapObjectV1):Point[][]{
  const {width:w,height:h}=item,g=item.geometry;
  if(item.mode==='box'||g.kind==='rect'&&!g.radius)return [[{x:0,y:0},{x:w,y:0},{x:w,y:h},{x:0,y:h}]];
  let contours: ReturnType<typeof pathFromSubPaths>;
  if(g.kind==='path'){
    if(typeof g.path!=='string'||g.path.length>1024*1024)fail('This contour is missing or exceeds the text wrap limit.');
    const parsed=decodeAuthoredPathsResult(g.path!);if(typeof parsed==='string')fail('This contour cannot be used for text wrapping.');
    contours=parsed.map(path=>{if(!path.closed)fail('Close the path before using contour text wrap.');return {closed:true,curves:toCubics({...path,nodes:path.nodes.map(node=>({...node,x:node.x*w,y:node.y*h,...(node.hInX===undefined?{}:{hInX:node.hInX*w}),...(node.hInY===undefined?{}:{hInY:node.hInY*h}),...(node.hOutX===undefined?{}:{hOutX:node.hOutX*w}),...(node.hOutY===undefined?{}:{hOutY:node.hOutY*h})}))})};});
  }else{
    const r=g.kind==='ellipse'?0:Math.max(0,Math.min(w/2,h/2,g.radius??0));
    const d=g.kind==='ellipse'?`M0 ${h/2}A${w/2} ${h/2} 0 1 1 ${w} ${h/2}A${w/2} ${h/2} 0 1 1 0 ${h/2}Z`:`M${r} 0H${w-r}Q${w} 0 ${w} ${r}V${h-r}Q${w} ${h} ${w-r} ${h}H${r}Q0 ${h} 0 ${h-r}V${r}Q0 0 ${r} 0Z`;
    contours=pathFromSubPaths(parseSvgPath(d));
  }
  let count=0;
  return contours.map(contour=>{const points:Point[]=[];
    function segment(a:Point,b:Point,c:Point,d:Point,depth=0){
      if(++count>8192)fail('This contour is too detailed for text wrapping. Use bounding-box wrap.');
      const dx=d.x-a.x,dy=d.y-a.y,length=Math.hypot(dx,dy),distance=(p:Point)=>{const t=length?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(length*length))):0;return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);};
      if(Math.max(distance(b),distance(c))<=.125){if(!points.length)points.push(a);points.push(d);return;}
      if(depth>=16)fail('This contour cannot be resolved at the text wrap tolerance. Use bounding-box wrap.');
      const mid=(a:Point,b:Point)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2}),ab=mid(a,b),bc=mid(b,c),cd=mid(c,d),abc=mid(ab,bc),bcd=mid(bc,cd),m=mid(abc,bcd);segment(a,ab,abc,m,depth+1);segment(m,bcd,cd,d,depth+1);
    }
    for(const curve of contour.curves)segment({x:curve[0],y:curve[1]},{x:curve[2],y:curve[3]},{x:curve[4],y:curve[5]},{x:curve[6],y:curve[7]});return points;
  });
}
export function prepareTextWrap(context:TextWrapContextV1|undefined,frames:TextFrameV1[]):Map<string,TextWrapExclusion[]>{
  const result=new Map<string,TextWrapExclusion[]>();if(!context)return result;
  if(!Array.isArray(context.placements)||!Array.isArray(context.objects)||context.placements.length>512||context.objects.length>256)fail('The document exceeds the supported text wrap object count.');
  if(new Set(context.placements.map(item=>item.id)).size!==context.placements.length||new Set(context.objects.map(item=>item.id)).size!==context.objects.length)fail('Text wrap object identities must be unique.');
  let budget=0;
  const objects=context.objects.map(item=>{
    const matrix=pose(item);if(!['box','contour'].includes(item.mode)||!item.geometry||!['rect','ellipse','path'].includes(item.geometry.kind)||!item.offset||!['top','right','bottom','left'].every(key=>Number.isFinite(item.offset[key as keyof typeof item.offset])&&Math.abs(item.offset[key as keyof typeof item.offset])<=1000))fail('A text wrap setting is invalid.');
    const contours=outline(item);budget+=contours.reduce((sum,points)=>sum+points.length,0);if(budget>65536)fail('The document exceeds the supported text wrap geometry count.');return {item,matrix,contours};
  });
  for(const frame of frames){if(frame.honorWrap===false||frame.mode==='path')continue;const placement=context.placements.find(item=>item.id===frame.id);if(!placement)continue;const inverse=inverseVectorMatrix(pose({...placement,width:frame.width,height:frame.height}));
    const exclusions:TextWrapExclusion[]=[];
    for(const object of objects){if(object.item.scope!==placement.scope||object.item.id===frame.id)continue;const matrix=multiplyVectorMatrix(inverse,object.matrix);let contours=object.contours.map(points=>points.map(point=>({x:matrix[0]*point.x+matrix[2]*point.y+matrix[4],y:matrix[1]*point.x+matrix[3]*point.y+matrix[5]})));
      const points=contours.flat();if(!points.length)continue;const x0=Math.min(...points.map(p=>p.x)),x1=Math.max(...points.map(p=>p.x)),y0=Math.min(...points.map(p=>p.y)),y1=Math.max(...points.map(p=>p.y));
      if(object.item.mode==='box')contours=[[{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}]];
      const tolerance=object.item.mode==='contour'?.25:0,offset=Object.fromEntries(Object.entries(object.item.offset).map(([key,value])=>[key,value+tolerance])) as TextWrapObjectV1['offset'];
      if(x1+offset.right<=0||x0-offset.left>=frame.width||y1+offset.bottom<=0||frame.mode==='fixed'&&y0-offset.top>=frame.height)continue;
      if(frame.verticalAlign!=='top')fail('Text frames that wrap around objects need top vertical alignment.');
      exclusions.push({id:object.item.id,contours,offset,bottom:y1+offset.bottom});
    }if(exclusions.length)result.set(frame.id,exclusions);
  }return result;
}
export function textWrapBand(exclusions:TextWrapExclusion[]|undefined,left:number,width:number,y:number,height:number,direction:'ltr'|'rtl'){
  let spaces:Array<[number,number]>=[[left,left+width]],next=Infinity;
  for(const object of exclusions??[]){let low=Infinity,high=-Infinity;const top=y-object.offset.bottom,bottom=y+height+object.offset.top;
    for(const points of object.contours)for(let i=0;i<points.length;i++){const a=points[i]!,b=points[(i+1)%points.length]!;if(Math.max(a.y,b.y)<top||Math.min(a.y,b.y)>bottom)continue;
      const at=(value:number)=>a.x+(b.x-a.x)*(value-a.y)/(b.y-a.y);const values=[...(a.y>=top&&a.y<=bottom?[a.x]:[]),...(b.y>=top&&b.y<=bottom?[b.x]:[])];for(const edge of [top,bottom])if(a.y!==b.y&&edge>=Math.min(a.y,b.y)&&edge<=Math.max(a.y,b.y))values.push(at(edge));for(const x of values){low=Math.min(low,x);high=Math.max(high,x);}}
    if(!Number.isFinite(low))continue;low-=object.offset.left;high+=object.offset.right;if(high<=left||low>=left+width)continue;next=Math.min(next,object.bottom);
    spaces=spaces.flatMap(([a,b])=>high<=a||low>=b?[[a,b] as [number,number]]:[...(low>a?[[a,Math.min(b,low)] as [number,number]]:[]),...(high<b?[[Math.max(a,high),b] as [number,number]]:[])]);
  }
  spaces.sort((a,b)=>(b[1]-b[0])-(a[1]-a[0])||(direction==='ltr'?a[0]-b[0]:b[0]-a[0]));const best=spaces[0];return {left:best?.[0]??left,width:best?best[1]-best[0]:0,next};
}
