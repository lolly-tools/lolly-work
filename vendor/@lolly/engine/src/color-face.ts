// SPDX-License-Identifier: MPL-2.0
/** Select an authored colour face without reducing wide-gamut values to hex. */
import { parseColor, formatColor } from './css-color.ts';
import type { ColorSwatch } from '@lolly-tools/core/host-v1';
export function colorCss(value:unknown):string|null {
  let source=value;
  if(value&&typeof value==='object'){
    const v=value as {colorSpace?:unknown;components?:unknown;alpha?:unknown;hex?:unknown};
    if(Array.isArray(v.components)&&v.components.length===3&&v.components.every(n=>typeof n==='number'&&Number.isFinite(n))){
      const space=typeof v.colorSpace==='string'?v.colorSpace:'srgb',alpha=typeof v.alpha==='number'?v.alpha:1;
      source=['lab','lch','oklab','oklch'].includes(space)?`${space}(${v.components.join(' ')} / ${alpha})`:`color(${space} ${v.components.join(' ')} / ${alpha})`;
    }else source=v.hex;
  }
  if(typeof source!=='string')return null;const parsed=parseColor(source);return parsed?formatColor(parsed):null;
}
export function swatchFace(swatch:Pick<ColorSwatch,'value'|'faces'|'css'>,target:'srgb'|'display-p3'|'rec2020'='srgb'):string {
  if(target==='srgb')return swatch.value;
  const targets=target==='rec2020'?['rec2020','display-p3']:['display-p3'];
  for(const key of targets){const face=swatch.faces?.[key];if(typeof face==='string'){const css=colorCss(face);if(css)return css;}}
  return swatch.css??swatch.value;
}
/** Collision-free CSS variable for an arbitrary token path. */
export function tokenColorVar(ref:string):string {
  const path=ref.replace(/^\{|\}$/g,'');
  return '--brand-token-'+Array.from(new TextEncoder().encode(path),byte=>byte.toString(16).padStart(2,'0')).join('');
}
