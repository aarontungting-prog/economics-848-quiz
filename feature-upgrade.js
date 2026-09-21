(function () {
  "use strict";

  const visuals = window.QUESTION_VISUALS || {};
  let cloudTombstones = {};
  let historyAttempt = null;
  let drawingMode = "select";
  let drawingColor = "#1f2937";
  let drawingWidth = 4;
  let activePointer = null;
  let drawingObserver = null;
  let saveNotesTimer = null;

  function clone(value) {
    try {
      return structuredClone(value);
    } catch (_) {
      return JSON.parse(JSON.stringify(value || {}));
    }
  }

  function localPendingRows() {
    const raw = state().pending;
    if (Array.isArray(raw)) return raw.filter((p) => p?.qs?.length);
    if (raw?.qs?.length) {
      return [{ ...raw, id: raw.id || `legacy-${raw.startedAt || raw.updatedAt || Date.now()}` }];
    }
    return [];
  }

  function localTombstones() {
    const rows = state().draftTombstones;
    return rows && typeof rows === "object" ? rows : {};
  }

  function allTombstones() {
    return { ...cloudTombstones, ...localTombstones() };
  }

  function compactNotes(notes) {
    const output = {};
    let pointBudget = 12000;
    for (const [questionId, note] of Object.entries(notes || {})) {
      const strokes = [];
      for (const stroke of note?.strokes || []) {
        if (pointBudget <= 0) break;
        const points = [];
        const source = stroke.points || [];
        const step = Math.max(1, Math.ceil(source.length / Math.max(1, pointBudget)));
        for (let i = 0; i < source.length && pointBudget > 0; i += step) {
          const point = source[i];
          points.push([
            Math.max(0, Math.min(1, Math.round(Number(point[0]) * 10000) / 10000)),
            Math.max(0, Math.min(1, Math.round(Number(point[1]) * 10000) / 10000)),
          ]);
          pointBudget--;
        }
        if (points.length) {
          strokes.push({ color: stroke.color || "#1f2937", width: Number(stroke.width) || 4, points });
        }
      }
      if (strokes.length) {
        output[questionId] = {
          ratio: Math.max(0.15, Math.min(4, Number(note.ratio) || 0.55)),
          strokes,
        };
      }
    }
    return output;
  }

  function mergedPendingRows() {
    const deleted = allTombstones();
    const byId = new Map();
    for (const row of [...(uxCloudDrafts || []), ...localPendingRows()]) {
      if (!row?.qs?.length) continue;
      const id = uxPendingId(row);
      if (deleted[id]) continue;
      const previous = byId.get(id);
      if (!previous || Number(row.updatedAt || 0) >= Number(previous.updatedAt || 0)) byId.set(id, row);
    }
    return [...byId.values()];
  }

  function writePendingRows(rows) {
    const s = state();
    if (rows.length) s.pending = rows;
    else delete s.pending;
    save(s);
  }

  function writeLocalTombstone(id, timestamp) {
    const s = state();
    s.draftTombstones = { ...(s.draftTombstones || {}), [String(id)]: Number(timestamp) || Date.now() };
    if (Array.isArray(s.pending)) s.pending = s.pending.filter((p) => uxPendingId(p) !== String(id));
    else if (s.pending?.qs?.length && uxPendingId(s.pending) === String(id)) delete s.pending;
    save(s);
  }

  function syncDraft(record) {
    if (!uxUser || !uxDb || !record?.id || allTombstones()[String(record.id)]) return;
    const payload = { ...record, kind: "draft", uid: uxUser.uid };
    uxDb.collection("users").doc(uxUser.uid).collection("attempts").doc(String(record.id)).set(payload)
      .then(() => {
        if (!allTombstones()[String(record.id)]) {
          uxCloudDrafts = [payload, ...uxCloudDrafts.filter((x) => uxPendingId(x) !== String(record.id))];
        }
      })
      .catch((error) => uxSetStatus("未完成進度已保存在本機，雲端同步失敗：" + uxFriendlyError(error), true));
  }

  function syncTombstone(id, deletedAt) {
    if (!uxUser || !uxDb || !id) return Promise.resolve();
    const key = String(id);
    const payload = { kind: "draft_tombstone", draftId: key, deletedAt, ts: deletedAt, uid: uxUser.uid };
    return uxDb.collection("users").doc(uxUser.uid).collection("attempts").doc(`deleted-${key}`).set(payload)
      .then(() => {
        cloudTombstones[key] = deletedAt;
        return uxDb.collection("users").doc(uxUser.uid).collection("attempts").doc(key).delete();
      })
      .catch((error) => uxSetStatus("已在此裝置放棄考卷，雲端刪除將於下次連線重試：" + uxFriendlyError(error), true));
  }

  function abandonDraft(id) {
    const key = String(id || cur.draftId || "");
    if (!key) return;
    const deletedAt = Date.now();
    writeLocalTombstone(key, deletedAt);
    cloudTombstones[key] = deletedAt;
    uxCloudDrafts = (uxCloudDrafts || []).filter((row) => uxPendingId(row) !== key);
    if (String(cur.draftId || "") === key) cur.draftId = null;
    syncTombstone(key, deletedAt);
    uxRenderPending();
    uxRenderDashboard();
  }

  function savePending() {
    if (!cur.qs?.length || cur.submitted) return;
    cur.draftId = cur.draftId || `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id: cur.draftId,
      title: cur.title,
      mode: cur.mode,
      timerOn: cur.timerOn,
      sec: Number(cur.sec) || 0,
      startedAt: cur.startedAt || Date.now(),
      updatedAt: Date.now(),
      qs: cur.qs.map((q) => ({ id: q.id, user: q.user ?? null })),
      notes: compactNotes(cur.notes || {}),
    };
    const rows = localPendingRows();
    const index = rows.findIndex((row) => uxPendingId(row) === String(record.id));
    if (index >= 0) rows[index] = record;
    else rows.push(record);
    writePendingRows(rows);
    uxCloudDrafts = [record, ...(uxCloudDrafts || []).filter((row) => uxPendingId(row) !== String(record.id))];
    syncDraft(record);
    uxRenderPending();
  }

  async function loadCloud() {
    if (!uxUser || !uxDb) {
      uxCloudAttempts = [];
      uxCloudDrafts = [];
      cloudTombstones = {};
      uxRenderDashboard();
      uxRenderPending();
      return;
    }
    try {
      const snapshot = await uxDb.collection("users").doc(uxUser.uid).collection("attempts").get();
      const rows = snapshot.docs.map((document) => document.data()).filter(Boolean);
      cloudTombstones = {};
      for (const row of rows) {
        if (row.kind === "draft_tombstone" && row.draftId) {
          cloudTombstones[String(row.draftId)] = Number(row.deletedAt || row.ts) || Date.now();
        }
      }
      const deleted = allTombstones();
      uxCloudAttempts = rows
        .filter((row) => row?.ts && row.kind !== "draft" && row.kind !== "draft_tombstone")
        .sort((a, b) => b.ts - a.ts);
      uxCloudDrafts = rows.filter((row) => row.kind === "draft" && row.qs?.length && !deleted[uxPendingId(row)]);
      for (const [id, deletedAt] of Object.entries(localTombstones())) {
        if (!cloudTombstones[id]) syncTombstone(id, deletedAt);
      }
      uxRenderDashboard();
      uxRenderPending();
    } catch (error) {
      uxSetStatus("已登入，但雲端資料讀取失敗：" + uxFriendlyError(error), true);
    }
  }

  function continueDraft(id) {
    const pending = mergedPendingRows().find((row) => uxPendingId(row) === String(id));
    if (!pending?.qs?.length) return;
    const picked = pending.qs.map((savedQuestion) => {
      const question = uxQuestion(savedQuestion.id);
      return question ? { ...question, user: savedQuestion.user ?? null } : null;
    }).filter(Boolean);
    if (!picked.length) {
      abandonDraft(id);
      return;
    }
    clearInterval(cur.timerId);
    cur = {
      qs: picked,
      submitted: false,
      mode: pending.mode || "exam",
      timerOn: pending.timerOn !== false,
      sec: Number(pending.sec) || 0,
      timerId: null,
      title: pending.title || "未完成練習",
      startedAt: pending.startedAt,
      draftId: uxPendingId(pending),
      notes: clone(pending.notes || {}),
    };
    uxEl("home").classList.add("hidden");
    uxEl("dashboard").classList.add("hidden");
    uxEl("exam").classList.add("active");
    renderExam();
    uxRestoreRenderedAnswers();
    startTimer();
    savePending();
    window.scrollTo(0, 0);
  }

  function addQuestionVisuals() {
    for (const question of cur.qs || []) {
      const source = visuals[question.id];
      const card = uxEl(`card-${question.id}`);
      if (!card) continue;
      card.querySelector(".visualBox")?.remove();
      if (!source || card.querySelector(".questionSourceVisual")) continue;
      const figure = document.createElement("figure");
      figure.className = "questionSourceVisual";
      figure.innerHTML = `<figcaption>原題圖表（取自題庫 PDF）</figcaption><img loading="lazy" src="${source}" alt="第 ${question.chapter} 章第 ${question.sourceNo} 題原始圖表">`;
      const options = card.querySelector(".opts");
      if (options) card.insertBefore(figure, options);
      else card.appendChild(figure);
    }
  }

  function noteFor(questionId) {
    cur.notes = cur.notes || {};
    const key = String(questionId);
    cur.notes[key] = cur.notes[key] || { ratio: 0.55, strokes: [] };
    return cur.notes[key];
  }

  function renderStrokes(canvas, note) {
    if (!canvas || !note) return;
    const context = canvas.getContext("2d");
    const box = canvas.getBoundingClientRect();
    const scale = Math.min(1.5, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(box.width * scale));
    const height = Math.max(1, Math.round(box.height * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.clearRect(0, 0, width, height);
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of note.strokes || []) {
      const points = stroke.points || [];
      if (!points.length) continue;
      context.beginPath();
      context.strokeStyle = stroke.color || "#1f2937";
      context.lineWidth = (Number(stroke.width) || 4) * scale;
      context.moveTo(points[0][0] * width, points[0][1] * height);
      for (let index = 1; index < points.length; index++) {
        context.lineTo(points[index][0] * width, points[index][1] * height);
      }
      if (points.length === 1) context.lineTo(points[0][0] * width + 0.1, points[0][1] * height + 0.1);
      context.stroke();
    }
  }

  function canvasPoint(canvas, event) {
    const box = canvas.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (event.clientX - box.left) / Math.max(1, box.width))),
      Math.max(0, Math.min(1, (event.clientY - box.top) / Math.max(1, box.height))),
    ];
  }

  function eraseAt(canvas, note, point) {
    const box = canvas.getBoundingClientRect();
    const radius = 18 / Math.max(1, Math.min(box.width, box.height));
    const before = note.strokes.length;
    note.strokes = note.strokes.filter((stroke) => !(stroke.points || []).some((candidate) => {
      const dx = candidate[0] - point[0];
      const dy = candidate[1] - point[1];
      return Math.sqrt(dx * dx + dy * dy) <= radius;
    }));
    if (before !== note.strokes.length) {
      renderStrokes(canvas, note);
      scheduleNoteSave();
    }
  }

  function onPointerDown(event) {
    if (drawingMode === "select" || cur.submitted) return;
    const canvas = event.currentTarget;
    const questionId = canvas.dataset.questionId;
    const note = noteFor(questionId);
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const point = canvasPoint(canvas, event);
    if (drawingMode === "erase") {
      activePointer = { pointerId: event.pointerId, canvas, note, erase: true };
      eraseAt(canvas, note, point);
      return;
    }
    const stroke = { color: drawingColor, width: drawingWidth, points: [point] };
    note.strokes.push(stroke);
    activePointer = { pointerId: event.pointerId, canvas, note, stroke };
    renderStrokes(canvas, note);
  }

  function onPointerMove(event) {
    if (!activePointer || activePointer.pointerId !== event.pointerId || activePointer.canvas !== event.currentTarget) return;
    event.preventDefault();
    const point = canvasPoint(activePointer.canvas, event);
    if (activePointer.erase) eraseAt(activePointer.canvas, activePointer.note, point);
    else {
      const points = activePointer.stroke.points;
      const previous = points[points.length - 1];
      if (!previous || Math.abs(previous[0] - point[0]) + Math.abs(previous[1] - point[1]) > 0.0015) {
        points.push(point);
        renderStrokes(activePointer.canvas, activePointer.note);
      }
    }
  }

  function onPointerUp(event) {
    if (!activePointer || activePointer.pointerId !== event.pointerId) return;
    activePointer = null;
    scheduleNoteSave();
  }

  function ensureCanvas(card) {
    if (!card || card.querySelector(".drawingLayer")) return;
    const questionId = String(card.id || "").replace(/^card-/, "");
    if (!questionId) return;
    const existing = cur.notes?.[questionId];
    const note = existing || { ratio: Math.max(0.2, card.offsetHeight / Math.max(1, card.offsetWidth)), strokes: [] };
    if (existing) cur.notes[questionId] = note;
    const layer = document.createElement("div");
    layer.className = "drawingLayer";
    layer.style.height = `${Math.max(80, Math.round(card.clientWidth * (Number(note.ratio) || 0.55)))}px`;
    const canvas = document.createElement("canvas");
    canvas.dataset.questionId = questionId;
    canvas.setAttribute("aria-label", `第 ${questionId} 題手寫畫布`);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    layer.appendChild(canvas);
    card.appendChild(layer);
    requestAnimationFrame(() => renderStrokes(canvas, note));
  }

  function removeCanvas(card) {
    if (activePointer?.canvas?.closest(".qcard") === card) return;
    card.querySelector(".drawingLayer")?.remove();
  }

  function installDrawingCards() {
    cur.notes = cur.notes || {};
    if (drawingObserver) drawingObserver.disconnect();
    drawingObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) ensureCanvas(entry.target);
        else removeCanvas(entry.target);
      }
    }, { rootMargin: "350px 0px" });
    document.querySelectorAll("#qList .qcard").forEach((card) => {
      card.classList.add("drawableCard");
      drawingObserver.observe(card);
    });
    updateCanvasInteraction();
  }

  function updateCanvasInteraction() {
    document.body.dataset.drawingMode = drawingMode;
    document.querySelectorAll(".drawingTools [data-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === drawingMode);
    });
    const label = uxEl("drawingStatus");
    if (label) {
      label.textContent = drawingMode === "select" ? "選擇答案模式" : drawingMode === "pen" ? "畫筆模式：可直接在題目上書寫" : "橡皮擦模式";
    }
  }

  function scheduleNoteSave() {
    clearTimeout(saveNotesTimer);
    saveNotesTimer = setTimeout(() => {
      savePending();
      const label = uxEl("drawingSaveState");
      if (label) {
        label.textContent = uxUser ? "筆記已同步" : "筆記已儲存在此瀏覽器";
        setTimeout(() => { if (label) label.textContent = ""; }, 1800);
      }
    }, 350);
  }

  function currentQuestionCard() {
    const cards = [...document.querySelectorAll("#qList .qcard")];
    if (!cards.length) return null;
    const center = window.innerHeight / 2;
    return cards.reduce((best, card) => {
      const box = card.getBoundingClientRect();
      const distance = Math.abs((box.top + box.bottom) / 2 - center);
      return !best || distance < best.distance ? { card, distance } : best;
    }, null)?.card || null;
  }

  function clearCurrentNote() {
    const card = currentQuestionCard();
    if (!card) {
      alert("請先開始一份練習。");
      return;
    }
    const id = card.id.replace(/^card-/, "");
    if (!cur.notes?.[id]?.strokes?.length) {
      alert("目前這一題沒有手寫內容。");
      return;
    }
    if (!confirm("確定清除目前這一題的手寫筆記？此動作無法復原。")) return;
    delete cur.notes[id];
    removeCanvas(card);
    ensureCanvas(card);
    scheduleNoteSave();
  }

  function preparePrintCanvases() {
    if (document.body.classList.contains("printExam")) {
      for (const id of Object.keys(cur.notes || {})) ensureCanvas(uxEl(`card-${id}`));
    }
  }

  function exportPdf() {
    const showingHistory = uxEl("historyModal")?.classList.contains("show") && !uxEl("historyDetail")?.classList.contains("hidden");
    const showingExam = uxEl("exam")?.classList.contains("active");
    if (!showingHistory && !showingExam) {
      alert("請先開啟作答中的考卷或一筆歷史紀錄。");
      return;
    }
    document.body.classList.add(showingHistory ? "printHistory" : "printExam");
    preparePrintCanvases();
    const label = uxEl("drawingSaveState");
    if (label) label.textContent = "列印視窗開啟後，請選擇「另存為 PDF」";
    setTimeout(() => window.print(), 80);
  }

  function installDrawingTools() {
    if (uxEl("drawingTools")) return;
    const panel = document.createElement("aside");
    panel.id = "drawingTools";
    panel.className = "drawingTools";
    panel.setAttribute("aria-label", "作答工具");
    panel.innerHTML = `
      <div class="drawingToolsHead"><strong>作答工具</strong><button type="button" class="toolIcon" id="closeDrawingTools" aria-label="收合作答工具">×</button></div>
      <div class="drawingToolRow drawingModes">
        <button type="button" data-mode="select">選擇答案</button>
        <button type="button" data-mode="pen">畫筆</button>
        <button type="button" data-mode="erase">橡皮擦</button>
      </div>
      <div class="drawingToolRow colors" aria-label="筆色">
        <button type="button" class="colorDot active" data-color="#1f2937" style="--ink:#1f2937" aria-label="黑色"></button>
        <button type="button" class="colorDot" data-color="#dc2626" style="--ink:#dc2626" aria-label="紅色"></button>
        <button type="button" class="colorDot" data-color="#2563eb" style="--ink:#2563eb" aria-label="藍色"></button>
        <button type="button" class="colorDot" data-color="#15803d" style="--ink:#15803d" aria-label="綠色"></button>
        <label class="widthControl">粗細 <input id="drawingWidth" type="range" min="2" max="12" value="4"></label>
      </div>
      <div class="drawingToolRow">
        <button type="button" id="clearCurrentNote">清除本題</button>
        <button type="button" class="primaryTool" id="exportExamPdf">匯出 PDF</button>
      </div>
      <small id="drawingStatus">選擇答案模式</small><small id="drawingSaveState"></small>`;
    document.body.appendChild(panel);
    uxEl("closeDrawingTools").onclick = () => {
      panel.classList.remove("open");
      drawingMode = "select";
      updateCanvasInteraction();
    };
    panel.querySelectorAll("[data-mode]").forEach((button) => button.onclick = () => {
      drawingMode = button.dataset.mode;
      updateCanvasInteraction();
    });
    panel.querySelectorAll("[data-color]").forEach((button) => button.onclick = () => {
      drawingColor = button.dataset.color;
      panel.querySelectorAll("[data-color]").forEach((item) => item.classList.toggle("active", item === button));
      drawingMode = "pen";
      updateCanvasInteraction();
    });
    uxEl("drawingWidth").oninput = (event) => { drawingWidth = Number(event.target.value) || 4; };
    uxEl("clearCurrentNote").onclick = clearCurrentNote;
    uxEl("exportExamPdf").onclick = exportPdf;
  }

  function openDrawingTools() {
    const panel = uxEl("drawingTools");
    panel.classList.toggle("open");
    if (!uxEl("exam")?.classList.contains("active") && !uxEl("historyModal")?.classList.contains("show")) {
      uxEl("drawingStatus").textContent = "開始練習後即可在題目上書寫";
    } else updateCanvasInteraction();
  }

  const baseRenderExam = renderExam;
  renderExam = function renderExamWithVisualsAndNotes() {
    baseRenderExam();
    cur.notes = cur.notes || {};
    addQuestionVisuals();
    installDrawingCards();
  };

  const baseBegin = uxBegin;
  uxBegin = function beginWithNotes() {
    baseBegin();
    if (cur.qs?.length) {
      cur.notes = {};
      installDrawingCards();
      savePending();
    }
  };

  const baseRepeat = uxRepeat;
  uxRepeat = function repeatWithSeparateNotes() {
    const wasSubmitted = !!cur.submitted;
    baseRepeat();
    if (wasSubmitted && cur.qs?.length) {
      cur.notes = {};
      installDrawingCards();
      savePending();
    }
  };

  const baseSubmit = uxSubmit;
  uxSubmit = function submitWithNotes() {
    const notes = compactNotes(cur.notes || {});
    const draftId = cur.draftId;
    baseSubmit();
    if (!cur.submitted) return;
    const s = state();
    const attempt = s.attempts?.[s.attempts.length - 1];
    if (attempt) {
      attempt.notes = notes;
      save(s);
      uxSyncAttempt(attempt);
      uxRenderDashboard();
    }
    if (draftId) abandonDraft(draftId);
  };

  const baseExit = uxExit;
  uxExit = function exitWithNotes() {
    if (cur.qs?.length && !cur.submitted) savePending();
    baseExit();
    drawingMode = "select";
    uxEl("drawingTools")?.classList.remove("open");
    updateCanvasInteraction();
  };

  const baseShowHistory = uxShowHistory;
  uxShowHistory = function showHistoryWithVisualsAndNotes(timestamp) {
    baseShowHistory(timestamp);
    historyAttempt = uxAllAttempts().find((row) => Number(row.ts) === Number(timestamp)) || null;
    const details = historyAttempt ? uxDetails(historyAttempt) : [];
    const cards = [...document.querySelectorAll("#historyQuestionList .historyQuestion")];
    cards.forEach((card, index) => {
      const detail = details[index];
      const question = detail ? uxQuestion(detail.id) : null;
      const source = question ? visuals[question.id] : null;
      if (source && !card.querySelector(".historySourceVisual")) {
        const figure = document.createElement("figure");
        figure.className = "questionSourceVisual historySourceVisual";
        figure.innerHTML = `<figcaption>原題圖表（取自題庫 PDF）</figcaption><img src="${source}" alt="原始題目圖表">`;
        card.querySelector("p")?.insertAdjacentElement("afterend", figure);
      }
      const note = detail ? historyAttempt?.notes?.[detail.id] : null;
      if (note?.strokes?.length) {
        const section = document.createElement("section");
        section.className = "historyHandwriting";
        section.innerHTML = `<strong>當時的手寫筆記</strong><div class="historyCanvasWrap"><canvas aria-label="當時的手寫筆記"></canvas></div>`;
        card.appendChild(section);
        const wrap = section.querySelector(".historyCanvasWrap");
        wrap.style.aspectRatio = `1 / ${Number(note.ratio) || 0.55}`;
        requestAnimationFrame(() => renderStrokes(section.querySelector("canvas"), note));
      }
    });
    let exportButton = uxEl("historyExportPdf");
    if (!exportButton) {
      exportButton = document.createElement("button");
      exportButton.id = "historyExportPdf";
      exportButton.className = "btn primary";
      exportButton.textContent = "匯出 PDF";
      exportButton.onclick = exportPdf;
      uxEl("closeHistoryDetail")?.insertAdjacentElement("beforebegin", exportButton);
    }
  };

  const baseRenderDashboard = uxRenderDashboard;
  uxRenderDashboard = function renderDashboardWithSafeDraftActions() {
    baseRenderDashboard();
    const list = uxEl("historyList");
    list?.querySelectorAll("[data-history-ts]").forEach((button) => button.onclick = () => uxShowHistory(Number(button.dataset.historyTs)));
    list?.querySelectorAll("[data-history-pending-continue]").forEach((button) => button.onclick = () => continueDraft(button.dataset.historyPendingContinue));
    list?.querySelectorAll("[data-history-pending-discard]").forEach((button) => button.onclick = () => {
      if (confirm("確定放棄這份未完成練習？作答進度將會從本機與雲端移除。")) abandonDraft(button.dataset.historyPendingDiscard);
    });
  };

  function installProfileLogout() {
    if (uxEl("profileLogoutBtn")) return;
    const button = document.createElement("button");
    button.id = "profileLogoutBtn";
    button.className = "btn danger";
    button.textContent = "登出並切換帳號";
    button.onclick = () => {
      if (cur.qs?.length && !cur.submitted) savePending();
      if (uxAuth) uxAuth.signOut().finally(uxGoLogin);
      else uxGoLogin();
    };
    uxEl("closeProfile")?.insertAdjacentElement("beforebegin", button);
  }

  installDrawingTools();
  installProfileLogout();
  uxEl("totalTop").textContent = "作答工具";
  uxEl("totalTop").onclick = openDrawingTools;
  uxEl("startExam").onclick = uxBegin;
  uxEl("submitBtn").onclick = uxSubmit;
  uxEl("exitBtn").onclick = uxExit;
  uxEl("repeatBtn").onclick = uxRepeat;
  uxEl("continuePending").onclick = () => {
    const pending = mergedPendingRows()[0];
    if (pending) continueDraft(uxPendingId(pending));
  };
  uxEl("discardPending").onclick = () => {
    const pending = mergedPendingRows()[0];
    if (pending && confirm("確定放棄這份未完成練習？作答進度將會從本機與雲端移除。")) abandonDraft(uxPendingId(pending));
  };
  uxEl("pendingItems")?.addEventListener("click", (event) => {
    const continueButton = event.target.closest("[data-pending-continue]");
    const discardButton = event.target.closest("[data-pending-discard]");
    if (!continueButton && !discardButton) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (continueButton) continueDraft(continueButton.dataset.pendingContinue);
    if (discardButton && confirm("確定放棄這份未完成練習？作答進度將會從本機與雲端移除。")) abandonDraft(discardButton.dataset.pendingDiscard);
  }, true);

  uxPendingList = mergedPendingRows;
  uxSavePending = savePending;
  uxSavePending2 = savePending;
  uxSavePending3 = savePending;
  uxClearPending = abandonDraft;
  uxClearPending2 = abandonDraft;
  uxClearPending3 = abandonDraft;
  uxContinue = continueDraft;
  uxContinue2 = continueDraft;
  uxContinue3 = continueDraft;
  uxSyncDraft = syncDraft;
  uxDeleteDraft = abandonDraft;
  uxDeleteDraft2 = abandonDraft;
  uxLoadCloud = loadCloud;
  uxLoadCloud2 = loadCloud;
  uxLoadCloud3 = loadCloud;

  window.addEventListener("resize", () => {
    clearTimeout(window.__econCanvasResizeTimer);
    window.__econCanvasResizeTimer = setTimeout(() => {
      document.querySelectorAll("#qList .drawingLayer").forEach((layer) => {
        const card = layer.closest(".qcard");
        const id = card?.id.replace(/^card-/, "");
        const note = cur.notes?.[id];
        if (!card || !note) return;
        layer.style.height = `${Math.max(80, Math.round(card.clientWidth * (Number(note.ratio) || 0.55)))}px`;
        renderStrokes(layer.querySelector("canvas"), note);
      });
    }, 120);
  });
  window.addEventListener("afterprint", () => document.body.classList.remove("printExam", "printHistory"));
  window.addEventListener("beforeunload", () => { if (cur.qs?.length && !cur.submitted) savePending(); });

  uxRenderDashboard();
  uxRenderPending();
  if (uxUser && uxDb) loadCloud();
})();
