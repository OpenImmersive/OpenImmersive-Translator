const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');const p=require('path').join(__dirname,'../');const code=fs.readFileSync(p+'login-url.js','utf8');let count=0;
for(const provider of ['chrome','browser','navigator'])for(const [lang,path] of [['en-US','/'],['zh-CN','/zh'],['zh-SG','/zh'],['zh-TW','/zh-tw'],['zh-HK','/zh-tw'],['zh-Hant','/zh-tw'],['zh_Hant_MO','/zh-tw'],['ja-JP','/ja'],['ko-KR','/ko'],['es-MX','/es'],['pt-BR','/pt'],['pt-PT','/pt'],['fr-FR','/'],['de','/']]){
 const ctx={navigator:{language:lang}};if(provider!=='navigator')ctx[provider]={i18n:{getUILanguage:()=>lang}};vm.createContext(ctx);vm.runInContext(code,ctx);for(const site of ['https://openimmersive.ai','https://openimmersive.ai/']){assert.equal(ctx.OILoginUrl(site),'https://openimmersive.ai'+path+'?login=1');count++;}}
const manifest=JSON.parse(fs.readFileSync(p+'manifest.json'));assert.equal(manifest.version,'1.19.0');const scripts=manifest.content_scripts[0].js;assert(scripts.indexOf('login-url.js')<scripts.indexOf('content.js'));
for(const n of ['popup','options']){const s=fs.readFileSync(p+n+'.html','utf8');assert(s.indexOf('login-url.js')<s.indexOf(n+'.js'));}
for(const [n,call]of [['content.js','OILoginUrl(h.site)'],['popup.js','OILoginUrl(site)'],['options.js','OILoginUrl(oiSiteUrl)']]){const s=fs.readFileSync(p+n,'utf8');assert(s.includes(call));assert(!s.includes('/?login=1'));}
console.log('PASS',count,'locale/provider/base-URL cases; all 3 entry points and script loading order');

