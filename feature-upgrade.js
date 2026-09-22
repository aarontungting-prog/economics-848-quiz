(function () {
  "use strict";

  const visuals = window.QUESTION_VISUALS || {};
  const ACTIVE_SCOPE_KEY = "econ848_active_scope_v1";
  const SCOPED_STATE_PREFIX = "econ848_state_scope_v1_";
  const SESSION_PASSWORD_KEY = "econ848_session_password";
  const EMPTY_STATE = { attempts: [], wrong: [], draftTombstones: {} };
  let cloudTombstones = {};
  let historyAttempt = null;
  let boardMode = "pen";
  let boardColor = "#1f2937";
  let boardWidth = 4;
  let activeStroke = null;
  let boardSaveTimer = null;
  let boardResizeObserver = null;
  let dragState = null;

  function clone(value) {
    try { return structuredClone(value); }
    catch (_) { return JSON.parse(JSON.stringify(value || {})); }
  }

  function blankBoard() {
    return { strokes: [], panelWidth: 620, panelHeight: 500 };
  }

  function compactBoard(board) {
    const output = {
      strokes: [],
      panelWidth: Math.max(320, Math.min(920, Number(board?.panelWidth) || 620)),
      panelHeight: Math.max(320, Math.min(760, Number(board?.panelHeight) || 500)),
    };
    let pointBudget = 10000;
    for (const stroke of board?.strokes || []) {
      if (pointBudget <= 0) break;
      const source = stroke.points || [];
      const step = Math.max(1, Math.ceil(source.length / Math.max(1, pointBudget)));
      const points = [];
      for (let index = 0; index < source.length && pointBudget > 0; index += step) {
        const point = source[index];
        points.push([
          Math.max(0, Math.min(1, Math.round(Number(point[0]) * 10000) / 10000)),
          Math.max(0, Math.min(1, Math.round(Number(point[1]) * 10000) / 10000)),
        ]);
        pointBudget--;
      }
      if (points.length) output.strokes.push({ color: stroke.color || "#1f2937", width: Number(stroke.width) || 4, points });
    }
    return output;
  }

  function localPendingRows() {
    const raw = state().pending;
    if (Array.isArray(raw)) return raw.filter((row) => row?.qs?.length);
    if (raw?.qs?.length) return [{ ...raw, id: raw.id || `legacy-${raw.startedAt || raw.updatedAt || Date.now()}` }];
    return [];
  }

  function localTombstones() {
    const rows = state().draftTombstones;
    return rows && typeof rows === "object" ? rows : {};
  }

  function allTombstones() { return { ...cloudTombstones, ...localTombstones() }; }

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
    return [...byId.values()].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  function scopeStorageKey(scope) { return SCOPED_STATE_PREFIX + encodeURIComponent(scope); }
  function currentScopeName() { return uxUser?.uid ? `user:${uxUser.uid}` : "guest"; }

  function persistCurrentScope() {
    const scope = localStorage.getItem(ACTIVE_SCOPE_KEY);
    if (!scope) return;
    localStorage.setItem(scopeStorageKey(scope), localStorage.getItem(KEY) || JSON.stringify(EMPTY_STATE));
  }

  function switchLocalScope(scope) {
    const next = String(scope || "guest");
    const active = localStorage.getItem(ACTIVE_SCOPE_KEY);
    const currentRaw = localStorage.getItem(KEY) || JSON.stringify(EMPTY_STATE);
    if (!active) localStorage.setItem(scopeStorageKey(next), currentRaw);
    else if (active !== next) {
      localStorage.setItem(scopeStorageKey(active), currentRaw);
      localStorage.setItem(KEY, localStorage.getItem(scopeStorageKey(next)) || JSON.stringify(EMPTY_STATE));
    }
    localStorage.setItem(ACTIVE_SCOPE_KEY, next);
  }

  function writePendingRows(rows) {
    const current = state();
    if (rows.length) current.pending = rows;
    else delete current.pending;
    save(current);
    persistCurrentScope();
  }

  function writeLocalTombstone(id, timestamp) {
    const current = state();
    current.draftTombstones = { ...(current.draftTombstones || {}), [String(id)]: Number(timestamp) || Date.now() };
    if (Array.isArray(current.pending)) current.pending = current.pending.filter((row) => uxPendingId(row) !== String(id));
    else if (current.pending?.qs?.length && uxPendingId(current.pending) === String(id)) delete current.pending;
    save(current);
    persistCurrentScope();
  }

  function syncDraft(record) {
    if (!uxUser || !uxDb || !record?.id || allTombstones()[String(record.id)]) return Promise.resolve();
    const id = String(record.id);
    const reference = uxDb.collection("users").doc(uxUser.uid).collection("attempts").doc(id);
    const payload = { ...record, kind: "draft", uid: uxUser.uid };
    return uxDb.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const previous = snapshot.exists ? snapshot.data() : null;
      if (!previous || previous.kind !== "draft" || Number(payload.updatedAt || 0) >= Number(previous.updatedAt || 0)) transaction.set(reference, payload);
    }).then(() => {
      if (!allTombstones()[id]) uxCloudDrafts = [payload, ...(uxCloudDrafts || []).filter((row) => uxPendingId(row) !== id)];
    }).catch((error) => uxSetStatus("未完成進度已保存在本機，雲端同步失敗：" + uxFriendlyError(error), true));
  }

  function syncTombstone(id, deletedAt) {
    if (!uxUser || !uxDb || !id) return Promise.resolve();
    const key = String(id);
    const payload = { kind: "draft_tombstone", draftId: key, deletedAt, ts: deletedAt, uid: uxUser.uid };
    const collection = uxDb.collection("users").doc(uxUser.uid).collection("attempts");
    return collection.doc(`deleted-${key}`).set(payload).then(() => {
      cloudTombstones[key] = deletedAt;
      return collection.doc(key).delete();
    }).catch((error) => uxSetStatus("已在此裝置放棄考卷，雲端刪除將於下次連線重試：" + uxFriendlyError(error), true));
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
      qs: cur.qs.map((question) => ({ id: question.id, user: question.user ?? null })),
      whiteboard: compactBoard(cur.whiteboard || blankBoard()),
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
      for (const row of rows) if (row.kind === "draft_tombstone" && row.draftId) cloudTombstones[String(row.draftId)] = Number(row.deletedAt || row.ts) || Date.now();
      const deleted = allTombstones();
      uxCloudAttempts = rows.filter((row) => row?.ts && row.kind !== "draft" && row.kind !== "draft_tombstone").sort((a, b) => b.ts - a.ts);
      uxCloudDrafts = rows.filter((row) => row.kind === "draft" && row.qs?.length && !deleted[uxPendingId(row)]);
      for (const [id, deletedAt] of Object.entries(localTombstones())) if (!cloudTombstones[id]) syncTombstone(id, deletedAt);
      uxRenderDashboard();
      uxRenderPending();
      updateStats();
      renderChapters();
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
    if (!picked.length) { abandonDraft(id); return; }
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
      whiteboard: clone(pending.whiteboard || blankBoard()),
    };
    uxEl("home").classList.add("hidden");
    uxEl("dashboard").classList.add("hidden");
    uxEl("exam").classList.add("active");
    renderExam();
    uxRestoreRenderedAnswers();
    startTimer();
    savePending();
    renderWhiteboard();
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

  function canvasPoint(canvas, event) {
    const box = canvas.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX - box.left) / Math.max(1, box.width))), Math.max(0, Math.min(1, (event.clientY - box.top) / Math.max(1, box.height)))];
  }

  function renderBoardToCanvas(canvas, board) {
    if (!canvas || !board) return;
    const context = canvas.getContext("2d");
    const box = canvas.getBoundingClientRect();
    const scale = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(box.width * scale));
    const height = Math.max(1, Math.round(box.height * scale));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "#e7edf3";
    context.lineWidth = 1;
    const gap = Math.max(24, Math.round(32 * scale));
    for (let y = gap; y < height; y += gap) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of board.strokes || []) {
      const points = stroke.points || [];
      if (!points.length) continue;
      context.beginPath();
      context.strokeStyle = stroke.color || "#1f2937";
      context.lineWidth = (Number(stroke.width) || 4) * scale;
      context.moveTo(points[0][0] * width, points[0][1] * height);
      for (let index = 1; index < points.length; index++) context.lineTo(points[index][0] * width, points[index][1] * height);
      if (points.length === 1) context.lineTo(points[0][0] * width + 0.1, points[0][1] * height + 0.1);
      context.stroke();
    }
  }

  function distanceToSegment(point, start, end) {
    const vx = end[0] - start[0], vy = end[1] - start[1], wx = point[0] - start[0], wy = point[1] - start[1];
    const length = vx * vx + vy * vy;
    const t = length ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / length)) : 0;
    const dx = point[0] - (start[0] + t * vx), dy = point[1] - (start[1] + t * vy);
    return Math.sqrt(dx * dx + dy * dy);
  }

  function eraseAt(canvas, point) {
    cur.whiteboard = cur.whiteboard || blankBoard();
    const box = canvas.getBoundingClientRect();
    const radius = 20 / Math.max(1, Math.min(box.width, box.height));
    const before = cur.whiteboard.strokes.length;
    cur.whiteboard.strokes = cur.whiteboard.strokes.filter((stroke) => {
      const points = stroke.points || [];
      if (points.some((candidate) => distanceToSegment(point, candidate, candidate) <= radius)) return false;
      for (let index = 1; index < points.length; index++) if (distanceToSegment(point, points[index - 1], points[index]) <= radius) return false;
      return true;
    });
    if (before !== cur.whiteboard.strokes.length) { renderWhiteboard(); scheduleBoardSave(); }
  }

  function pointerDown(event) {
    if (cur.submitted) return;
    const canvas = event.currentTarget;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const point = canvasPoint(canvas, event);
    cur.whiteboard = cur.whiteboard || blankBoard();
    if (boardMode === "erase") { activeStroke = { pointerId: event.pointerId, canvas, erase: true }; eraseAt(canvas, point); return; }
    const stroke = { color: boardColor, width: boardWidth, points: [point] };
    cur.whiteboard.strokes.push(stroke);
    activeStroke = { pointerId: event.pointerId, canvas, stroke };
    renderWhiteboard();
  }

  function pointerMove(event) {
    if (!activeStroke || activeStroke.pointerId !== event.pointerId || activeStroke.canvas !== event.currentTarget) return;
    event.preventDefault();
    const point = canvasPoint(activeStroke.canvas, event);
    if (activeStroke.erase) eraseAt(activeStroke.canvas, point);
    else {
      const points = activeStroke.stroke.points, previous = points[points.length - 1];
      if (!previous || Math.abs(previous[0] - point[0]) + Math.abs(previous[1] - point[1]) > 0.0015) { points.push(point); renderWhiteboard(); }
    }
  }

  function pointerUp(event) {
    if (!activeStroke || activeStroke.pointerId !== event.pointerId) return;
    activeStroke = null;
    scheduleBoardSave();
  }

  function scheduleBoardSave() {
    clearTimeout(boardSaveTimer);
    boardSaveTimer = setTimeout(() => {
      savePending();
      const label = uxEl("whiteboardSaveState");
      if (label) { label.textContent = uxUser ? "白板已同步到帳號" : "白板已儲存在此瀏覽器"; setTimeout(() => { if (label) label.textContent = ""; }, 1800); }
    }, 350);
  }

  function updateBoardMode() {
    document.querySelectorAll("#calcWhiteboard [data-board-mode]").forEach((button) => button.classList.toggle("active", button.dataset.boardMode === boardMode));
    const status = uxEl("whiteboardStatus");
    if (status) status.textContent = boardMode === "pen" ? "畫筆模式" : "橡皮擦模式（碰到線條即可整筆擦除）";
  }

  function renderWhiteboard() {
    cur.whiteboard = cur.whiteboard || blankBoard();
    const panel = uxEl("calcWhiteboard");
    if (panel && window.innerWidth > 760) {
      panel.style.width = `${Math.max(320, Math.min(window.innerWidth - 24, Number(cur.whiteboard.panelWidth) || 620))}px`;
      panel.style.height = `${Math.max(320, Math.min(window.innerHeight - 24, Number(cur.whiteboard.panelHeight) || 500))}px`;
    }
    requestAnimationFrame(() => renderBoardToCanvas(uxEl("whiteboardCanvas"), cur.whiteboard));
  }

  function resizeBoard(delta) {
    cur.whiteboard = cur.whiteboard || blankBoard();
    cur.whiteboard.panelWidth = Math.max(320, Math.min(920, Number(cur.whiteboard.panelWidth || 620) + delta));
    cur.whiteboard.panelHeight = Math.max(320, Math.min(760, Number(cur.whiteboard.panelHeight || 500) + Math.round(delta * .7)));
    renderWhiteboard();
    scheduleBoardSave();
  }

  function clearBoard() {
    if (!(cur.whiteboard?.strokes || []).length) { alert("目前白板沒有內容。"); return; }
    if (!confirm("確定要清除目前白板內容嗎？此操作無法復原。")) return;
    cur.whiteboard.strokes = [];
    renderWhiteboard();
    scheduleBoardSave();
  }

  function closeWhiteboard() { uxEl("calcWhiteboard")?.classList.remove("open"); activeStroke = null; }

  function openWhiteboard() {
    if (!uxEl("exam")?.classList.contains("active") || !cur.qs?.length) { alert("請先開始或繼續一份練習，再使用計算白板。"); return; }
    uxEl("calcWhiteboard").classList.add("open");
    renderWhiteboard();
  }

  function installWhiteboard() {
    if (uxEl("calcWhiteboard")) return;
    const panel = document.createElement("aside");
    panel.id = "calcWhiteboard";
    panel.className = "calcWhiteboard";
    panel.setAttribute("aria-label", "計算白板");
    panel.innerHTML = `<div class="whiteboardHead" id="whiteboardDragHandle"><strong>計算白板</strong><span>可拖曳移動</span><button type="button" class="whiteboardIcon" id="closeWhiteboard" aria-label="關閉計算白板">×</button></div><div class="whiteboardToolbar"><button type="button" data-board-mode="pen">畫筆</button><button type="button" data-board-mode="erase">橡皮擦</button><button type="button" class="colorDot active" data-board-color="#1f2937" style="--ink:#1f2937" aria-label="黑色"></button><button type="button" class="colorDot" data-board-color="#dc2626" style="--ink:#dc2626" aria-label="紅色"></button><button type="button" class="colorDot" data-board-color="#2563eb" style="--ink:#2563eb" aria-label="藍色"></button><button type="button" class="colorDot" data-board-color="#15803d" style="--ink:#15803d" aria-label="綠色"></button><label>粗細 <input id="whiteboardWidth" type="range" min="2" max="14" value="4"></label><button type="button" id="whiteboardSmaller">縮小</button><button type="button" id="whiteboardLarger">放大</button><button type="button" class="dangerTool" id="clearWhiteboard">清除白板</button></div><div class="whiteboardCanvasWrap"><canvas id="whiteboardCanvas" aria-label="計算白板畫布"></canvas></div><div class="whiteboardFoot"><span id="whiteboardStatus">畫筆模式</span><span id="whiteboardSaveState"></span></div>`;
    document.body.appendChild(panel);
    const canvas = uxEl("whiteboardCanvas");
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerUp);
    uxEl("closeWhiteboard").onclick = closeWhiteboard;
    uxEl("clearWhiteboard").onclick = clearBoard;
    uxEl("whiteboardSmaller").onclick = () => resizeBoard(-90);
    uxEl("whiteboardLarger").onclick = () => resizeBoard(90);
    uxEl("whiteboardWidth").oninput = (event) => { boardWidth = Number(event.target.value) || 4; };
    panel.querySelectorAll("[data-board-mode]").forEach((button) => button.onclick = () => { boardMode = button.dataset.boardMode; updateBoardMode(); });
    panel.querySelectorAll("[data-board-color]").forEach((button) => button.onclick = () => {
      boardColor = button.dataset.boardColor;
      boardMode = "pen";
      panel.querySelectorAll("[data-board-color]").forEach((item) => item.classList.toggle("active", item === button));
      updateBoardMode();
    });
    const handle = uxEl("whiteboardDragHandle");
    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button") || window.innerWidth <= 760) return;
      const box = panel.getBoundingClientRect();
      dragState = { pointerId: event.pointerId, offsetX: event.clientX - box.left, offsetY: event.clientY - box.top };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const left = Math.max(6, Math.min(window.innerWidth - panel.offsetWidth - 6, event.clientX - dragState.offsetX));
      const top = Math.max(6, Math.min(window.innerHeight - panel.offsetHeight - 6, event.clientY - dragState.offsetY));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = "auto";
    });
    const stopDrag = (event) => { if (dragState?.pointerId === event.pointerId) dragState = null; };
    handle.addEventListener("pointerup", stopDrag);
    handle.addEventListener("pointercancel", stopDrag);
    boardResizeObserver = new ResizeObserver(renderWhiteboard);
    boardResizeObserver.observe(panel);
  }

  function confirmAbandon(id) {
    if (confirm("確定要放棄這份未完成練習嗎？目前的作答進度將無法復原。")) abandonDraft(id);
  }

  function exitExamSafely() {
    if (!uxEl("exam")?.classList.contains("active")) return;
    if (!cur.submitted) {
      savePending();
      if (!confirm("確定要離開這份練習嗎？目前作答進度將會保留。")) return;
    }
    clearInterval(cur.timerId);
    uxEl("exam").classList.remove("active");
    uxEl("home").classList.remove("hidden");
    uxEl("dashboard").classList.add("hidden");
    closeWhiteboard();
    uxRenderPending();
    uxRenderDashboard();
    window.scrollTo(0, 0);
  }

  async function deleteSnapshotDocuments(snapshot) {
    const documents = snapshot.docs || [];
    for (let start = 0; start < documents.length; start += 400) {
      const batch = uxDb.batch();
      documents.slice(start, start + 400).forEach((document) => batch.delete(document.ref));
      await batch.commit();
    }
  }

  async function clearAllLearningData() {
    if (!confirm("確定要清除所有學習資料嗎？此操作無法復原。")) return;
    const button = uxEl("clearAllLearningData"), status = uxEl("clearAllDataStatus");
    if (button) button.disabled = true;
    if (status) status.textContent = "正在清除資料……";
    try {
      if (uxUser && uxDb) {
        const userReference = uxDb.collection("users").doc(uxUser.uid);
        const [attempts, legacyDrafts] = await Promise.all([userReference.collection("attempts").get(), userReference.collection("drafts").get()]);
        await deleteSnapshotDocuments(attempts);
        await deleteSnapshotDocuments(legacyDrafts);
      }
      clearInterval(cur.timerId);
      const cleared = clone(EMPTY_STATE);
      save(cleared);
      localStorage.setItem(scopeStorageKey(currentScopeName()), JSON.stringify(cleared));
      uxCloudAttempts = [];
      uxCloudDrafts = [];
      cloudTombstones = {};
      cur = { qs: [], submitted: false, mode: "exam", timerOn: true, sec: 0, timerId: null, title: "", whiteboard: blankBoard() };
      uxEl("exam").classList.remove("active");
      uxEl("home").classList.remove("hidden");
      uxEl("dashboard").classList.add("hidden");
      closeWhiteboard();
      uxCloseProfile();
      uxRenderPending();
      uxRenderDashboard();
      updateStats();
      renderChapters();
      if (status) status.textContent = "所有學習資料已清除，帳號仍保留。";
      alert("所有學習資料已清除，帳號仍然保留。");
    } catch (error) {
      if (status) status.textContent = "清除失敗：" + uxFriendlyError(error);
      alert("清除資料失敗：" + uxFriendlyError(error));
    } finally { if (button) button.disabled = false; }
  }

  function installProfileControls() {
    const toolbar = uxEl("profileModal")?.querySelector(".historyToolbar");
    if (toolbar && !uxEl("profileLogoutBtn")) {
      const logout = document.createElement("button");
      logout.id = "profileLogoutBtn";
      logout.className = "btn danger";
      logout.textContent = "登出並切換帳號";
      logout.onclick = () => {
        if (!confirm("確定要登出嗎？")) return;
        if (cur.qs?.length && !cur.submitted) savePending();
        persistCurrentScope();
        sessionStorage.removeItem(SESSION_PASSWORD_KEY);
        if (uxAuth) uxAuth.signOut().finally(uxGoLogin); else uxGoLogin();
      };
      uxEl("closeProfile")?.insertAdjacentElement("beforebegin", logout);
    }
    const password = uxEl("profilePassword");
    if (password && !uxEl("toggleProfilePassword")) {
      const toggle = document.createElement("button");
      toggle.id = "toggleProfilePassword";
      toggle.type = "button";
      toggle.className = "btn secondary profileSmallButton";
      toggle.textContent = "顯示密碼";
      toggle.onclick = () => {
        const stored = sessionStorage.getItem(SESSION_PASSWORD_KEY) || "";
        if (!stored) { alert("Firebase 不允許網站讀回密碼。若要在這裡查看，請先登出並重新登入；網站只在目前分頁工作階段暫存你剛輸入的密碼，關閉分頁後即清除，也不會寫入資料庫。"); return; }
        const showing = password.dataset.showing === "1";
        password.dataset.showing = showing ? "0" : "1";
        password.textContent = showing ? "••••••••" : stored;
        toggle.textContent = showing ? "顯示密碼" : "隱藏密碼";
      };
      uxEl("changePasswordBtn")?.insertAdjacentElement("beforebegin", toggle);
    }
    const modal = uxEl("profileModal")?.querySelector(".historyModalBox");
    if (modal && !uxEl("clearAllLearningData")) {
      const section = document.createElement("section");
      section.className = "profileSection dangerZone";
      section.innerHTML = `<h3>資料管理</h3><p class="small muted">刪除目前帳號的歷史紀錄、未完成練習、答案、統計與白板；帳號本身不會刪除。</p><button type="button" class="btn danger" id="clearAllLearningData">清除所有資料</button><div class="small" id="clearAllDataStatus"></div>`;
      modal.appendChild(section);
      uxEl("clearAllLearningData").onclick = clearAllLearningData;
    }
  }

  function memberError(error, action) {
    const code = error?.code || "";
    const messages = {
      "auth/email-already-in-use": "此帳號名稱已有人使用。",
      "auth/invalid-credential": "帳號或密碼不正確。",
      "auth/user-not-found": "找不到這個帳號。",
      "auth/wrong-password": "帳號或密碼不正確。",
      "auth/weak-password": "密碼至少需要 6 碼。",
      "auth/network-request-failed": "網路連線失敗，請稍後再試。",
      "auth/operation-not-allowed": "Firebase 尚未開啟帳號密碼功能。",
      "auth/too-many-requests": "嘗試次數過多，請稍後再試。",
    };
    return messages[code] || `${action}失敗：${error?.message || code || "未知錯誤"}`;
  }

  uxLogin = async function loginWithUsername() {
    const raw = uxEl("authEmail")?.value.trim().toLowerCase() || "";
    const password = uxEl("authPassword")?.value || "";
    const identifier = raw.includes("@") ? raw : (/^[a-z0-9._-]{3,32}$/.test(raw) ? `${raw}@econ848.local` : "");
    if (!identifier) { uxSetStatus("請輸入 3～32 個英文字母、數字、底線、句點或連字號的自訂帳號。", true); return; }
    if (password.length < 6) { uxSetStatus("密碼至少需要 6 碼。", true); return; }
    if (!uxAuth) { uxSetStatus("會員服務尚未連線。", true); return; }
    try {
      await uxAuth.signInWithEmailAndPassword(identifier, password);
      sessionStorage.setItem(SESSION_PASSWORD_KEY, password);
      uxEl("authPassword").value = "";
    } catch (error) { uxSetStatus(memberError(error, "登入"), true); }
  };

  uxRegister = async function registerWithUsername() {
    const username = uxEl("authEmail")?.value.trim().toLowerCase() || "";
    const password = uxEl("authPassword")?.value || "";
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) { uxSetStatus("帳號必須使用 3～32 個英文字母、數字、底線、句點或連字號，且不可使用 Email。", true); return; }
    if (password.length < 6) { uxSetStatus("密碼至少需要 6 碼。", true); return; }
    if (!uxAuth) { uxSetStatus("會員服務尚未連線。", true); return; }
    try {
      await uxAuth.createUserWithEmailAndPassword(`${username}@econ848.local`, password);
      sessionStorage.setItem(SESSION_PASSWORD_KEY, password);
      localStorage.removeItem("econGuestMode");
      uxEl("authPassword").value = "";
    } catch (error) { uxSetStatus(memberError(error, "註冊"), true); }
  };

  const baseRenderProfile = uxRenderProfile;
  uxRenderProfile = function renderProfileWithPrivatePassword() {
    baseRenderProfile();
    const password = uxEl("profilePassword");
    if (password) {
      password.dataset.showing = "0";
      password.textContent = uxUser ? "••••••••" : "訪客模式無密碼";
    }
    const toggle = uxEl("toggleProfilePassword");
    if (toggle) {
      toggle.textContent = "顯示密碼";
      toggle.classList.toggle("hidden", !uxUser);
    }
  };

  const baseChangePassword = uxChangePassword;
  uxChangePassword = async function changePasswordAndRefreshSessionCopy() {
    const nextPassword = uxEl("newPassword")?.value || "";
    await baseChangePassword();
    if (uxEl("passwordStatus")?.textContent === "密碼已更新。") sessionStorage.setItem(SESSION_PASSWORD_KEY, nextPassword);
  };

  const baseRenderExam = renderExam;
  renderExam = function renderExamWithVisuals() { baseRenderExam(); addQuestionVisuals(); };

  const baseBegin = uxBegin;
  uxBegin = function beginWithFreshBoard() {
    cur.whiteboard = blankBoard();
    closeWhiteboard();
    baseBegin();
    if (cur.qs?.length) { cur.whiteboard = blankBoard(); savePending(); }
  };

  const baseRepeat = uxRepeat;
  uxRepeat = function repeatWithFreshBoard() {
    const wasSubmitted = !!cur.submitted;
    if (wasSubmitted) cur.whiteboard = blankBoard();
    baseRepeat();
    if (wasSubmitted && cur.qs?.length) { cur.whiteboard = blankBoard(); closeWhiteboard(); savePending(); }
  };

  const baseSubmit = uxSubmit;
  uxSubmit = function submitWithBoard() {
    const board = compactBoard(cur.whiteboard || blankBoard()), draftId = cur.draftId;
    baseSubmit();
    if (!cur.submitted) return;
    const current = state(), attempt = current.attempts?.[current.attempts.length - 1];
    if (attempt) {
      attempt.whiteboard = board;
      save(current);
      persistCurrentScope();
      uxSyncAttempt(attempt);
      uxRenderDashboard();
    }
    if (draftId && !allTombstones()[String(draftId)]) abandonDraft(draftId);
    closeWhiteboard();
  };

  const baseShowHistory = uxShowHistory;
  uxShowHistory = function showHistoryWithVisuals(timestamp) {
    baseShowHistory(timestamp);
    historyAttempt = uxAllAttempts().find((row) => Number(row.ts) === Number(timestamp)) || null;
    const details = historyAttempt ? uxDetails(historyAttempt) : [], cards = [...document.querySelectorAll("#historyQuestionList .historyQuestion")];
    cards.forEach((card, index) => {
      const detail = details[index], question = detail ? uxQuestion(detail.id) : null, source = question ? visuals[question.id] : null;
      if (source && !card.querySelector(".historySourceVisual")) {
        const figure = document.createElement("figure");
        figure.className = "questionSourceVisual historySourceVisual";
        figure.innerHTML = `<figcaption>原題圖表（取自題庫 PDF）</figcaption><img src="${source}" alt="原始題目圖表">`;
        card.querySelector("p")?.insertAdjacentElement("afterend", figure);
      }
    });
    uxEl("historyExportPdf")?.remove();
    uxEl("historyWhiteboard")?.remove();
    if (historyAttempt?.whiteboard?.strokes?.length) {
      const section = document.createElement("section");
      section.id = "historyWhiteboard";
      section.className = "historyWhiteboard";
      section.innerHTML = `<strong>本次考卷的計算白板</strong><div><canvas aria-label="本次考卷的計算白板"></canvas></div>`;
      uxEl("historyQuestionList")?.insertAdjacentElement("beforebegin", section);
      requestAnimationFrame(() => renderBoardToCanvas(section.querySelector("canvas"), historyAttempt.whiteboard));
    }
  };

  const baseRenderDashboard = uxRenderDashboard;
  uxRenderDashboard = function renderDashboardWithSafeActions() {
    baseRenderDashboard();
    const list = uxEl("historyList");
    list?.querySelectorAll("[data-history-ts]").forEach((button) => button.onclick = () => uxShowHistory(Number(button.dataset.historyTs)));
    list?.querySelectorAll("[data-history-pending-continue]").forEach((button) => button.onclick = () => continueDraft(button.dataset.historyPendingContinue));
    list?.querySelectorAll("[data-history-pending-discard]").forEach((button) => button.onclick = () => confirmAbandon(button.dataset.historyPendingDiscard));
  };

  installWhiteboard();
  installProfileControls();
  uxEl("totalTop").textContent = "計算白板";
  uxEl("totalTop").onclick = openWhiteboard;
  uxEl("startExam").onclick = uxBegin;
  uxEl("submitBtn").onclick = uxSubmit;
  uxEl("exitBtn").onclick = exitExamSafely;
  uxEl("repeatBtn").onclick = uxRepeat;
  uxEl("continuePending").onclick = () => { const pending = mergedPendingRows()[0]; if (pending) continueDraft(uxPendingId(pending)); };
  uxEl("discardPending").onclick = () => { const pending = mergedPendingRows()[0]; if (pending) confirmAbandon(uxPendingId(pending)); };
  uxEl("pendingItems")?.addEventListener("click", (event) => {
    const continueButton = event.target.closest("[data-pending-continue]"), discardButton = event.target.closest("[data-pending-discard]");
    if (!continueButton && !discardButton) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (continueButton) continueDraft(continueButton.dataset.pendingContinue);
    if (discardButton) confirmAbandon(discardButton.dataset.pendingDiscard);
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

  if (uxAuth) {
    uxAuth.onAuthStateChanged(async (user) => {
      switchLocalScope(user?.uid ? `user:${user.uid}` : "guest");
      uxCloudAttempts = [];
      uxCloudDrafts = [];
      cloudTombstones = {};
      await loadCloud();
      uxRenderDashboard();
      uxRenderPending();
      updateStats();
      renderChapters();
    });
  } else switchLocalScope("guest");

  window.addEventListener("resize", renderWhiteboard);
  window.addEventListener("beforeunload", () => { if (cur.qs?.length && !cur.submitted) savePending(); persistCurrentScope(); });
  uxRenderDashboard();
  uxRenderPending();
})();
