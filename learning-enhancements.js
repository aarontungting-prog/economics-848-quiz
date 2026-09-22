(() => {
  'use strict';
  // The original app declares its data with top-level `const`, which is
  // available to later scripts but is intentionally not a `window` property.
  if (typeof QUESTIONS === 'undefined' || typeof uxEl === 'undefined') return;

  const q = (id) => document.getElementById(id);
  const TYPE_LABELS = { tf: '是非題', mc: '單選題', instant: '即席測驗', draw_tf: '繪圖是非題' };
  const chapterNotes = {
    1:{core:['稀少性使所有選擇都有取捨；成本不只包含金錢。','理性決策以邊際效益（MB）與邊際成本（MC）比較。'],formula:['機會成本＝放棄的最佳替代方案價值。','只在 MB ≥ MC 時增加一單位活動。'],graph:['用 PPF 表示資源限制：線上有效率、線內無效率、線外不可達。'],traps:['效率是把經濟餅做大；均等是如何切餅，兩者不能混為一談。'],memory:['看到「免費」或「只付學費」時，立刻檢查被放棄的時間、收入與最佳替代方案。']},
    2:{core:['經濟模型是有目的的簡化，不是現實的完整複製。','正向敘述可用事實檢驗；規範敘述包含價值判斷。'],formula:['循環流程：家計提供要素、取得所得；廠商提供商品服務、取得收入。'],graph:['PPF 的斜率反映兩商品間的機會成本；曲線外移代表生產能力增加。'],traps:['本身價格改變是沿曲線移動；其他因素改變才是曲線平移。'],memory:['先辨識題目在問個體或總體，再選合適的模型與變數。']},
    3:{core:['絕對利益看生產力；比較利益看機會成本。','即使一方兩種商品都較有效率，仍可能存在互利貿易。'],formula:['生產 1 單位 X 的機會成本＝放棄的 Y 數量；比較這個比值。'],graph:['PPF 的斜率絕對值即機會成本；專業化後消費點可位於各自 PPF 外。'],traps:['不要用「誰產量高」判比較利益；要比機會成本低者。'],memory:['交易價格必須落在雙方機會成本之間，雙方才都願意交易。']},
    4:{core:['需求由價格、所得、相關財價格、偏好、預期與買者數決定。','供給由投入成本、技術、預期與賣者數決定。'],formula:['均衡在 Qd＝Qs；先判斷哪條曲線移動，再判斷 P 與 Q。'],graph:['需求線向右下、供給線向右上；交點同時決定均衡價格與數量。'],traps:['價格本身變動不會使需求／供給曲線平移。'],memory:['兩曲線同時移動時，先找結果一定方向與不一定方向。']},
    5:{core:['彈性衡量數量對價格、所得或相關財價格變化的敏感度。','替代品交叉彈性為正，互補品為負。'],formula:['價格彈性＝數量變動百分比／價格變動百分比；中點法可避免基期差異。','總收益 TR＝P×Q。'],graph:['需求有彈性時，降價使 TR 上升；無彈性時，降價使 TR 下降。'],traps:['「斜率」不等於「彈性」；彈性還取決於價格與數量位置。'],memory:['替代品多、非必需、占預算比高、調整期間長 → 通常較有彈性。']},
    6:{core:['價格上限低於均衡價才具約束力並造成短缺。','價格下限高於均衡價才具約束力並造成過剩。'],formula:['稅收＝每單位稅額×課後交易量。','稅負較多落在較無彈性的一方。'],graph:['稅在買方支付價與賣方實收價間形成稅楔；交易量下降。'],traps:['對買方或賣方課同額稅，均衡價格、數量與最終稅負相同。'],memory:['先畫無稅均衡，再加管制或稅；不要只記「課在誰身上」。']},
    7:{core:['消費者剩餘是支付意願減實付價格；生產者剩餘是價格減成本。','競爭均衡會完成支付意願高於成本的交易。'],formula:['總剩餘＝消費者剩餘＋生產者剩餘。'],graph:['需求線下、價格線上是消費者剩餘；價格線下、供給線上是生產者剩餘。'],traps:['總剩餘不是只看消費者，也不是只看生產者；兩者都要加總。'],memory:['產量低於有效率數量會漏掉互利交易；高於時會產生成本大於價值的交易。']},
    8:{core:['稅會縮小交易量，消失的互利交易形成無謂損失。','供給或需求越有彈性，課稅後數量改變通常越大。'],formula:['政府稅收＝T×Qtax；無謂損失來自交易量縮減，不等於稅收。'],graph:['稅收是稅楔乘課後數量的矩形；無謂損失是兩條曲線間的三角形。'],traps:['稅率提高不保證稅收增加；Q 可能下降得更快，形成拉弗曲線。'],memory:['完全無彈性的一側會承擔全部稅負，且若交易量不變便沒有無謂損失。']}
  };

  let wrongOverrides = {};
  const scopeKey = () => `econ848_wrong_overrides_${uxUser?.uid || 'guest'}`;
  const setLamp = (kind, text) => {
    const lamp = q('storageLamp'); if (!lamp) return;
    lamp.className = `storageLamp ${kind}`; lamp.lastElementChild.textContent = text;
  };
  const localPrefs = () => { try { return JSON.parse(localStorage.getItem(scopeKey()) || '{}'); } catch (_) { return {}; } };
  const persistPrefs = async () => {
    localStorage.setItem(scopeKey(), JSON.stringify(wrongOverrides));
    if (!uxUser || !uxDb) { setLamp('local', '本機已儲存'); return; }
    try {
      setLamp('pending', '正在同步…');
      await uxDb.collection('users').doc(uxUser.uid).collection('studySettings').doc('wrong-review').set({ uid: uxUser.uid, overrides: wrongOverrides, updatedAt: Date.now() });
      setLamp('saved', '雲端已同步');
    } catch (_) { setLamp('failed', '尚未同步／儲存失敗（本機保留）'); }
  };
  const loadPrefs = async () => {
    wrongOverrides = localPrefs();
    if (!uxUser || !uxDb) { setLamp('local', '本機已儲存'); return; }
    try {
      setLamp('pending', '載入雲端資料…');
      const row = await uxDb.collection('users').doc(uxUser.uid).collection('studySettings').doc('wrong-review').get();
      if (row.exists && row.data()?.overrides) wrongOverrides = row.data().overrides;
      localStorage.setItem(scopeKey(), JSON.stringify(wrongOverrides));
      setLamp('saved', '雲端已同步');
    } catch (_) { setLamp('failed', '雲端偏好讀取失敗（使用本機資料）'); }
  };
  function questionStats() {
    const map = new Map();
    const attempts = [...uxAllAttempts()].sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const attempt of attempts) for (const detail of uxDetails(attempt)) {
      if (!detail?.id) continue;
      const stat = map.get(detail.id) || { id: detail.id, attempts: 0, correct: 0, wrong: 0, streak: 0, lastCorrect: null, lastTs: 0 };
      stat.attempts++; stat.lastTs = Math.max(stat.lastTs, Number(attempt.ts) || 0);
      if (detail.correct) { stat.correct++; stat.streak++; stat.lastCorrect = true; }
      else { stat.wrong++; stat.streak = 0; stat.lastCorrect = false; }
      map.set(detail.id, stat);
    }
    return map;
  }
  const wrongEligible = (stat) => stat && stat.wrong > 0 && (wrongOverrides[stat.id] === 'keep' || (wrongOverrides[stat.id] !== 'remove' && stat.streak < 2));
  const wrongRows = () => [...questionStats().values()].filter(wrongEligible);
  const formatLatest = stat => stat?.attempts ? `最近一次：${stat.lastCorrect ? '答對' : '答錯'}` : '尚未練習';
  function injectHeader() {
    const top = document.querySelector('.topin'); if (!top || q('storageLamp')) return;
    const home = document.createElement('a'); home.className = 'studyHomeLink'; home.href = 'study-home.html'; home.textContent = '學習首頁';
    const lamp = document.createElement('span'); lamp.id = 'storageLamp'; lamp.className = 'storageLamp pending'; lamp.innerHTML = '<i></i><span>確認儲存狀態…</span>';
    top.querySelector('.grow')?.after(lamp, home);
    setLamp(uxUser ? 'saved' : 'local', uxUser ? '雲端已同步' : '本機已儲存');
  }
  function addQuestionStats() {
    const stats = questionStats();
    (cur.qs || []).forEach((question, index) => {
      const card = q(`card-${question.id}`); if (!card || card.querySelector('.questionPracticeStats')) return;
      const stat = stats.get(question.id) || { attempts: 0, wrong: 0, lastCorrect: null };
      const box = document.createElement('span'); box.className = 'questionPracticeStats';
      box.innerHTML = `<span>已練習 ${stat.attempts} 次</span><span>答錯 ${stat.wrong} 次</span><span>${formatLatest(stat)}</span>${stat.wrong ? `<button type="button" data-wrong-toggle="${question.id}">${wrongOverrides[question.id] === 'remove' ? '保留錯題' : '移出錯題'}</button>` : ''}`;
      card.querySelector('.qmeta')?.append(box);
    });
  }
  function setWrongOverride(id, next) {
    if (next === 'remove') wrongOverrides[id] = 'remove';
    else if (next === 'keep') wrongOverrides[id] = 'keep';
    else delete wrongOverrides[id];
    persistPrefs(); document.querySelectorAll('.questionPracticeStats').forEach(x => x.remove()); addQuestionStats();
  }
  const baseRenderExam = renderExam;
  renderExam = function enhancedRenderExam() { baseRenderExam(); addQuestionStats(); };
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-wrong-toggle]'); if (!button) return;
    const id = button.dataset.wrongToggle; setWrongOverride(id, wrongOverrides[id] === 'remove' ? 'keep' : 'remove');
  });

  const baseDetail = detailHTML;
  detailHTML = function detailedExplanation(question, submitted) {
    const original = baseDetail(question, submitted), kit = chapterNotes[question.chapter] || chapterNotes[1];
    const choices = question.options.map((option, index) => `<li class="${question.labels[index] === question.answer ? 'rightChoice' : ''}"><b>${question.labels[index]}.</b> ${esc(option)}${question.labels[index] === question.answer ? '：符合題幹的核心關係。' : '：請回到題幹條件，比較它是否符合正確的經濟關係。'}</li>`).join('');
    return `${original}<section class="expandedExplain"><h4>考點</h4><p>${esc(kit.core.join('　'))}</p><h4>解題關鍵</h4><p>${esc(question.aiExplanation || '先找出題幹中的變數、方向與限制，再以本章定義判斷。')}</p><h4>正確答案解析</h4><p>正解為 <b>${esc(answerText(question))}</b>。請將題幹逐一對照本章的定義、公式或圖形判讀。</p><h4>選項檢核</h4><ul>${choices}</ul><h4>觀念補充／公式／圖形判讀</h4><p>${esc(kit.formula.join('　'))}<br>${esc(kit.graph.join('　'))}</p><h4>易錯提醒</h4><p>${esc(kit.traps.join('　'))}</p></section>`;
  };

  function renderChapterNotes(chapter = 1) {
    const nav = q('reviewNav'), body = q('reviewBody'), kit = chapterNotes[chapter]; if (!nav || !body || !kit) return;
    nav.innerHTML = ''; for (let i = 1; i <= 8; i++) { const button = document.createElement('button'); button.textContent = `第 ${i} 章`; button.className = i === Number(chapter) ? 'on' : ''; button.onclick = () => renderChapterNotes(i); nav.append(button); }
    const section = (title, rows) => `<section class="chapterStudyBlock"><h3>${title}</h3><ul>${rows.map(row => `<li>${esc(row)}</li>`).join('')}</ul></section>`;
    body.innerHTML = `<div class="kicker">CHAPTER ${chapter} STUDY NOTES</div><h2>${esc(TITLES[chapter])}</h2><p class="chapterIntro">本區是閱讀用的章節複習整理；做題請從上方「分章節考試」進入。</p>${section('核心概念與關鍵名詞',kit.core)}${section('重要公式、符號與適用情境',kit.formula)}${section('常見圖形與判讀方式',kit.graph)}${section('易錯觀念與判斷技巧',kit.traps)}${section('必背重點與簡短例子',kit.memory)}`;
  }
  renderReview = renderChapterNotes; renderChapterNotes(1);

  function addWrongModal() {
    if (q('wrongConfig')) return;
    document.body.insertAdjacentHTML('beforeend', `<div class="modal" id="wrongConfig"><div class="modalBox wrongConfigBox"><h2>錯題重練設定</h2><p class="customHint">錯題會保留到同一題連續答對 2 次，或你手動移除為止。</p><div class="field"><label>章節範圍</label><div class="wrongChapters"><label><input type="checkbox" value="all" checked> 全部章節</label>${Array.from({length:8},(_,i)=>`<label><input type="checkbox" value="${i+1}" checked> 第 ${i+1} 章</label>`).join('')}</div></div><div class="formgrid"><div class="field"><label>題數</label><input id="wrongCount" type="number" min="1" placeholder="例如 5～10 題"><div class="quickCounts"><button type="button" data-count="5">5 題</button><button type="button" data-count="10">10 題</button><button type="button" data-count="20">20 題</button><button type="button" data-count="all">全部</button></div></div><div class="field"><label>題型</label><div class="checks" id="wrongTypes">${Object.entries(TYPE_LABELS).map(([id,label])=>`<label><input type="checkbox" value="${id}" checked> ${label}</label>`).join('')}</div></div><div class="field"><label>依據</label><select id="wrongBasis"><option value="all">全部錯題</option><option value="recent">最近答錯</option><option value="most">錯誤次數最多</option><option value="oldest">最久沒複習</option></select></div><div class="field"><label>題目順序</label><select id="wrongOrder"><option value="shuffle">隨機</option><option value="source">依原題號</option></select></div><div class="field"><label>作答模式</label><select id="wrongMode"><option value="exam">考試模式：交卷後看答案</option><option value="review">練習模式：作答後立即看詳解</option></select></div></div><p class="wrongCountHint" id="wrongCountHint"></p><div class="modalFoot"><button class="btn secondary" id="cancelWrongConfig">取消</button><button class="btn primary" id="beginWrongConfig">開始錯題重練</button></div></div></div>`);
    q('cancelWrongConfig').onclick = () => q('wrongConfig').classList.remove('show');
    q('wrongConfig').onclick = event => { if (event.target.id === 'wrongConfig') q('wrongConfig').classList.remove('show'); };
    q('wrongConfig').querySelectorAll('[data-count]').forEach(button => button.onclick = () => { q('wrongCount').value = button.dataset.count === 'all' ? '' : button.dataset.count; q('wrongCount').dataset.all = button.dataset.count === 'all' ? '1' : ''; updateWrongHint(); });
    q('wrongConfig').querySelectorAll('input,select').forEach(element => element.addEventListener('input', updateWrongHint));
    q('beginWrongConfig').onclick = beginWrongReview;
  }
  function selectedWrongRows() {
    const checked = [...q('wrongConfig').querySelectorAll('.wrongChapters input:checked')].map(x => x.value), all = checked.includes('all'), chapters = new Set(checked.map(Number));
    const types = new Set([...q('wrongTypes').querySelectorAll('input:checked')].map(x => x.value)); let rows = wrongRows().filter(row => { const question = uxQuestion(row.id); return question && (all || chapters.has(question.chapter)) && types.has(question.section); });
    const basis = q('wrongBasis').value;
    if (basis === 'recent') rows = rows.filter(row => row.lastCorrect === false).sort((a,b) => b.lastTs-a.lastTs);
    if (basis === 'most') rows.sort((a,b) => b.wrong-a.wrong || a.streak-b.streak || b.lastTs-a.lastTs);
    if (basis === 'oldest') rows.sort((a,b) => a.lastTs-b.lastTs);
    return rows;
  }
  function updateWrongHint() { const rows = selectedWrongRows(); q('wrongCountHint').textContent = `符合目前設定：${rows.length} 題；預設規則為同一題連續答對 2 次才會自動移出。`; }
  function openWrongReview() { addWrongModal(); updateWrongHint(); q('wrongConfig').classList.add('show'); }
  function beginWrongReview() {
    let rows = selectedWrongRows(), pool = rows.map(row => uxQuestion(row.id)).filter(Boolean); const requested = q('wrongCount').dataset.all === '1' ? pool.length : Number(q('wrongCount').value) || Math.min(10,pool.length);
    if (!pool.length) { alert('目前沒有符合設定的錯題。你可以調整章節、題型或依據。'); return; }
    if (q('wrongOrder').value === 'shuffle') pool = shuffle(pool); else pool.sort((a,b) => a.chapter-b.chapter || a.sourceNo-b.sourceNo);
    clearInterval(cur.timerId); cur = { qs: pool.slice(0,Math.min(requested,pool.length)).map(question => ({...question,user:null})), submitted:false, mode:q('wrongMode').value, timerOn:true, sec:0, timerId:null, title:'錯題重練', startedAt:Date.now(), whiteboard:{strokes:[],panelWidth:620,panelHeight:500} };
    q('wrongConfig').classList.remove('show'); q('home').classList.add('hidden'); q('dashboard').classList.add('hidden'); q('exam').classList.add('active'); renderExam(); startTimer(); uxSavePending(); window.scrollTo(0,0);
  }
  function patchWrongButtons() { q('wrongBtn').onclick = openWrongReview; q('profileWrongBtn').onclick = () => { uxCloseProfile(); openWrongReview(); }; }
  const baseProfile = uxRenderProfile;
  uxRenderProfile = function profileWithWrongRules() { baseProfile(); const rows = wrongRows(); const list = q('profileWrongList'); if (list) list.innerHTML = rows.length ? rows.slice(0,8).map(row => { const item = uxQuestion(row.id); return `<div class="profileListItem"><b>第 ${item?.chapter || '—'} 章｜${esc(item?.sectionName || '')}</b><span>已練習 ${row.attempts} 次｜答錯 ${row.wrong} 次｜${formatLatest(row)}</span></div>`; }).join('') : '<div class="empty">目前沒有待複習錯題。</div>'; q('profileWrongBtn').disabled = !rows.length; patchWrongButtons(); };

  function verifyDraft(id, stamp) {
    if (!uxUser || !uxDb || !id) { setLamp('local', '本機已儲存'); return; }
    setTimeout(async () => { try { const row = await uxDb.collection('users').doc(uxUser.uid).collection('attempts').doc(String(id)).get(); if (row.exists && Number(row.data()?.updatedAt || 0) >= stamp) setLamp('saved', '雲端已同步'); else setLamp('failed', '尚未同步／儲存失敗（本機保留）'); } catch (_) { setLamp('failed', '尚未同步／儲存失敗（本機保留）'); } }, 850);
  }
  const baseSavePending = uxSavePending;
  uxSavePending = function savedWithSignal() { const stamp = Date.now(); setLamp(uxUser ? 'pending' : 'local', uxUser ? '正在同步…' : '本機已儲存'); const result = baseSavePending.apply(this, arguments); verifyDraft(cur.draftId, stamp); return result; };
  const baseSubmit = uxSubmit;
  uxSubmit = function submittedWithSignal() { setLamp(uxUser ? 'pending' : 'local', uxUser ? '正在同步…' : '本機已儲存'); const result = baseSubmit.apply(this, arguments); const attempt = state().attempts?.[state().attempts.length-1]; if (uxUser && uxDb && attempt?.ts) setTimeout(async () => { try { const row = await uxDb.collection('users').doc(uxUser.uid).collection('attempts').doc(String(attempt.ts)).get(); setLamp(row.exists ? 'saved' : 'failed', row.exists ? '雲端已同步' : '尚未同步／儲存失敗（本機保留）'); } catch (_) { setLamp('failed','尚未同步／儲存失敗（本機保留）'); } }, 850); return result; };
  q('submitBtn').onclick = uxSubmit;
  q('qList').addEventListener('change', () => setTimeout(addQuestionStats, 0));
  uxAuth?.onAuthStateChanged(async () => { injectHeader(); await loadPrefs(); patchWrongButtons(); renderChapterNotes(1); });
  injectHeader(); addWrongModal(); patchWrongButtons();
})();
