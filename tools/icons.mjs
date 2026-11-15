// Androidの図柄を保ち、用途に応じた余白で描画する。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launch} from './lib/browser.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function generateIcons(b,session){
 const normal=fs.readFileSync(path.join(root,'artwork/icon.svg'),'utf8');
 // 元はAndroidの108格子＋周囲18ずつ。小さい印はAndroidと同じ中央72を使う。
 const [x,y,w,h]=normal.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
 const side=w/2,left=x+(w-side)/2,top=y+(h-side)/2,radius=side*2/9;
 const view=`${left} ${top} ${side} ${side}`;
 const clip=`<clipPath id="toolbar"><rect x="${left}" y="${top}" width="${side}" height="${side}" rx="${radius}"/></clipPath>`;
 const compact=normal.replace(/viewBox="[^"]+"/,`viewBox="${view}"`).replace('</defs>',clip+'</defs><g clip-path="url(#toolbar)">').replace('</svg>','</g></svg>');
 fs.writeFileSync(path.join(root,'artwork/toolbar-icon.svg'),compact);
 const bounds=[];
 for(const size of [16,32,48,128,512]){
  const source=size<=48?compact:normal;
  const result=await b.eval(session,`(async()=>{const img=new Image();img.src=${JSON.stringify('data:image/svg+xml;base64,'+Buffer.from(source).toString('base64'))};await img.decode();const c=document.createElement('canvas');c.width=c.height=${size};const g=c.getContext('2d');g.drawImage(img,0,0,${size},${size});const a=g.getImageData(0,0,${size},${size}).data;let x0=${size},y0=${size},x1=-1,y1=-1;for(let y=0;y<${size};y++)for(let x=0;x<${size};x++)if(a[(y*${size}+x)*4+3]>0){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y)}return{png:c.toDataURL('image/png').split(',')[1],bounds:[x0,y0,x1+1,y1+1]}})()`);
  fs.writeFileSync(path.join(root,size===512?'artwork/icon512.png':`extension/icons/icon${size}.png`),Buffer.from(result.png,'base64'));
  bounds.push({size,bounds:result.bounds});
 }
 fs.copyFileSync(path.join(root,'extension/icons/icon128.png'),path.join(root,'store/images/store-icon-128.png'));
 return bounds;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const b=await launch({port:9356});
 try{const page=await b.open('about:blank',100);console.log(JSON.stringify(await generateIcons(b,page.session)))}
 finally{await b.send('Browser.close').catch(()=>{});await b.close()}
}
