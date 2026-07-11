(() => {
  "use strict";

  const STORAGE_KEY = "odapnote_dungeon_v1";

  const INTERVAL_DAYS = [1, 3, 7, 14, 30];
  const WRONG_INTERVAL_MS = 4 * 3600 * 1000;
  const UNSURE_INTERVAL_MS = 20 * 3600 * 1000;
  const WORD_TIMER_MS = 10000;

  const MONSTER_ICONS = {
    english: ["👹", "🐺", "🦂", "🐍", "🦇", "🕷️", "🐲", "🦖"],
    term: ["👺", "🧟", "👻", "🗿", "🐙", "🦑", "💀", "🧌"],
    passage: ["🐉", "🦴", "🕸️", "🧙", "👑", "⚱️", "🦉", "🐺"],
  };

  const DUNGEONS = [
    { key: "english", label: "영단어 던전", match: (c) => c.type === "word" && c.subCategory === "english" },
    { key: "term", label: "용어 던전", match: (c) => c.type === "word" && c.subCategory === "term" },
    { key: "passage", label: "지문 던전", match: (c) => c.type === "passage" },
  ];

  // ---------- utils ----------
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const now = () => Date.now();
  const todayStr = (t = now()) => new Date(t).toISOString().slice(0, 10);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const splitList = (raw) => (raw || "").split(",").map((s) => s.trim()).filter(Boolean);
  const daysLeft = (ts) => Math.ceil((ts - now()) / 86400000);

  function pickIcon(card) {
    const pool = card.type === "word" ? MONSTER_ICONS[card.subCategory] : MONSTER_ICONS.passage;
    let hash = 0;
    for (const ch of card.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return pool[hash % pool.length];
  }

  // ---------- storage ----------
  function defaultState() {
    return {
      player: { level: 1, exp: 0, gold: 0, streak: 0, lastPlayedDate: null },
      cards: [],
      settings: { timerEnabled: true },
    };
  }

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      if (!parsed.player || !parsed.cards) return defaultState();
      if (!parsed.settings) parsed.settings = { timerEnabled: true };
      return parsed;
    } catch (e) {
      return defaultState();
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function expToNext(level) {
    return 50 + level * 20;
  }

  function addReward(exp, gold) {
    const p = state.player;
    p.gold += gold;
    p.exp += exp;
    let leveled = false;
    while (p.exp >= expToNext(p.level)) {
      p.exp -= expToNext(p.level);
      p.level += 1;
      leveled = true;
    }
    save();
    renderHud();
    if (leveled) toast(`🎉 레벨 업! Lv.${p.level}`);
  }

  function updateStreak() {
    const p = state.player;
    const today = todayStr();
    if (p.lastPlayedDate === today) return;
    if (p.lastPlayedDate) {
      const diffDays = Math.round((new Date(today) - new Date(p.lastPlayedDate)) / 86400000);
      p.streak = diffDays === 1 ? p.streak + 1 : 1;
    } else {
      p.streak = 1;
    }
    p.lastPlayedDate = today;
    save();
  }

  // ---------- card model ----------
  function createCard(input) {
    const isWord = input.type === "word";
    const baseHp = isWord ? 60 : 100;
    const card = {
      id: uid(),
      type: input.type,
      subCategory: isWord ? input.subCategory : null,
      question: input.question.trim(),
      answer: input.answer.trim(),
      choices: input.choices,
      userNote: input.note.trim(),
      tags: input.tags,
      wrongCount: 1,
      correctStreak: 0,
      hp: baseHp,
      maxHp: baseHp,
      status: "new",
      nextReviewAt: now(),
      createdAt: now(),
      masteredAt: null,
      knownBeforeBattle: false,
      flashSeen: false,
      everBattled: false,
    };
    return card;
  }

  function scheduleNext(card, grade) {
    const t = now();
    if (grade === "know") {
      card.correctStreak += 1;
      const idx = clamp(card.correctStreak - 1, 0, INTERVAL_DAYS.length - 1);
      card.nextReviewAt = t + INTERVAL_DAYS[idx] * 86400000;
    } else if (grade === "unsure") {
      card.nextReviewAt = t + UNSURE_INTERVAL_MS;
    } else {
      card.wrongCount += 1;
      card.correctStreak = 0;
      card.nextReviewAt = t + WRONG_INTERVAL_MS;
    }
  }

  function battleDamage(card, grade, comboCount, withinTimer) {
    const isWord = card.type === "word";
    let dmg = 0;
    let grow = 0;
    if (grade === "know") {
      dmg = isWord ? 20 + Math.min(comboCount, 5) * 2 + (withinTimer ? 10 : 0) : 30;
    } else if (grade === "unsure") {
      dmg = isWord ? 8 : 12;
    } else {
      grow = isWord ? 15 : 20;
    }
    return { dmg, grow };
  }

  function isDue(card) {
    return card.status !== "mastered" && card.nextReviewAt <= now();
  }

  function dueCardsFor(matchFn) {
    return state.cards.filter((c) => matchFn(c) && isDue(c));
  }

  function allActiveCardsFor(matchFn) {
    return state.cards.filter((c) => matchFn(c) && c.status !== "mastered");
  }

  // ---------- toast ----------
  function toast(msg) {
    const layer = document.getElementById("toast-layer");
    const el = document.createElement("div");
    el.className = "fly-toast";
    el.textContent = msg;
    layer.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  }

  // ---------- nav ----------
  function switchView(name) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById(`view-${name}`).classList.add("active");
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
    if (name === "home") renderHome();
    if (name === "flashcard") renderFlashcardDeckSelect();
    if (name === "battle") renderBattleDungeonSelect();
    if (name === "dex") renderDex();
  }

  function renderHud() {
    const p = state.player;
    document.getElementById("hud-streak").textContent = p.streak;
    document.getElementById("hud-level").textContent = p.level;
    document.getElementById("hud-gold").textContent = p.gold;
    const pct = clamp((p.exp / expToNext(p.level)) * 100, 0, 100);
    document.getElementById("hud-exp-fill").style.width = pct + "%";
  }

  // ---------- HOME ----------
  function renderHome() {
    const grid = document.getElementById("home-due-summary");
    grid.innerHTML = "";
    DUNGEONS.forEach((d) => {
      const due = dueCardsFor(d.match).length;
      const total = allActiveCardsFor(d.match).length;
      const div = document.createElement("div");
      div.className = "stat-card";
      div.innerHTML = `<div class="num">${due}</div><div class="label">${escapeHtml(d.label)} 복습 대상</div><div class="sub">진행중 ${total}마리</div>`;
      grid.appendChild(div);
    });
    const masteredCount = state.cards.filter((c) => c.status === "mastered").length;
    const totalCount = state.cards.length;
    const div = document.createElement("div");
    div.className = "stat-card";
    div.innerHTML = `<div class="num">${masteredCount}</div><div class="label">완전정복 몬스터</div><div class="sub">전체 등록 ${totalCount}개</div>`;
    grid.appendChild(div);

    const deckGrid = document.getElementById("home-deck-stats");
    deckGrid.innerHTML = "";
    DUNGEONS.forEach((d) => {
      const cards = state.cards.filter(d.match);
      const learning = cards.filter((c) => c.status === "learning" || c.status === "new").length;
      const mastered = cards.filter((c) => c.status === "mastered").length;
      const div2 = document.createElement("div");
      div2.className = "stat-card";
      div2.innerHTML = `<div class="label">${escapeHtml(d.label)}</div><div class="sub">학습중 ${learning} · 완전정복 ${mastered}</div>`;
      deckGrid.appendChild(div2);
    });

    document.getElementById("home-empty-hint").hidden = state.cards.length !== 0;
    document.getElementById("setting-timer-toggle").checked = state.settings.timerEnabled;
  }

  function setupSettings() {
    document.getElementById("setting-timer-toggle").addEventListener("change", (e) => {
      state.settings.timerEnabled = e.target.checked;
      save();
    });
  }

  // ---------- REGISTER ----------
  function setupRegisterForm() {
    const form = document.getElementById("register-form");
    const subRow = document.getElementById("subcategory-row");
    const qLabel = document.getElementById("question-label");
    const qField = document.getElementById("f-question");

    function syncTypeUi() {
      const type = form.querySelector('input[name="type"]:checked').value;
      subRow.style.display = type === "word" ? "flex" : "none";
      qLabel.textContent = type === "word" ? "단어 / 짧은 문제" : "지문 (긴 문장 전체)";
      qField.rows = type === "word" ? 2 : 8;
    }
    form.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener("change", syncTypeUi));
    syncTypeUi();

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const type = form.querySelector('input[name="type"]:checked').value;
      const subCategory = type === "word" ? form.querySelector('input[name="subCategory"]:checked').value : null;
      const question = document.getElementById("f-question").value.trim();
      const answer = document.getElementById("f-answer").value.trim();
      if (!question || !answer) return;
      const choices = splitList(document.getElementById("f-choices").value);
      const note = document.getElementById("f-note").value;
      const tags = splitList(document.getElementById("f-tags").value);

      const card = createCard({ type, subCategory, question, answer, choices, note, tags });
      state.cards.push(card);
      save();

      form.reset();
      syncTypeUi();
      resetOcrUi();
      const t = document.getElementById("register-toast");
      t.hidden = false;
      t.textContent = `👹 몬스터 소환 완료! "${question.slice(0, 24)}${question.length > 24 ? "…" : ""}" 이(가) 던전에 등장했어요.`;
      setTimeout(() => (t.hidden = true), 3000);
      renderHome();
    });
  }

  // ---------- OCR ----------
  const OCR_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/tesseract.min.js";
  let ocrLoadPromise = null;

  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    if (ocrLoadPromise) return ocrLoadPromise;
    ocrLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = OCR_SCRIPT_URL;
      script.onload = () => resolve();
      script.onerror = () => {
        ocrLoadPromise = null;
        reject(new Error("ocr-script-load-failed"));
      };
      document.head.appendChild(script);
    });
    return ocrLoadPromise;
  }

  function fileToCanvas(file, maxDim) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);
        resolve(canvas);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("image-load-failed"));
      };
      img.src = url;
    });
  }

  const OCR_STATUS_LABEL = {
    "loading tesseract core": "OCR 엔진 불러오는 중...",
    "initializing tesseract": "OCR 초기화 중...",
    "loading language traineddata": "언어 데이터 불러오는 중...",
    "initializing api": "준비 중...",
    "recognizing text": "텍스트 인식 중...",
  };

  function resetOcrUi() {
    const fileInput = document.getElementById("ocr-file");
    fileInput.value = "";
    document.getElementById("ocr-preview").hidden = true;
    document.getElementById("ocr-clear").hidden = true;
    document.getElementById("ocr-progress-wrap").hidden = true;
  }

  function setupOcr() {
    const fileInput = document.getElementById("ocr-file");
    const preview = document.getElementById("ocr-preview");
    const clearBtn = document.getElementById("ocr-clear");
    const progressWrap = document.getElementById("ocr-progress-wrap");
    const progressFill = document.getElementById("ocr-progress-fill");
    const statusEl = document.getElementById("ocr-status");
    const questionField = document.getElementById("f-question");

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files[0];
      if (!file) return;

      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
      clearBtn.hidden = false;
      progressWrap.hidden = false;
      progressFill.style.width = "0%";
      statusEl.textContent = "OCR 엔진 준비 중...";

      try {
        await loadTesseract();
        const canvas = await fileToCanvas(file, 1600);
        const { data } = await Tesseract.recognize(canvas, "kor+eng", {
          logger: (m) => {
            if (m.status === "recognizing text" && typeof m.progress === "number") {
              const pct = Math.round(m.progress * 100);
              progressFill.style.width = pct + "%";
              statusEl.textContent = `텍스트 인식 중... ${pct}%`;
            } else if (m.status) {
              statusEl.textContent = OCR_STATUS_LABEL[m.status] || m.status;
            }
          },
        });
        const text = (data.text || "").trim().replace(/\n{3,}/g, "\n\n");
        if (!text) {
          statusEl.textContent = "텍스트를 찾지 못했어요. 더 선명한 사진으로 다시 시도해보세요.";
          return;
        }
        questionField.value = questionField.value.trim() ? questionField.value.trim() + "\n" + text : text;
        progressFill.style.width = "100%";
        statusEl.textContent = "인식 완료! 아래 문제 칸에서 오탈자를 확인하고 수정해주세요.";
        questionField.focus();
      } catch (err) {
        statusEl.textContent = "OCR을 불러오지 못했어요. 인터넷 연결을 확인하거나 직접 입력해주세요.";
      }
    });

    clearBtn.addEventListener("click", resetOcrUi);
  }

  // ---------- FLASHCARD ----------
  let flashSession = null;

  function renderFlashcardDeckSelect() {
    document.getElementById("flashcard-play").hidden = true;
    const sel = document.getElementById("flashcard-deck-select");
    sel.hidden = false;
    sel.innerHTML = "";
    [DUNGEONS[0], DUNGEONS[1]].forEach((d) => {
      const due = dueCardsFor(d.match);
      const all = allActiveCardsFor(d.match);
      const btn = document.createElement("button");
      btn.className = "deck-btn";
      btn.innerHTML = `<span>${escapeHtml(d.label)}<span class="sub">전체 ${all.length}개</span></span><span class="badge ${due.length === 0 ? "zero" : ""}">${due.length}</span>`;
      btn.addEventListener("click", () => startFlashcardSession(d));
      sel.appendChild(btn);
    });
  }

  function startFlashcardSession(dungeon) {
    let queue = dueCardsFor(dungeon.match);
    let usedFallback = false;
    if (queue.length === 0) {
      queue = allActiveCardsFor(dungeon.match);
      usedFallback = true;
    }
    if (queue.length === 0) {
      toast("이 덱에는 카드가 없어요. 먼저 오답을 등록해보세요.");
      return;
    }
    flashSession = { dungeon, queue: shuffle(queue).map((c) => c.id), idx: 0, usedFallback, flipped: false };
    document.getElementById("flashcard-deck-select").hidden = true;
    document.getElementById("flashcard-play").hidden = false;
    document.getElementById("flashcard-done").hidden = true;
    renderFlashcardCard();
  }

  function renderFlashcardCard() {
    const s = flashSession;
    const grow = document.getElementById("flashcard-grade-row");
    const cardEl = document.getElementById("flashcard-card");
    const doneEl = document.getElementById("flashcard-done");

    if (s.idx >= s.queue.length) {
      cardEl.hidden = true;
      grow.hidden = true;
      doneEl.hidden = false;
      document.getElementById("flashcard-progress").textContent = "";
      return;
    }
    cardEl.hidden = false;
    doneEl.hidden = true;
    const card = state.cards.find((c) => c.id === s.queue[s.idx]);
    document.getElementById("flashcard-progress").textContent = `${s.idx + 1} / ${s.queue.length}${s.usedFallback ? " (예습)" : ""}`;

    cardEl.classList.remove("flipped");
    s.flipped = false;
    grow.hidden = true;

    const front = cardEl.querySelector(".flip-card-front");
    const back = cardEl.querySelector(".flip-card-back");
    front.innerHTML = `<div class="word">${escapeHtml(card.question)}</div><div class="tagline">${card.subCategory === "english" ? "영어단어" : "용어"}</div>`;
    back.innerHTML = `<div class="word">${escapeHtml(card.answer)}</div>${card.userNote ? `<div class="note">💡 ${escapeHtml(card.userNote)}</div>` : ""}`;
  }

  function setupFlashcardEvents() {
    const cardEl = document.getElementById("flashcard-card");
    cardEl.addEventListener("click", () => {
      if (!flashSession || flashSession.idx >= flashSession.queue.length) return;
      cardEl.classList.toggle("flipped");
      flashSession.flipped = cardEl.classList.contains("flipped");
      document.getElementById("flashcard-grade-row").hidden = !flashSession.flipped;
    });

    document.querySelectorAll(".grade-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!flashSession) return;
        const grade = btn.dataset.grade;
        const card = state.cards.find((c) => c.id === flashSession.queue[flashSession.idx]);
        applyFlashcardGrade(card, grade);
        flashSession.idx += 1;
        save();
        renderFlashcardCard();
      });
    });

    document.getElementById("flashcard-exit").addEventListener("click", () => {
      flashSession = null;
      renderFlashcardDeckSelect();
      renderHome();
    });
  }

  function applyFlashcardGrade(card, grade) {
    if (!card.everBattled && !card.flashSeen && grade === "know") {
      card.hp = Math.max(10, Math.round(card.hp * 0.6));
      card.knownBeforeBattle = true;
    }
    card.flashSeen = true;
    if (card.status === "new") card.status = "learning";
    const t = now();
    if (grade === "know") card.nextReviewAt = Math.max(card.nextReviewAt, t + 12 * 3600000);
    else if (grade === "unsure") card.nextReviewAt = t + 3 * 3600000;
    else card.nextReviewAt = t;
  }

  // ---------- BATTLE ----------
  let battleSession = null;

  function renderBattleDungeonSelect() {
    document.getElementById("battle-play").hidden = true;
    const sel = document.getElementById("battle-dungeon-select");
    sel.hidden = false;
    sel.innerHTML = "";
    DUNGEONS.forEach((d) => {
      const due = dueCardsFor(d.match);
      const all = allActiveCardsFor(d.match);
      const btn = document.createElement("button");
      btn.className = "deck-btn";
      btn.innerHTML = `<span>${escapeHtml(d.label)}<span class="sub">진행중 ${all.length}마리</span></span><span class="badge ${due.length === 0 ? "zero" : ""}">${due.length}</span>`;
      btn.addEventListener("click", () => startBattleSession(d));
      sel.appendChild(btn);
    });
  }

  function startBattleSession(dungeon) {
    let queue = dueCardsFor(dungeon.match);
    let usedFallback = false;
    if (queue.length === 0) {
      queue = allActiveCardsFor(dungeon.match);
      usedFallback = true;
    }
    if (queue.length === 0) {
      toast("이 던전에는 몬스터가 없어요. 먼저 오답을 등록해보세요.");
      return;
    }
    battleSession = {
      dungeon,
      queue: shuffle(queue).map((c) => c.id),
      idx: 0,
      usedFallback,
      combo: 0,
      stats: { defeated: 0, exp: 0, gold: 0, maxCombo: 0 },
    };
    document.getElementById("battle-dungeon-select").hidden = true;
    document.getElementById("battle-play").hidden = false;
    renderBattleCard();
  }

  let battleTimer = null;

  function clearBattleTimer() {
    if (battleTimer) {
      clearInterval(battleTimer);
      battleTimer = null;
    }
  }

  function renderBattleCard() {
    clearBattleTimer();
    const s = battleSession;
    const area = document.getElementById("battle-play");

    if (s.idx >= s.queue.length) {
      area.innerHTML = `
        <div class="battle-summary">
          <div class="big">🏆</div>
          <h3 style="margin-top:0">던전 클리어!</h3>
          <div class="reward-row">
            <span>처치 <b>${s.stats.defeated}</b></span>
            <span>EXP <b>+${s.stats.exp}</b></span>
            <span>골드 <b>+${s.stats.gold}</b></span>
            <span>최고 콤보 <b>x${s.stats.maxCombo}</b></span>
          </div>
          <button class="btn-primary" id="battle-return">던전 목록으로</button>
        </div>`;
      document.getElementById("battle-return").addEventListener("click", () => {
        battleSession = null;
        renderBattleDungeonSelect();
        renderHome();
      });
      return;
    }

    const card = state.cards.find((c) => c.id === s.queue[s.idx]);
    const useMc = card.choices && card.choices.length >= 2;
    const icon = pickIcon(card);

    area.innerHTML = `
      <div class="play-topbar">
        <button class="btn-ghost" id="battle-exit">← 나가기</button>
        <span>${s.idx + 1} / ${s.queue.length}${s.usedFallback ? " (연습)" : ""} ${s.combo > 0 ? `<span class="combo-tag">🔥 콤보 x${s.combo}</span>` : ""}</span>
      </div>
      <div class="monster-stage">
        <div class="monster-emoji">${icon}</div>
        <div class="monster-name">${escapeHtml(card.type === "word" ? card.question : card.question.slice(0, 30) + (card.question.length > 30 ? "…" : ""))}</div>
        <div class="hp-bar"><div class="hp-fill" id="battle-hp-fill" style="width:${clamp((card.hp / card.maxHp) * 100, 0, 100)}%"></div></div>
        <div class="hp-label">HP ${Math.max(0, card.hp)} / ${card.maxHp}</div>
      </div>
      <div id="battle-question-zone"></div>
    `;

    document.getElementById("battle-exit").addEventListener("click", () => {
      battleSession = null;
      renderBattleDungeonSelect();
      renderHome();
    });

    if (card.type === "passage") {
      renderPassageReadStep(card);
    } else if (useMc) {
      renderMcStep(card, state.settings.timerEnabled);
    } else {
      renderSelfGradeStep(card, state.settings.timerEnabled);
    }
  }

  function renderPassageReadStep(card) {
    const zone = document.getElementById("battle-question-zone");
    zone.innerHTML = `
      <div class="question-box passage">${escapeHtml(card.question)}</div>
      <button class="btn-primary" id="passage-continue" style="margin-top:12px">다 읽었어요, 문제 보기</button>
    `;
    document.getElementById("passage-continue").addEventListener("click", () => {
      const useMc = card.choices && card.choices.length >= 2;
      if (useMc) renderMcStep(card, false);
      else renderSelfGradeStep(card, false);
    });
  }

  function renderMcStep(card, withTimer = true) {
    const zone = document.getElementById("battle-question-zone");
    const options = shuffle([card.answer, ...card.choices]);
    let expired = false;
    let answered = false;
    const startedAt = now();

    zone.innerHTML = `
      ${withTimer ? '<div class="timer-bar"><div class="timer-fill" id="mc-timer-fill"></div></div>' : ""}
      <div class="question-box">${escapeHtml(card.question)}</div>
      <div class="mc-grid" id="mc-grid"></div>
    `;
    const grid = document.getElementById("mc-grid");
    options.forEach((opt) => {
      const b = document.createElement("button");
      b.className = "mc-btn";
      b.textContent = opt;
      b.addEventListener("click", () => {
        if (answered) return;
        answered = true;
        clearBattleTimer();
        const correct = opt === card.answer;
        Array.from(grid.children).forEach((c) => {
          if (c.textContent === card.answer) c.classList.add("correct");
          else if (c === b && !correct) c.classList.add("wrong");
          c.disabled = true;
        });
        const withinTimer = withTimer && now() - startedAt < WORD_TIMER_MS;
        setTimeout(() => resolveGrade(card, correct ? "know" : "unknown", withinTimer), 550);
      });
      grid.appendChild(b);
    });

    if (withTimer) {
      const fill = document.getElementById("mc-timer-fill");
      fill.style.width = "100%";
      const start = now();
      battleTimer = setInterval(() => {
        const pct = clamp(100 - ((now() - start) / WORD_TIMER_MS) * 100, 0, 100);
        fill.style.width = pct + "%";
        if (pct <= 0 && !answered && !expired) {
          expired = true;
          answered = true;
          clearBattleTimer();
          Array.from(grid.children).forEach((c) => {
            if (c.textContent === card.answer) c.classList.add("correct");
            c.disabled = true;
          });
          setTimeout(() => resolveGrade(card, "unknown", false), 550);
        }
      }, 100);
    }
  }

  function renderSelfGradeStep(card, withTimer) {
    const zone = document.getElementById("battle-question-zone");
    const startedAt = now();
    zone.innerHTML = `
      ${withTimer ? '<div class="timer-bar"><div class="timer-fill" id="mc-timer-fill"></div></div>' : ""}
      <div class="question-box">${escapeHtml(card.question)}</div>
      <button class="btn-primary" id="reveal-btn" style="margin-top:10px">정답 확인</button>
      <div id="reveal-zone"></div>
    `;
    if (withTimer) {
      const fill = document.getElementById("mc-timer-fill");
      fill.style.width = "100%";
      const start = now();
      battleTimer = setInterval(() => {
        const pct = clamp(100 - ((now() - start) / WORD_TIMER_MS) * 100, 0, 100);
        fill.style.width = pct + "%";
        if (pct <= 0) clearBattleTimer();
      }, 100);
    }
    document.getElementById("reveal-btn").addEventListener("click", () => {
      const withinTimer = withTimer && now() - startedAt < WORD_TIMER_MS;
      clearBattleTimer();
      document.getElementById("reveal-btn").remove();
      const rz = document.getElementById("reveal-zone");
      rz.innerHTML = `
        <div class="answer-reveal">정답: ${escapeHtml(card.answer)}</div>
        ${card.userNote ? `<div class="hint">💡 ${escapeHtml(card.userNote)}</div>` : ""}
        <div class="grade-row" style="margin-top:12px">
          <button class="grade-btn know" data-g="know">✅ 안다</button>
          <button class="grade-btn unsure" data-g="unsure">🤔 헷갈림</button>
          <button class="grade-btn unknown" data-g="unknown">❌ 모른다</button>
        </div>
      `;
      rz.querySelectorAll(".grade-btn").forEach((b) => {
        b.addEventListener("click", () => resolveGrade(card, b.dataset.g, withinTimer));
      });
    });
  }

  function resolveGrade(card, grade, withinTimer) {
    const s = battleSession;
    card.everBattled = true;
    if (grade === "know") s.combo += 1;
    else s.combo = 0;
    s.stats.maxCombo = Math.max(s.stats.maxCombo, s.combo);

    const { dmg, grow } = battleDamage(card, grade, s.combo, withinTimer);
    card.hp -= dmg;
    card.hp += grow;
    if (card.hp > card.maxHp) card.maxHp = card.hp;

    if (card.hp <= 0) {
      card.hp = 0;
      card.status = "mastered";
      card.masteredAt = now();
      const expGain = (card.type === "word" ? 15 : 25) + card.wrongCount * 2;
      const goldGain = card.type === "word" ? 5 : 10;
      s.stats.exp += expGain;
      s.stats.gold += goldGain;
      s.stats.defeated += 1;
      addReward(expGain, goldGain);
      toast(`💥 ${escapeHtml(card.question.slice(0, 16))} 처치! 완전정복!`);
    } else {
      card.status = "learning";
      scheduleNext(card, grade);
      if (dmg > 0) toast(`⚔️ ${dmg} 데미지!`);
      if (grow > 0) toast(`😈 몬스터가 강해졌다! (+${grow} HP)`);
    }
    save();

    const fill = document.getElementById("battle-hp-fill");
    if (fill) fill.style.width = clamp((Math.max(card.hp, 0) / card.maxHp) * 100, 0, 100) + "%";

    setTimeout(() => {
      s.idx += 1;
      renderBattleCard();
    }, 700);
  }

  // ---------- DEX ----------
  function renderDex() {
    const mastered = state.cards.filter((c) => c.status === "mastered").sort((a, b) => (b.masteredAt || 0) - (a.masteredAt || 0));
    const statsEl = document.getElementById("dex-stats");
    statsEl.innerHTML = "";
    DUNGEONS.forEach((d) => {
      const total = state.cards.filter(d.match).length;
      const done = state.cards.filter((c) => d.match(c) && c.status === "mastered").length;
      const div = document.createElement("div");
      div.className = "stat-card";
      div.innerHTML = `<div class="num">${done}/${total}</div><div class="label">${escapeHtml(d.label)}</div>`;
      statsEl.appendChild(div);
    });

    const list = document.getElementById("dex-list");
    list.innerHTML = "";
    if (mastered.length === 0) {
      list.innerHTML = `<div class="empty-hint">아직 완전정복한 몬스터가 없어요. 배틀에서 오답 몬스터의 HP를 0으로 만들어보세요!</div>`;
      return;
    }
    mastered.forEach((c) => {
      const div = document.createElement("div");
      div.className = "dex-item";
      const dungeon = DUNGEONS.find((d) => d.match(c));
      div.innerHTML = `
        <div class="em">${pickIcon(c)}</div>
        <div class="info">
          <div class="q">${escapeHtml(c.question)}</div>
          <div class="meta">${escapeHtml(dungeon ? dungeon.label : "")} · 오답 ${c.wrongCount}회 만에 정복 · ${new Date(c.masteredAt).toLocaleDateString("ko-KR")}</div>
        </div>
        <div class="stamp">완전정복</div>
      `;
      list.appendChild(div);
    });
  }

  // ---------- init ----------
  function init() {
    updateStreak();
    renderHud();
    setupRegisterForm();
    setupOcr();
    setupFlashcardEvents();
    setupSettings();

    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    switchView("home");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
