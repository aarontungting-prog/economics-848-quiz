(() => {
  const DRAFT_KEY = "econ_full_848_draft_v2";
  const getDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; } };
  const updateDraftCard = () => {
    const d = getDraft(), card = document.getElementById("draftCard");
    if (!card) return;
    if (!d?.ids?.length) { card.classList.add("hidden"); return; }
    const answered = Object.keys(d.answers || {}).length;
    const when = d.savedAt ? new Date(d.savedAt).toLocaleString("zh-TW", {month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "上次";
    document.getElementById("draftMeta").textContent = `${d.title || "未完成練習"}｜已答 ${answered} / ${d.ids.length} 題｜${when} 保存`;
    card.classList.remove("hidden");
  };
  const saveDraft = () => {
    if (cur.submitted || !cur.qs.length) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        ids: cur.qs.map(q => q.id),
        answers: Object.fromEntries(cur.qs.filter(q => q.user !== null).map(q => [q.id, q.user])),
        mode: cur.mode, timerOn: cur.timerOn, sec: cur.sec, title: cur.title, savedAt: Date.now()
      }));
      updateDraftCard();
    } catch {}
  };
  const clearDraft = () => { localStorage.removeItem(DRAFT_KEY); updateDraftCard(); };
  const resumeDraft = () => {
    const d = getDraft();
    if (!d?.ids?.length) return updateDraftCard();
    const map = new Map(QUESTIONS.map(q => [q.id, q]));
    cur.qs = d.ids.map(id => map.get(id)).filter(Boolean).map(q => ({...q, user:d.answers?.[q.id] ?? null}));
    if (!cur.qs.length) { clearDraft(); return alert("找不到上次的題目，請重新出題。"); }
    cur.submitted = false; cur.mode = d.mode || "exam"; cur.timerOn = d.timerOn !== false;
    cur.sec = Number(d.sec) || 0; cur.title = d.title || "繼續上次練習";
    document.getElementById("home").classList.add("hidden");
    document.getElementById("exam").classList.add("active");
    renderExam(); startTimer(); window.scrollTo(0,0);
  };

  const hero = document.querySelector(".hero");
  if (hero) hero.insertAdjacentHTML("afterend", '<div class="card draftCard hidden" id="draftCard"><div class="draftText"><strong>你有一份尚未完成的練習</strong><p id="draftMeta">上次進度已自動保存。</p></div><button class="btn primary" id="resumeBtn">繼續作答</button></div>');
  document.getElementById("resumeBtn")?.addEventListener("click", resumeDraft);

  const originalProgress = progress;
  progress = function() {
    cur.qs.forEach(q => {
      if (q.user === null) return;
      const card = document.getElementById("card-" + q.id);
      const input = card?.querySelector(`input[value="${q.user}"]`);
      if (input && !input.checked) { input.checked = true; input.closest(".opt")?.classList.add("sel"); }
      if (card && cur.mode === "review" && !cur.submitted && !card.querySelector(".detail.show")) showDetail(q, card, false);
    });
    originalProgress();
    if (!cur.submitted) saveDraft();
  };

  startTimer = function() {
    clearInterval(cur.timerId);
    const timer = document.getElementById("timer");
    const paint = () => {
      const m = String(Math.floor(cur.sec / 60)).padStart(2,"0");
      const s = String(cur.sec % 60).padStart(2,"0");
      timer.textContent = m + ":" + s;
    };
    if (!cur.timerOn) { timer.textContent = "不計時"; return; }
    paint();
    cur.timerId = setInterval(() => { cur.sec++; paint(); if (cur.sec % 5 === 0) saveDraft(); }, 1000);
  };

  const originalExit = exitExam;
  document.getElementById("exitBtn").onclick = () => { if (!cur.submitted) saveDraft(); originalExit(); updateDraftCard(); };
  const originalRepeat = repeat;
  document.getElementById("repeatBtn").onclick = () => { originalRepeat(); if (!cur.submitted) saveDraft(); };
  document.getElementById("submitBtn").addEventListener("click", () => { if (cur.submitted) clearDraft(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && !cur.submitted) saveDraft(); });
  window.addEventListener("beforeunload", () => { if (!cur.submitted) saveDraft(); });

  const footer = document.querySelector("footer");
  if (footer) footer.textContent = '題目、題庫答案與「題庫原始詳解」取自你提供的《Chapter 1-8 習題題庫.pdf》。標示「網站整理詳解」的文字是為方便複習而整理，並非 PDF 原文。作答與未完成進度只存於目前裝置；加入手機主畫面後可像 App 一樣開啟，載入過一次後亦可離線練習。';

  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  updateDraftCard();
})();