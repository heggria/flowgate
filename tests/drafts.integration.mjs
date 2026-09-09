import { _electron as electron } from 'playwright';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const app=await electron.launch({args:['.'],env:{...process.env,FLOWGATE_TEST_DATA:await mkdtemp(resolve('work/drafts-'))}});
try{
 const p=await app.firstWindow();await p.getByRole('heading',{name:'概览',exact:true}).waitFor();
 await p.getByRole('button',{name:'分流规则',exact:true}).click();
 const invalid='a'.repeat(501);await p.getByRole('textbox',{name:'匹配内容'}).fill(invalid);await p.getByRole('button',{name:'添加规则'}).click();await p.getByRole('alert').filter({hasText:'分流规则无效'}).waitFor();assert.equal(await p.getByRole('textbox',{name:'匹配内容'}).inputValue(),invalid);
 await p.getByRole('textbox',{name:'匹配内容'}).fill('draft.example');
 await p.getByRole('button',{name:'设置',exact:true}).click();
 await p.getByRole('textbox',{name:'DNS 服务器',exact:true}).fill('invalid-dns');await p.getByRole('button',{name:'保存网络设置'}).click();await p.getByRole('alert').waitFor();assert.equal(await p.getByRole('textbox',{name:'DNS 服务器',exact:true}).inputValue(),'invalid-dns');
 await p.getByRole('textbox',{name:'DNS 服务器',exact:true}).fill('https://9.9.9.9/dns-query');
 await p.getByRole('button',{name:'重新加载界面'}).click();await p.getByRole('heading',{name:'概览',exact:true}).waitFor();
 await p.getByRole('button',{name:'设置',exact:true}).click();
 await p.waitForFunction(()=>document.querySelector('input[value="https://9.9.9.9/dns-query"]')!==null);
 assert.equal(await p.getByRole('textbox',{name:'DNS 服务器',exact:true}).inputValue(),'https://9.9.9.9/dns-query');
 await p.getByRole('button',{name:'保存网络设置'}).click();
 await p.getByRole('button',{name:'分流规则',exact:true}).click();
 await p.waitForFunction(()=>document.querySelector('input[aria-label="匹配内容"]').value==='draft.example');
 await p.getByRole('button',{name:'添加规则'}).click();await p.getByText('draft.example',{exact:true}).waitFor();assert.equal(await p.getByRole('textbox',{name:'匹配内容'}).inputValue(),'');
 await writeFile('work/drafts-result.json',JSON.stringify({passed:true,at:new Date().toISOString(),checks:['failed rule save retains input','failed settings save retains input','multiple form drafts survive real shell reload','successful save clears rule draft']},null,2));console.log('PASS: form draft and save semantics');
}finally{await app.close();}
