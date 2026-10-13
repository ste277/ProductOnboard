export const DOCS_WORKSPACE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="docs-workspace-csrf" content="__CSRF_TOKEN__">
  <title>Docs Workspace</title>
  <link rel="stylesheet" href="/workspace.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/docs" data-route><span class="brand-mark">D</span><span>Docs Workspace</span></a>
    <nav aria-label="Workspace">
      <a href="/docs" data-route>Documents</a>
      <a href="/docs/generate" data-route>Generate</a>
    </nav>
    <span class="environment">Private workspace</span>
  </header>
  <main id="app" tabindex="-1"><div class="loading">Loading workspace...</div></main>
  <div id="toast" role="status" aria-live="polite"></div>
  <script src="/workspace.js" defer></script>
</body>
</html>`;

export const DOCS_WORKSPACE_CSS = `
:root{color-scheme:light;--ink:#17202a;--muted:#667085;--line:#d9dee7;--soft:#f5f7fa;--panel:#fff;--nav:#18212b;--blue:#1769aa;--green:#18794e;--amber:#9a6700;--red:#b42318;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--soft);color:var(--ink);font-size:14px;letter-spacing:0}.topbar{height:56px;background:var(--nav);color:#fff;display:flex;align-items:center;padding:0 24px;gap:28px;border-bottom:1px solid #0e151c}.brand{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none;font-weight:700}.brand-mark{width:28px;height:28px;display:grid;place-items:center;background:#35a66f;border-radius:5px}.topbar nav{display:flex;height:100%;gap:4px}.topbar nav a{display:flex;align-items:center;color:#c8d0da;text-decoration:none;padding:0 14px;border-bottom:2px solid transparent}.topbar nav a.active{color:#fff;border-color:#5fc995}.environment{margin-left:auto;color:#aeb8c4;font-size:12px}
main{max-width:1240px;margin:0 auto;padding:30px 32px 64px}main:focus{outline:none}.page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:24px}.page-head h1{font-size:26px;line-height:1.25;margin:0 0 6px}.page-head p{margin:0;color:var(--muted);max-width:720px}.button{border:1px solid #145b91;background:var(--blue);color:#fff;border-radius:6px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px}.button.secondary{background:#fff;color:var(--ink);border-color:var(--line)}.button:disabled{background:#e5e7eb;border-color:#d0d5dd;color:#98a2b3;cursor:not-allowed}.panel{background:var(--panel);border:1px solid var(--line);border-radius:7px}.empty{padding:64px 24px;text-align:center}.empty-icon{width:48px;height:48px;border:1px solid var(--line);border-radius:7px;margin:0 auto 16px;display:grid;place-items:center;font-size:22px;color:var(--muted)}.empty h2{font-size:18px;margin:0 0 7px}.empty p{margin:0 auto 20px;color:var(--muted);max-width:460px}
.table{width:100%;border-collapse:collapse}.table th{text-align:left;font-size:11px;text-transform:uppercase;color:var(--muted);padding:11px 16px;border-bottom:1px solid var(--line);background:#fafbfc}.table td{padding:15px 16px;border-bottom:1px solid #e8ebf0;vertical-align:middle}.table tr:last-child td{border-bottom:0}.title-link{font-weight:650;color:var(--ink);text-decoration:none}.subtle{font-size:12px;color:var(--muted);margin-top:3px}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:650;background:#edf2f7;color:#475467}.badge.success{background:#e8f5ee;color:var(--green)}.badge.warning{background:#fff4d6;color:var(--amber)}.badge.danger{background:#feeceb;color:var(--red)}
.generate-grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:20px}.section{padding:22px}.section h2{font-size:17px;margin:0 0 16px}.field{margin-bottom:20px}.field label,.label{display:block;font-weight:650;margin-bottom:7px}.field select{width:100%;height:40px;border:1px solid #bfc7d2;border-radius:5px;background:#fff;padding:0 10px;font:inherit}.objective-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.objective{position:relative;display:block;border:1px solid var(--line);border-radius:6px;padding:14px;cursor:pointer;min-height:96px}.objective:has(input:checked){border-color:var(--blue);box-shadow:0 0 0 1px var(--blue)}.objective:has(input:disabled){background:#f5f6f8;color:#98a2b3;cursor:not-allowed}.objective input{position:absolute;top:14px;right:14px}.objective strong{display:block;margin-bottom:5px}.objective span{display:block;color:var(--muted);font-size:12px;line-height:1.45;padding-right:22px}.readiness dl,.metadata{margin:0}.readiness-row,.metadata-row{display:flex;justify-content:space-between;gap:20px;padding:10px 0;border-bottom:1px solid #e8ebf0}.readiness-row:last-child,.metadata-row:last-child{border-bottom:0}.readiness dt,.metadata dt{color:var(--muted)}.readiness dd,.metadata dd{margin:0;font-weight:600;text-align:right}.warning-box{border-left:3px solid #d99a00;background:#fff8e8;padding:12px 14px;margin:16px 0;color:#624600}.error-box{border-left:3px solid var(--red);background:#fff1f0;padding:12px 14px;margin:16px 0;color:#7a271a}.actions{display:flex;justify-content:flex-end;padding-top:6px}
.review-layout{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:20px}.article{padding:36px 44px;min-height:620px}.article h1{font-size:30px;line-height:1.25;margin:0 0 18px}.article h2{font-size:18px;margin:28px 0 10px;padding-top:18px;border-top:1px solid #eceef2}.article p,.article li{font-size:15px;line-height:1.7}.article ol,.article ul{padding-left:24px}.side-stack{display:grid;gap:14px;align-content:start}.side-panel{padding:18px}.side-panel h2{font-size:15px;margin:0 0 12px}.claim{padding:11px 0;border-bottom:1px solid #e8ebf0}.claim:last-child{border-bottom:0}.claim p{margin:5px 0 0;line-height:1.45;color:#475467}.claim-source{font-size:11px;color:var(--muted)}details{margin-top:8px}summary{cursor:pointer;color:var(--blue);font-size:12px}details .mono{margin-top:7px;padding:8px;background:var(--soft);border-radius:4px}.screenshot-list{display:grid;gap:10px}.screenshot-list img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:4px}.loading{padding:80px;text-align:center;color:var(--muted)}#toast{position:fixed;right:22px;bottom:22px;background:#17202a;color:#fff;padding:11px 15px;border-radius:5px;opacity:0;transform:translateY(10px);transition:.2s;pointer-events:none}#toast.show{opacity:1;transform:none}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow-wrap:anywhere}
.editor{padding:24px}.editor-title{width:100%;font:700 26px/1.25 inherit;border:1px solid var(--line);border-radius:5px;padding:10px 12px;margin-bottom:12px}.editor-toolbar{display:flex;gap:5px;flex-wrap:wrap;padding:8px;background:var(--soft);border:1px solid var(--line);border-bottom:0;border-radius:5px 5px 0 0}.tool{width:34px;height:32px;border:1px solid var(--line);background:#fff;border-radius:4px;cursor:pointer;font-weight:700}.markdown-editor{width:100%;min-height:520px;resize:vertical;border:1px solid var(--line);border-radius:0 0 5px 5px;padding:18px;font:14px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:0}.editor-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:14px}.approval-confirm{display:flex;align-items:center;gap:7px;margin-right:auto;font-size:12px;color:var(--muted)}.issue{border-left:3px solid var(--red);background:#fff5f4;padding:9px 10px;margin:8px 0}.issue p{margin:4px 0 0}.tenant-item{padding:10px 0;border-bottom:1px solid var(--line)}.tenant-item:last-child{border-bottom:0}.tenant-item select{width:100%;margin:8px 0;height:34px;border:1px solid var(--line);border-radius:4px;background:#fff}.revision-item{padding:8px 0;border-bottom:1px solid var(--line)}.revision-item:last-child{border-bottom:0}.revision-content{white-space:pre-wrap;max-height:220px;overflow:auto;background:var(--soft);padding:10px;margin-top:8px}.status-note{padding:10px 12px;background:#edf6ff;border-left:3px solid var(--blue);margin-bottom:14px}.button.danger{background:#fff;color:var(--red);border-color:#e0a09a}.button.approve{background:var(--green);border-color:#14643f}.button.small{padding:6px 9px;font-size:12px}
main,.review-layout,.review-layout>*{min-width:0;max-width:100%}.side-stack,.side-panel,.editor,.screenshot-review,.revision-item{min-width:0}.claim p,.issue p,.subtle,.metadata dd{overflow-wrap:anywhere}.markdown-editor,.editor-title{min-width:0;max-width:100%}.markdown-editor{white-space:pre-wrap;overflow-wrap:anywhere}.revision-content{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}.screenshot-list img{max-width:100%}.editor-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.save-status{font-size:12px;font-weight:600;color:var(--muted)}.save-error{color:var(--red);overflow-wrap:anywhere;margin-top:8px}.screenshot-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.screenshot-review{padding:12px 0;border-bottom:1px solid var(--line)}.screenshot-review:last-child{border-bottom:0}.editor-actions{align-items:center}.approval-confirm{flex-basis:100%;margin:0}.button{white-space:normal;overflow-wrap:anywhere}
@media(max-width:850px){.environment{display:none}.topbar{padding:0 14px;gap:14px}.brand span:last-child{display:none}main{padding:22px 16px 48px}.generate-grid,.review-layout{grid-template-columns:minmax(0,1fr)}.objective-grid{grid-template-columns:1fr}.page-head{align-items:stretch;flex-direction:column}.article{padding:26px 22px}.editor{padding:16px}.markdown-editor{min-height:420px}.editor-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.editor-actions .button{width:100%;min-width:0}.approval-confirm{grid-column:1/-1;width:100%;margin-bottom:4px}.table{display:block;overflow:auto}}
`;

export const DOCS_WORKSPACE_JS = `
const app=document.querySelector('#app');
const toast=document.querySelector('#toast');
const csrf=document.querySelector('meta[name="docs-workspace-csrf"]').content;
const state={features:[],documents:[]};
let dirty=false;
const esc=(value)=>String(value??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=(value)=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
const badge=(text,tone='')=>'<span class="badge '+tone+'">'+esc(text)+'</span>';
async function api(url,options={}){const mutation=options.method&&options.method!=='GET';const response=await fetch(url,{...options,headers:{'content-type':'application/json',...(mutation?{'x-docs-csrf':csrf}:{}),...(options.headers||{})}});const body=await response.json();if(!response.ok)throw new Error(body.message||'Request failed');return body;}
function notice(message){toast.textContent=message;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2800)}
function navigate(url){if(dirty&&!confirm('Discard unsaved document changes?'))return;dirty=false;history.pushState({},'',url);render()}
document.addEventListener('click',(event)=>{const link=event.target.closest('[data-route]');if(!link)return;event.preventDefault();navigate(link.getAttribute('href'))});
window.addEventListener('popstate',render);
window.addEventListener('beforeunload',(event)=>{if(dirty){event.preventDefault();event.returnValue=''}});
function setActive(){document.querySelectorAll('.topbar nav a').forEach(a=>a.classList.toggle('active',location.pathname===a.getAttribute('href')||(location.pathname.startsWith('/docs/')&&a.getAttribute('href')==='/docs'&&!location.pathname.startsWith('/docs/generate'))))}
async function load(){[state.features,state.documents]=await Promise.all([api('/api/features'),api('/api/documents')]);}
async function render(){setActive();app.innerHTML='<div class="loading">Loading workspace...</div>';try{await load();const match=/^\\/docs\\/([^/]+)$/.exec(location.pathname);if(location.pathname==='/docs/generate')renderGenerate();else if(match)await renderReview(match[1]);else renderDocuments();app.focus()}catch(error){app.innerHTML='<div class="panel error-box">'+esc(error.message)+'</div>'}}
function renderDocuments(){app.innerHTML='<div class="page-head"><div><h1>Documents</h1><p>Grounded documentation generated from frozen product evidence.</p></div><a class="button" href="/docs/generate" data-route>Generate document</a></div>'+(state.documents.length?'<div class="panel"><table class="table"><thead><tr><th>Document</th><th>Feature</th><th>Generation</th><th>Review</th><th>Updated</th></tr></thead><tbody>'+state.documents.map(d=>'<tr><td><a class="title-link" data-route href="/docs/'+encodeURIComponent(d.id)+'">'+esc(d.title)+'</a><div class="subtle mono">'+esc(d.evidencePackageId)+'</div></td><td>'+esc(d.featureName)+'</td><td>'+badge(d.generationStatus,d.generationStatus==='succeeded'?'success':d.generationStatus==='failed'?'danger':'')+'</td><td>'+badge(d.reviewStatus,d.reviewStatus==='needs-review'?'warning':'')+'</td><td>'+esc(date(d.updatedAt))+'</td></tr>').join('')+'</tbody></table></div>':'<div class="panel empty"><div class="empty-icon">≡</div><h2>No documents yet</h2><p>Select an analyzed feature and generate the first evidence-grounded draft.</p><a class="button" href="/docs/generate" data-route>Generate document</a></div>')}
function renderGenerate(){const options=state.features.map(f=>'<option value="'+esc(f.id)+'">'+esc(f.name)+'</option>').join('');app.innerHTML='<div class="page-head"><div><h1>Generate document</h1><p>Choose evidence, set the documentation objective, and create a grounded draft.</p></div></div><div class="generate-grid"><section class="panel section"><h2>Generation setup</h2><div class="field"><label for="feature">Analyzed feature</label><select id="feature"><option value="">Select a feature</option>'+options+'</select></div><div class="field"><span class="label">Documentation objective</span><div class="objective-grid"><label class="objective"><input type="radio" name="objective" value="feature-overview" checked><strong>Feature overview</strong><span>Explain the visible capability and available areas.</span></label><label class="objective" id="howto-card"><input id="howto" type="radio" name="objective" value="how-to-guide"><strong>How-to guide</strong><span>Use only when evidence contains an observed procedure and outcome.</span></label></div></div><div id="tenant-warning"></div><div id="generation-error"></div><div class="actions"><button id="generate" class="button" disabled>Generate grounded draft</button></div></section><aside class="panel section readiness"><h2>Evidence readiness</h2><div id="readiness"><p class="subtle">Select a feature to inspect its evidence.</p></div></aside></div>';const select=document.querySelector('#feature');select.addEventListener('change',updateReadiness);document.querySelector('#generate').addEventListener('click',generate);updateReadiness()}
function updateReadiness(){const feature=state.features.find(f=>f.id===document.querySelector('#feature').value);const button=document.querySelector('#generate');const howto=document.querySelector('#howto');howto.disabled=!feature?.procedureReady;if(!feature?.procedureReady&&howto.checked)document.querySelector('input[value="feature-overview"]').checked=true;button.disabled=!feature?.evidenceReady;document.querySelector('#tenant-warning').innerHTML=feature?.tenantSpecific?'<div class="warning-box"><strong>Tenant-specific evidence</strong><br>This evidence contains customer-specific information. The generated draft must be reviewed before it can leave this private workspace.</div>':'';document.querySelector('#readiness').innerHTML=feature?'<dl><div class="readiness-row"><dt>Status</dt><dd>'+badge(feature.evidenceReady?'Ready':'Incomplete',feature.evidenceReady?'success':'danger')+'</dd></div><div class="readiness-row"><dt>Publishable claims</dt><dd>'+feature.publishableClaimCount+' / '+feature.claimCount+'</dd></div><div class="readiness-row"><dt>Screenshots</dt><dd>'+feature.screenshotCount+'</dd></div><div class="readiness-row"><dt>Limitations</dt><dd>'+feature.limitationCount+'</dd></div><div class="readiness-row"><dt>How-to evidence</dt><dd>'+esc(feature.procedureReady?'Available':'Not available')+'</dd></div><div class="readiness-row"><dt>Package</dt><dd class="mono">'+esc(feature.evidencePackageId)+'</dd></div></dl>':'<p class="subtle">Select a feature to inspect its evidence.</p>'}
async function generate(){const button=document.querySelector('#generate');const featureId=document.querySelector('#feature').value;const objective=document.querySelector('input[name="objective"]:checked').value;button.disabled=true;button.textContent='Generating...';document.querySelector('#generation-error').innerHTML='';try{const document_=await api('/api/documents/generate',{method:'POST',body:JSON.stringify({featureId,objective})});state.documents.unshift(document_);if(document_.generationStatus==='failed')throw new Error(document_.failure?.message||'Generation failed');navigate('/docs/'+document_.id)}catch(error){document.querySelector('#generation-error').innerHTML='<div class="error-box">'+esc(error.message)+'</div>';button.disabled=false;button.textContent='Generate grounded draft'}}
async function renderReview(id){
  let d=await api('/api/documents/'+encodeURIComponent(id));
  if(!d.article){app.innerHTML='<div class="error-box">'+esc(d.failure?.message||'Document is not ready.')+'</div>';return}
  const revision=()=>d.revisions.find(r=>r.id===d.currentRevisionId);
  let saving=false;
  const draw=()=>{
    const r=revision();
    const unresolved=r.tenantWarnings.filter(w=>w.status==='unresolved');
    const images=r.screenshotReviews||[];
    const imagesReady=images.every(s=>s.disposition==='excluded'||(s.disposition==='accepted-safe'&&s.safety!=='known-tenant-information'));
    const ready=r.validation.status==='passed'&&!r.validation.issues.length&&!unresolved.length&&imagesReady&&r.evidenceAssociations.length>0&&!r.evidenceAssociations.some(a=>a.status!=='valid');
    app.innerHTML='<div class="page-head"><div><h1>Document review</h1><p>'+esc(d.featureName)+'</p></div>'+badge(d.reviewStatus,d.reviewStatus==='approved'?'success':'warning')+'</div>'+
      '<div class="review-layout"><section class="panel editor"><div class="status-note"><strong>'+
      esc(r.validation.status==='needs-validation'?'Needs validation':r.validation.status==='failed'?'Validation issues':ready?'Ready for approval':'Review required')+
      '</strong><br><span class="subtle">Revision '+r.number+' · '+esc(date(r.createdAt))+'</span></div>'+
      '<div class="editor-heading"><label class="label" for="document-title">Title</label><span id="save-status" role="status" aria-live="polite" class="save-status">Saved</span></div>'+
      '<input id="document-title" class="editor-title" value="'+esc(r.title)+'"><label class="label" for="markdown">Markdown content</label>'+
      '<div class="editor-toolbar" aria-label="Markdown block tools"><button class="tool" data-prefix="## " title="Heading">H</button>'+
      '<button class="tool" data-prefix="- " title="Unordered list">•</button><button class="tool" data-prefix="1. " title="Ordered list">1.</button>'+
      '<button class="tool" data-add title="Add block">+</button><button class="tool" data-remove title="Remove current block">−</button></div>'+
      '<textarea id="markdown" class="markdown-editor" spellcheck="true">'+esc(r.markdown)+'</textarea>'+
      '<div id="save-error" class="save-error" role="alert"></div><div class="editor-actions">'+
      '<label class="approval-confirm"><input id="approve-confirm" type="checkbox"> I have reviewed this revision and confirm approval</label>'+
      '<button id="request-changes" class="button secondary">Request changes</button><button id="save" class="button secondary">Save draft</button>'+
      '<button id="validate" class="button">Revalidate</button><button id="approve" class="button approve" '+(!ready?'disabled':'')+'>Approve</button></div></section>'+
      '<aside class="side-stack"><section class="panel side-panel"><h2>Validation</h2><dl class="metadata">'+
      '<div class="metadata-row"><dt>Status</dt><dd>'+badge(r.validation.status,r.validation.status==='passed'?'success':r.validation.status==='failed'?'danger':'warning')+'</dd></div>'+
      '<div class="metadata-row"><dt>Supported</dt><dd>'+r.validation.supportedStatements+'</dd></div><div class="metadata-row"><dt>Unsupported</dt><dd>'+r.validation.unsupportedStatements+'</dd></div></dl>'+
      r.validation.issues.map(i=>'<div class="issue"><strong>'+esc(i.type.replaceAll('-',' '))+'</strong><p>'+esc(i.text)+'</p><span class="subtle">'+esc(i.message)+'</span></div>').join('')+'</section>'+
      '<section class="panel side-panel"><h2>Tenant information</h2>'+
      (unresolved.length?unresolved.map(w=>'<div class="tenant-item"><strong>'+esc(w.type.replaceAll('-',' '))+'</strong><div class="subtle">'+esc(w.maskedValue)+'</div>'+
      '<select aria-label="Replacement placeholder" data-placeholder="'+esc(w.id)+'"><option value="[your support email address]">Support email placeholder</option>'+
      '<option value="[your tenant domain]">Tenant domain placeholder</option><option value="[your customer name]">Customer name placeholder</option></select>'+
      '<button class="button secondary small" data-redact="'+esc(w.id)+'">Replace value</button></div>').join(''):'<p class="subtle">No unresolved tenant information in article text.</p>')+'</section>'+
      '<section class="panel side-panel"><h2>Screenshot review</h2><div class="screenshot-list">'+
      images.map((s,index)=>'<div class="screenshot-review"><strong>Screenshot '+(index+1)+'</strong> '+
      badge(s.disposition==='excluded'?'Excluded':s.disposition==='accepted-safe'?'Reviewed: safe to include':s.safety==='known-tenant-information'?'Known tenant information':'Needs screenshot review',s.disposition==='needs-review'?'warning':'success')+
      '<p class="subtle">'+(s.safety==='known-tenant-information'?'Frozen evidence identifies tenant information in this runtime state. Exclude this image; acknowledgment cannot clear the exposure.':'Image safety has not been established automatically. Review the full screenshot before including it.')+'</p>'+
      '<details><summary>Inspect original screenshot</summary><img loading="lazy" alt="Original evidence screenshot '+(index+1)+'" src="/api/documents/'+encodeURIComponent(d.id)+'/screenshots/'+encodeURIComponent(s.stateId)+'"></details>'+
      '<div class="screenshot-actions"><button class="button secondary small" data-image-safe="'+esc(s.stateId)+'" '+(s.safety==='known-tenant-information'||s.checksum==='unavailable'||s.disposition==='accepted-safe'?'disabled':'')+'>Reviewed: safe to include</button>'+
      '<button class="button secondary small" data-image-exclude="'+esc(s.stateId)+'" '+(s.disposition==='excluded'?'disabled':'')+'>Exclude screenshot</button></div></div>').join('')+'</div></section>'+
      '<section class="panel side-panel"><h2>Evidence support</h2>'+r.evidenceAssociations.map(a=>'<div class="claim"><span class="claim-source">Block '+(a.blockIndex+1)+' · '+esc(a.status)+'</span><p>'+esc(a.text)+'</p>'+
      '<details><summary>Source references ('+a.evidenceRefs.length+')</summary><div class="mono">'+a.evidenceRefs.slice(0,5).map(esc).join('<br>')+'</div></details></div>').join('')+'</section>'+
      '<section class="panel side-panel"><h2>Revision history</h2>'+[...d.revisions].reverse().map(item=>'<details class="revision-item"><summary>Revision '+item.number+' · '+esc(item.validation.status)+'</summary>'+
      '<div class="subtle">'+esc(date(item.createdAt))+' · '+esc(item.reviewer)+'</div><div class="revision-content mono">'+esc(item.markdown)+'</div><div class="subtle">'+(item.screenshotReviews||[]).map(s=>esc(s.disposition)).join(' · ')+'</div></details>').join('')+'</section>'+
      '<section class="panel side-panel"><h2>Audit trail</h2>'+(d.auditTrail||[]).slice().reverse().map(a=>'<div class="revision-item"><strong>'+esc(a.action.replaceAll('-',' '))+'</strong>'+
      '<div class="subtle">'+esc(a.reviewer)+' · '+esc(date(a.timestamp))+'</div></div>').join('')+'</section></aside></div>';
    bind();
  };
  const mutation=async(url,body)=>{
    if(dirty){notice('Save your changes first.');return}
    try{d=await api(url,{method:'POST',body:JSON.stringify(body)});draw();notice('Document updated')}
    catch(error){notice(error.message)}
  };
  const bind=()=>{
    const title=document.querySelector('#document-title');
    const markdown=document.querySelector('#markdown');
    const changed=()=>{
      dirty=true;
      document.querySelector('#save-status').textContent='Unsaved changes';
      document.querySelector('#validate').disabled=true;
      document.querySelector('#approve').disabled=true;
    };
    [title,markdown].forEach(el=>el.addEventListener('input',changed));
    document.querySelectorAll('[data-prefix]').forEach(button=>button.addEventListener('click',()=>{insertPrefix(markdown,button.dataset.prefix);changed()}));
    document.querySelector('[data-add]').addEventListener('click',()=>{insertText(markdown,'\\n\\n');changed()});
    document.querySelector('[data-remove]').addEventListener('click',()=>{removeBlock(markdown);changed()});
    document.querySelector('#save').addEventListener('click',async()=>{
      if(saving)return;
      saving=true;
      const save=document.querySelector('#save');
      const status=document.querySelector('#save-status');
      status.textContent='Saving';
      save.disabled=true;
      title.disabled=true;markdown.disabled=true;
      document.querySelectorAll('.editor-toolbar button').forEach(button=>button.disabled=true);
      try{
        d=await api('/api/documents/'+d.id+'/revisions',{method:'POST',body:JSON.stringify({expectedRevisionId:d.currentRevisionId,title:title.value,markdown:markdown.value})});
        dirty=false;draw();notice('Draft saved');
      }catch(error){
        dirty=true;status.textContent='Save failed';
        document.querySelector('#save-error').textContent=error.message;
        document.querySelector('#validate').disabled=true;
        document.querySelector('#approve').disabled=true;
        save.disabled=false;title.disabled=false;markdown.disabled=false;
        document.querySelectorAll('.editor-toolbar button').forEach(button=>button.disabled=false);
      }finally{saving=false}
    });
    document.querySelector('#validate').addEventListener('click',()=>mutation('/api/documents/'+d.id+'/validate',{expectedRevisionId:d.currentRevisionId}));
    document.querySelector('#request-changes').addEventListener('click',()=>mutation('/api/documents/'+d.id+'/review',{expectedRevisionId:d.currentRevisionId,action:'request-changes',confirmed:false}));
    document.querySelector('#approve').addEventListener('click',()=>mutation('/api/documents/'+d.id+'/review',{expectedRevisionId:d.currentRevisionId,action:'approve',confirmed:document.querySelector('#approve-confirm').checked}));
    document.querySelectorAll('[data-redact]').forEach(button=>button.addEventListener('click',()=>mutation('/api/documents/'+d.id+'/tenant-redactions',{expectedRevisionId:d.currentRevisionId,warningId:button.dataset.redact,placeholder:document.querySelector('[data-placeholder="'+button.dataset.redact+'"]').value})));
    document.querySelectorAll('[data-image-safe],[data-image-exclude]').forEach(button=>button.addEventListener('click',()=>mutation('/api/documents/'+d.id+'/screenshot-reviews',{expectedRevisionId:d.currentRevisionId,stateId:button.dataset.imageSafe||button.dataset.imageExclude,disposition:button.dataset.imageSafe?'accepted-safe':'excluded'})));
  };
  draw();
}
function insertPrefix(editor,prefix){const start=editor.selectionStart;const line=editor.value.lastIndexOf('\\n',start-1)+1;editor.setRangeText(prefix,line,line,'end');dirty=true;editor.focus()}
function insertText(editor,text){editor.setRangeText(text,editor.selectionStart,editor.selectionEnd,'end');dirty=true;editor.focus()}
function removeBlock(editor){const start=editor.value.lastIndexOf('\\n\\n',editor.selectionStart-1)+2;let end=editor.value.indexOf('\\n\\n',editor.selectionEnd);if(end<0)end=editor.value.length;editor.setRangeText('',start,end,'start');dirty=true;editor.focus()}
function section(title,items,ordered=false){if(!items?.length)return'';const tag=ordered?'ol':'ul';return'<h2>'+esc(title)+'</h2><'+tag+'>'+items.map(item=>'<li>'+esc(item.text)+'</li>').join('')+'</'+tag+'>'}
render();
`;
