(()=>{
  const config={apiKey:"AIzaSyCxPppnUG864v3E2j1OzykzFmhLpsEJCSE",authDomain:"chess-1885a.firebaseapp.com",projectId:"chess-1885a",appId:"1:824383572856:web:7c663d6bf0f970f6acd68d"};
  const docs=[
    ['ch1-2-en','第 1～2 章','English','英文版講義'],['ch1-2-zh','第 1～2 章','繁體中文','中文翻譯版講義'],
    ['ch3-4-en','第 3～4 章','English','英文版講義'],['ch3-4-zh','第 3～4 章','繁體中文','中文翻譯版講義'],
    ['ch5-6-en','第 5～6 章','English','英文版講義'],['ch5-6-zh','第 5～6 章','繁體中文','中文翻譯版講義'],
    ['ch7-8-en','第 7～8 章','English','英文版講義'],['ch7-8-zh','第 7～8 章','繁體中文','中文翻譯版講義'],
  ].map(([id,range,language,label])=>({id,range,language,label,available:!id.endsWith('-zh')}));
  const lamp=document.querySelector('#syncLamp'),grid=document.querySelector('#lectureCards'),note=document.querySelector('#catalogNote');
  let user=null,db=null;
  const guest=localStorage.getItem('econGuestMode')==='1';
  const fmt=ts=>ts?new Intl.DateTimeFormat('zh-TW',{dateStyle:'medium',timeStyle:'short'}).format(new Date(ts)):'尚未開啟';
  const localMeta=id=>{try{return JSON.parse(localStorage.getItem('econ848_lecture_meta_'+id)||'{}')}catch(_){return{}}};
  const setLamp=(type,msg)=>{lamp.className='syncLamp '+type;lamp.lastElementChild.textContent=msg};
  function render(meta={}){grid.innerHTML=docs.map(d=>{const m=meta[d.id]||localMeta(d.id)||{};const has=m.noteCount>0||m.hasNotes;return `<article class="lectureCard ${d.language==='繁體中文'?'zh':''}"><span class="docBadge">${d.language}</span><h2>${d.range}｜${d.label}</h2><div class="lectureMeta"><span>教材範圍：<b>${d.range}</b></span><span>教材狀態：<b>${d.available?'可閱讀':'逐頁翻譯與排版校對中'}</b></span><span>個人筆記：<b>${has?`${m.noteCount||'已有'} 頁`:'尚無筆記'}</b></span><span>最近開啟：<b>${fmt(m.openedAt)}</b></span></div><a class="openLecture" href="lecture-reader.html?doc=${encodeURIComponent(d.id)}">開啟講義</a></article>`}).join('')}
  async function loadMeta(){if(!user||!db){render();return}try{const snap=await db.collection('users').doc(user.uid).collection('lectureNotes').get();const meta={};snap.forEach(row=>meta[row.id]=row.data());render(meta);setLamp('saved','雲端已同步')}catch(e){render();setLamp('failed','講義狀態讀取失敗：僅顯示本機資料')}}
  try{firebase.initializeApp(config);const auth=firebase.auth();db=firebase.firestore();auth.onAuthStateChanged(u=>{user=u||null;if(!user&&!guest){location.replace('index.html');return}document.body.classList.remove('catalogLoading');setLamp(user?'pending':'local',user?'載入雲端筆記…':'訪客模式：本機已儲存');note.textContent=user?'英文與繁中版本的筆記各自獨立儲存並同步。':'訪客資料只保存在目前瀏覽器；登入帳號後才會跨裝置同步。';loadMeta()})}catch(e){if(!guest){location.replace('index.html');return}document.body.classList.remove('catalogLoading');setLamp('local','訪客模式：本機已儲存');note.textContent='目前未連線 Firebase，筆記只會留在目前瀏覽器。';render()}
})();
