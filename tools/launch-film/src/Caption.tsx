import React from 'react';
import { useCurrentFrame } from 'remotion';
import { C, FONT, ramp } from './visuals';
export const Caption: React.FC<{text?:string;dark?:boolean;fontSize?:number;duration?:number}> = ({text='',dark=false,fontSize=64,duration=0}) => {
  const f=useCurrentFrame();
  const width = 1740;
  const measure = [...text].reduce((sum, ch) => sum + (/[^\x00-\xff]/.test(ch) ? 1 : .56), 0);
  const fitted = Math.min(fontSize, width / Math.max(1, measure));
  const inOpacity = ramp(f, 12, 20);
  const outOpacity = duration > 0 ? 1 - ramp(f, duration - 20, 16) : 1;
  return <div style={{position:'absolute',left:0,right:0,bottom:0,minHeight:116,boxSizing:'border-box',padding:'12px 90px',display:'flex',alignItems:'center',background:dark?C.ink:C.paper,fontFamily:FONT,fontSize:fitted,lineHeight:1.18,fontWeight:500,color:dark?C.paper:C.ink,opacity:inOpacity*outOpacity,whiteSpace:'normal',overflowWrap:'break-word'}}>{text}</div>;
};
