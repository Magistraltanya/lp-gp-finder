<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Magistral LP + GP Finder Pro</title>

<!-- SheetJS for Excel/CSV parsing -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>

<!-- ─────────────────────────── STYLES ─────────────────────────── -->
<style>
:root{
  /* Magistral palette */
  --blue:#003366;--teal:#009999;--gold:#F2A900;--grey:#6C7A89;
  --bg:#f4f6f8;--white:#ffffff;--border:#e1e5ea;
  --font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --shadow:0 2px 4px rgba(0,0,0,.08);
}
*{box-sizing:border-box;margin:0;padding:0}
body{display:flex;min-height:100vh;background:var(--bg);font-family:var(--font);color:#222}

/* ---------- layout ---------- */
.sidebar{flex:0 0 280px;background:var(--white);border-right:1px solid var(--border);padding:24px;display:flex;flex-direction:column;gap:24px}
.main{flex:1;padding:24px;display:flex;flex-direction:column;position:relative}

.panel{background:var(--white);border:1px solid var(--border);border-radius:8px;padding:20px;box-shadow:var(--shadow)}
.panel h2{font-size:18px;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border);color:var(--blue)}

input,select{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:6px;font-size:14px}
input:focus{outline:none;border-color:var(--teal);box-shadow:0 0 0 3px rgba(0,153,153,.25)}

.btn{display:block;width:100%;padding:10px 14px;margin-bottom:12px;font-size:14px;font-weight:600;border:none;border-radius:6px;cursor:pointer}
.btn-primary{background:var(--teal);color:#fff}.btn-primary:hover{background:#008080}
.btn-grey{background:var(--grey);color:#fff}.btn-grey:hover{background:#5a6877}
.btn:disabled{opacity:.5;cursor:not-allowed}

.filter-buttons{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.filter-buttons .btn{margin:0;padding:8px 0;font-size:13px}
.filter-buttons .active{background:var(--blue)}

/* ---------- table ---------- */
.table-wrap{flex:1;margin-top:16px;border:1px solid var(--border);border-radius:8px;background:var(--white);overflow:auto;box-shadow:var(--shadow)}
.table-wrap table{width:100%;border-collapse:collapse;table-layout:fixed}
th,td{padding:10px 12px;border-bottom:1px solid var(--border);font-size:13px;text-overflow:ellipsis;overflow:hidden;white-space:nowrap}
th{background:var(--bg);color:var(--blue);font-weight:600;text-transform:uppercase;position:sticky;top:0;z-index:2;cursor:pointer}
.row-new{background:#fffde5}

/* actions */
.action{background:none;border:none;cursor:pointer;font-size:16px;padding:0 4px}

/* toast */
#toast{position:fixed;top:20px;right:20px;z-index:2000}
.toast{padding:12px 18px;border-radius:6px;color:#fff;margin-bottom:10px;box-shadow:var(--shadow);opacity:0;transform:translateY(-20px);transition:.3s}
.toast.show{opacity:1;transform:none}.ok{background:var(--teal)}.err{background:var(--blue)}

/* overlay */
#overlay{position:absolute;inset:0;background:rgba(255,255,255,.6);display:none;align-items:center;justify-content:center;z-index:100}
.spinner{width:40px;height:40px;border:5px solid rgba(0,0,0,.1);border-top-color:var(--teal);border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}

/* modal */
.modal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:1500}
.modal-inner{background:#fff;border-radius:8px;padding:24px;max-height:80vh;overflow:auto;min-width:280px;box-shadow:var(--shadow)}
.modal h3{margin-top:0;color:var(--blue)}
</style>
</head>
<body>
  <aside class="sidebar">
    <!-- View panel -->
    <div class="panel">
      <h2>View</h2>
      <div class="filter-buttons">
        <button class="btn active" data-filter="All">All</button>
        <button class="btn" data-filter="LP">LPs</button>
        <button class="btn" data-filter="GP">GPs</button>
      </div>
      <button id="col-btn" class="btn btn-grey">Configure Columns</button>
    </div>

    <!-- AI Discovery -->
    <div class="panel">
      <h2>AI Discovery</h2>
      <label>Entity Type</label>
      <select id="ai-type"><option>LP</option><option>GP</option><option>Broker</option></select>
      <label style="margin-top:10px">Specific Type</label>
      <input id="ai-sub" placeholder="Family Office">
      <label style="margin-top:10px">Sector</label>
      <input id="ai-sec" placeholder="Health Care">
      <label style="margin-top:10px">Geography</label>
      <input id="ai-geo" placeholder="USA">
      <button id="ai-btn" class="btn btn-primary" style="margin-top:12px">✨ Find Investors</button>
    </div>

    <!-- Manage -->
    <div class="panel">
      <h2>Manage List</h2>
      <label class="btn btn-grey" for="file-in">Upload Excel/CSV</label>
      <input id="file-in" type="file" accept=".xlsx,.xls,.csv" style="display:none">
      <button id="exp-btn" class="btn btn-grey">Export CSV</button>
    </div>
  </aside>

  <!-- Main -->
  <main class="main">
    <div id="overlay"><div class="spinner"></div></div>
    <input id="search" type="text" placeholder="Search…" style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;width:100%;margin-bottom:12px">
    <div class="table-wrap">
      <table>
        <thead id="thead"></thead>
        <tbody id="tbody"></tbody>
      </table>
      <p id="empty-msg" style="text-align:center;padding:32px;color:#888">Upload a file or use AI Discovery to get started.</p>
    </div>
  </main>

  <!-- Column modal -->
  <div id="col-modal" class="modal">
    <div class="modal-inner">
      <h3>Visible Columns</h3>
      <div id="col-list" style="columns:2 180px"></div>
      <button id="col-close" class="btn btn-primary" style="margin-top:14px">Done</button>
    </div>
  </div>

  <!-- Contacts modal -->
  <div id="contact-modal" class="modal">
    <div class="modal-inner" style="min-width:320px">
      <h3 id="c-title"></h3>
      <div id="c-body"></div>
      <button class="btn btn-primary" onclick="document.getElementById('contact-modal').style.display='none'">Close</button>
    </div>
  </div>

  <div id="toast"></div>

<!-- ─────────────────────────── SCRIPT ─────────────────────────── -->
<script>
(()=>{
  /* -------- column definitions (only firm‑level columns in main table) -------- */
  const COLUMNS=[
    {key:'sn',label:'S.No.'},
    {key:'entityType',label:'LP/GP/Broker'},
    {key:'firmName',label:'Firm Name'},
    {key:'subType',label:'Type'},
    {key:'country',label:'Country'},
    {key:'sector',label:'Sector'},
    {key:'website',label:'Website'},
    {key:'source',label:'Source'}
  ];

  const state={filter:'All',search:'',visible:new Set(COLUMNS.map(c=>c.key)),sort:{col:'firmName',dir:'asc'}};
  let db=[];let sn=1;

  /* ---------- tiny helpers ---------- */
  const $=id=>document.getElementById(id);
  const create=(tag,cls)=>{const e=document.createElement(tag);if(cls)e.className=cls;return e};
  const toast=(msg,type='ok')=>{const t=create('div','toast '+type);t.textContent=msg;$('toast').appendChild(t);requestAnimationFrame(()=>t.classList.add('show'));setTimeout(()=>{t.classList.remove('show');t.addEventListener('transitionend',()=>t.remove());},4000);};
  const overlay=v=>$('overlay').style.display=v?'flex':'none';

  /* ---------- rendering ---------- */
  function render(){
    const thead=$('thead'),tbody=$('tbody');thead.innerHTML='';tbody.innerHTML='';
    const hr=thead.insertRow();COLUMNS.forEach(c=>{if(!state.visible.has(c.key))return;const th=create('th');th.textContent=c.label;th.onclick=()=>{state.sort.col=c.key;state.sort.dir=state.sort.dir==='asc'?'desc':'asc';render();};hr.appendChild(th);});

    const rows=db.filter(r=>state.filter==='All'||r.entityType===state.filter).filter(r=>{const q=state.search.toLowerCase();return!q||Object.values(r).some(v=>String(v).toLowerCase().includes(q))})
      .sort((a,b)=>{const A=a[state.sort.col]||'',B=b[state.sort.col]||'';return(A<B?-1:A>B?1:0)*(state.sort.dir==='asc'?1:-1)});

    rows.forEach(r=>{
      const tr=tbody.insertRow();if(r.source==='Gemini'&&!r.validated)tr.classList.add('row-new');
      COLUMNS.forEach(c=>{if(!state.visible.has(c.key))return;const td=tr.insertCell();
        if(c.key==='website'&&r.website){const a=create('a');a.href=r.website;a.textContent=r.website;a.target='_blank';td.appendChild(a);}else td.textContent=r[c.key]||'';});
      const tdAct=tr.insertCell();
      const btnCon=create('button','action');btnCon.innerHTML='👥';btnCon.title='View Contacts';btnCon.onclick=()=>openContacts(r);tdAct.appendChild(btnCon);
      const btnDel=create('button','action');btnDel.innerHTML='🗑';btnDel.title='Delete';btnDel.onclick=()=>{db=db.filter(x=>x!==r);render();};tdAct.appendChild(btnDel);
    });

    $('empty-msg').style.display=db.length?'none':'block';
  }
  window.updateView=render;

  function openContacts(firm){
    $('c-title').textContent='Contacts – '+firm.firmName;
    $('c-body').innerHTML=(firm.contacts&&firm.contacts.length)?firm.contacts.map(c=>`<p><strong>${c.contactName||''}</strong><br>${c.designation||''}<br>${c.email||''}<br>${c.linkedIn?`<a href="${c.linkedIn}" target="_blank">LinkedIn</a>`:''}</p>`).join(''):'<p>No contacts stored yet.</p>';
    $('contact-modal').style.display='flex';
  }

  /* ---------- column modal ---------- */
  $('col-btn').onclick=()=>{const list=$('col-list');list.innerHTML='';COLUMNS.forEach(c=>{const lab=create('label');lab.style.display='block';const cb=create('input');cb.type='checkbox';cb.checked=state.visible.has(c.key);cb.onchange=e=>{e.target.checked?state.visible.add(c.key):state.visible.delete(c.key);};lab.append(cb,' ',c.label);list.appendChild(lab);});$('col-modal').style.display='flex';};
  $('col-close').onclick=()=>{$('col-modal').style.display='none';render();};
  $('col-modal').onclick=e=>{if(e.target.id==='col-modal'){$('col-modal').style.display='none';}};

  /* ---------- filter & search ---------- */
  document.querySelectorAll('.filter-buttons .btn').forEach(b=>b.onclick=()=>{document.querySelectorAll('.filter-buttons .btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');state.filter=b.dataset.filter;render();});
  $('search').oninput=e=>{state.search=e.target.value;render();};

  /* ---------- upload ---------- */
  $('file-in').onchange=e=>{
    const file=e.target.files[0];if(!file)return;overlay(true);
    const reader=new FileReader();reader.onload=ev=>{
      try{
        const wb=XLSX.read(new Uint8Array(ev.target.result),{type:'array'});
        const json=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
        json.forEach(r=>{
          const web=(r.Website||'').toLowerCase();if(db.some(x=>x.website.toLowerCase()==web))return;
          db.push({sn:sn++,entityType:r['LP/GP/Broker']||'',firmName:r['Firm Name']||'',subType:r.Type||'',country:r.Country||'',sector:r.Sector||'',website:r.Website||'',source:'Upload',validated:1,contacts:[]});
        });toast('Upload finished','ok');render();
      }catch{toast('Upload failed','err');}
      overlay(false);
    };reader.readAsArrayBuffer(file);e.target.value='';
  };

  /* ---------- export ---------- */
  $('exp-btn').onclick=()=>{
    if(!db.length)return toast('Nothing to export','err');
    const headers=COLUMNS.map(c=>c.label).join(',');
    const rows=db.map(r=>COLUMNS.map(c=>'"'+String(r[c.key]||'').replace(/"/g,'""')+'"').join(',')).join('\n');
    const blob=new Blob([headers+'\n'+rows],{type:'text/csv;charset=utf-8'});
    const a=create('a');a.href=URL.createObjectURL(blob);a.download='lp_gp_export.csv';a.click();
  };

  /* ---------- AI Discovery ---------- */
  $('ai-btn').onclick=async()=>{
    const entityType=$('ai-type').value,subType=$('ai-sub').value.trim(),sector=$('ai-sec').value.trim(),geo=$('ai-geo').value.trim();
    if(!subType||!sector||!geo)return toast('Fill all fields','err');
    overlay(true);
    try{
      const res=await fetch('/api/find-investors',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({entityType,subType,sector,geo})});
      const arr=await res.json();if(!res.ok)throw new Error(arr.error||'API error');
      let added=0;arr.forEach(f=>{
        const web=(f.website||'').toLowerCase();if(db.some(x=>x.website.toLowerCase()===web))return;
        db.push({sn:sn++,...f,contacts:[],validated:0});added++;});
      toast(added+' new investors added','ok');render();
    }catch(e){toast('AI failed: '+e.message,'err');}
    overlay(false);
  };

  render();
})();
</script>
</body>
</html>
