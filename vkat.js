/* Personal holdings and the existing network totals, read at one Katana block. */
const $=id=>document.getElementById(id),MYT='Asia/Kuala_Lumpur';
const fmt=(n,dp=2)=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:dp,maximumFractionDigits:dp}):'—';
const money=n=>Number.isFinite(n)?'$'+fmt(n):'—',big=n=>!Number.isFinite(n)?'—':n>=1e9?fmt(n/1e9)+'B':n>=1e6?fmt(n/1e6)+'M':fmt(n,0);
const share=n=>Number.isFinite(n)?fmt(n*100,1)+'%':'—',when=ts=>new Date(ts*1000).toLocaleString('en-GB',{timeZone:MYT,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const KEY='tf_vkat_holdings_v1',POLL=60000,FRESH=150;let view=null,readAt=0,lastOk=false,busy=false,failure='';
const usable=v=>v?.schemaVersion==='katana-holdings-v1'&&v.network&&v.holdings&&Array.isArray(v.locks);
function metric(cells,i,value,sub,unit=''){const box=cells[i].querySelector('.overview-value');box.textContent=value;
 if(unit){const span=document.createElement('span');span.className='unit';span.textContent=' '+unit;box.append(span);}cells[i].querySelector('.metric-sub').textContent=sub;}
function render(){
 if(view){const n=view.network,c=$('network').children,h=view.holdings,p=$('overview').children;
  metric(c,0,big(n.locked),'$'+big(n.locked*view.kat_usd)+' · '+share(n.locked/n.kat_supply)+' of all KAT · '+fmt(n.locks,0)+' locks','KAT');
  metric(c,1,big(n.avkat_supply),'Backed by '+big(n.avkat_kat)+' KAT · '+share(n.avkat_kat/n.locked)+' of network vKAT','avKAT');
  const change=n.avkat_rate_7d>0?(n.avkat_rate/n.avkat_rate_7d-1)*100:null;
  metric(c,2,fmt(n.avkat_rate,4),'KAT per avKAT'+(change===null?'':' · '+(change>=0?'+':'')+fmt(change)+'% in 7 days'));
  metric(p,0,fmt(h.vkat.amount)+' vKAT',money(h.vkat.value_usd)+(view.locks.length?' · '+view.locks.map(l=>'#'+l.id).join(', '):' · No wallet-held lock'));
  metric(p,1,fmt(h.avkat.amount)+' avKAT',money(h.avkat.value_usd)+' · '+fmt(h.avkat.wallet_amount)+' wallet + '+fmt(h.avkat.collateral_amount)+' lending collateral');
 }
 $('health').textContent=failure;$('health').classList.toggle('on',!!failure);stamp();
}
function stamp(){const fresh=lastOk&&Date.now()/1000-readAt<=FRESH,box=$('stamp');box.className='stamp'+(fresh?'':' stale');
 box.replaceChildren();const dot=document.createElement('span');dot.className='dot';box.append(dot,document.createTextNode(fresh?'LIVE':readAt?'STALE':'LOADING'),document.createElement('br'),document.createTextNode(readAt?when(readAt)+' MYT':'—'));}
async function load(force=false){if(busy||!force&&document.hidden)return;busy=true;
 try{const r=await fetch('/api/vkat?view=holdings',{cache:'no-store',signal:AbortSignal.timeout(25000)}),v=await r.json();if(!r.ok||!usable(v))throw Error(v.error||'Incomplete holdings reading');
  view=v;readAt=v.head_ts||Date.now()/1000;lastOk=true;failure='';try{localStorage.setItem(KEY,JSON.stringify({t:readAt,v}));}catch{}
 }catch(e){lastOk=false;failure=(view?'Could not refresh. Showing the reading from '+when(readAt)+' MYT. ':'Could not read your holdings yet. ')+e.message;}
 finally{busy=false;render();}}
try{const seed=JSON.parse(localStorage.getItem(KEY)||'null');if(usable(seed?.v)){view=seed.v;readAt=seed.t;}}catch{}
render();load(true);setInterval(()=>load(),POLL);setInterval(stamp,1000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load(true);});
