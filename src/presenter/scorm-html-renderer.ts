/**
 * SCORM 1.2 HTML renderer — generates a self-contained HTML wrapper
 * that plays the presentation and communicates with LMS via SCORM API.
 * Issue #703 + #705: Quiz score → SCORM cmi.core.score mapping.
 */

import type { Chapter, QuizCacheRow } from "./presentation-repository.js";

export interface ScormHtmlOptions {
  /** Presentation title. */
  title: string;
  /** Chapters for navigation reference. */
  chapters: Chapter[];
  /** Quiz questions (from quiz_cache). */
  quizQuestions: QuizCacheRow[];
  /** Presentation script segments for text display. */
  scriptSegments: Array<{ text: string; startTime: number; endTime: number }>;
}

/**
 * Generate a self-contained SCORM 1.2 HTML page.
 * Includes the SCORM API adapter, presentation content, and quiz interaction.
 *
 * Issue #705: Quiz scores map to:
 * - cmi.core.score.raw — percentage score (0–100)
 * - cmi.core.score.min — 0
 * - cmi.core.score.max — 100
 * - cmi.core.lesson_status — "passed" (≥80%) / "failed" (<80%) / "completed" (no quiz)
 */
export function renderScormHtml(options: ScormHtmlOptions): string {
  const { title, chapters, quizQuestions, scriptSegments } = options;
  const hasQuiz = quizQuestions.length > 0;

  const chaptersJson = JSON.stringify(chapters);
  const quizJson = JSON.stringify(
    quizQuestions.map((q) => ({
      question: q.question,
      options: typeof q.options === "string" ? JSON.parse(q.options) : q.options,
      correctIndex: q.correct_index,
      explanation: q.explanation,
      chapterIndex: q.chapter_index,
    })),
  );
  const scriptJson = JSON.stringify(scriptSegments);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #1a1a2e; color: #eee; min-height: 100vh; display: flex; flex-direction: column; }
    .header { padding: 1rem 2rem; background: #16213e; border-bottom: 1px solid #0f3460; }
    .header h1 { font-size: 1.4rem; }
    .content { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 2rem; }
    .chapters { width: 100%; max-width: 800px; margin-bottom: 2rem; }
    .chapter { padding: 0.75rem 1rem; margin: 0.25rem 0; background: #16213e; border-radius: 6px; cursor: pointer; }
    .chapter:hover { background: #1a1a4e; }
    .chapter.active { border-left: 3px solid #e94560; }
    .script-area { width: 100%; max-width: 800px; background: #16213e; border-radius: 8px; padding: 1.5rem; margin-bottom: 2rem; min-height: 120px; line-height: 1.6; }
    .quiz-section { width: 100%; max-width: 800px; }
    .quiz-card { background: #16213e; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
    .quiz-card h3 { margin-bottom: 1rem; color: #e94560; }
    .quiz-option { display: block; width: 100%; padding: 0.75rem 1rem; margin: 0.25rem 0; background: #1a1a4e; border: 1px solid #333; border-radius: 4px; color: #eee; cursor: pointer; text-align: left; font-size: 0.95rem; }
    .quiz-option:hover { background: #252560; }
    .quiz-option.correct { background: #0a6e3a; border-color: #0a6e3a; }
    .quiz-option.incorrect { background: #6e0a0a; border-color: #6e0a0a; }
    .quiz-option:disabled { cursor: default; opacity: 0.8; }
    .explanation { margin-top: 0.75rem; padding: 0.75rem; background: #0f3460; border-radius: 4px; font-size: 0.9rem; }
    .results { text-align: center; padding: 2rem; }
    .results h2 { font-size: 2rem; margin-bottom: 1rem; }
    .score-display { font-size: 3rem; font-weight: bold; margin: 1rem 0; }
    .score-display.passed { color: #4ade80; }
    .score-display.failed { color: #f87171; }
    .status { padding: 0.5rem 1rem; background: #0f3460; border-radius: 4px; display: inline-block; font-size: 0.85rem; margin-top: 1rem; }
    .btn { padding: 0.75rem 1.5rem; background: #e94560; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 1rem; margin-top: 1rem; }
    .btn:hover { background: #c73652; }
    .progress { width: 100%; max-width: 800px; height: 4px; background: #333; border-radius: 2px; margin-bottom: 1rem; }
    .progress-bar { height: 100%; background: #e94560; border-radius: 2px; transition: width 0.3s; }
  </style>
</head>
<body>
  <div class="header"><h1>${escapeHtml(title)}</h1></div>
  <div class="content">
    <div class="progress"><div class="progress-bar" id="progressBar" style="width:0%"></div></div>

    <div id="chaptersView" class="chapters"></div>
    <div id="scriptArea" class="script-area"></div>

    <div id="quizSection" class="quiz-section" style="display:none"></div>
    <div id="resultsSection" class="results" style="display:none"></div>

    <div style="margin-top:1rem">
      <button class="btn" id="nextBtn" onclick="handleNext()">Next</button>
    </div>

    <div class="status" id="statusBar">Initializing SCORM...</div>
  </div>

<script>
// ── SCORM 1.2 API Adapter ──
var API = null;
function findAPI(win) {
  var tries = 0;
  while (win && !win.API && tries < 10) { win = win.parent; tries++; }
  if (win && win.API) return win.API;
  if (window.opener) {
    tries = 0; win = window.opener;
    while (win && !win.API && tries < 10) { win = win.parent; tries++; }
    if (win && win.API) return win.API;
  }
  return null;
}

function scormInit() {
  API = findAPI(window);
  if (API) {
    API.LMSInitialize("");
    API.LMSSetValue("cmi.core.lesson_status", "incomplete");
    updateStatus("Connected to LMS");
  } else {
    updateStatus("Standalone mode (no LMS detected)");
  }
}

function scormSetScore(raw, min, max) {
  if (!API) return;
  API.LMSSetValue("cmi.core.score.raw", String(raw));
  API.LMSSetValue("cmi.core.score.min", String(min));
  API.LMSSetValue("cmi.core.score.max", String(max));
  API.LMSCommit("");
}

function scormSetStatus(status) {
  if (!API) return;
  API.LMSSetValue("cmi.core.lesson_status", status);
  API.LMSCommit("");
}

function scormFinish() {
  if (!API) return;
  API.LMSFinish("");
}

function updateStatus(msg) {
  document.getElementById("statusBar").textContent = msg;
}

// ── Presentation State ──
var chapters = ${chaptersJson};
var quiz = ${quizJson};
var script = ${scriptJson};
var hasQuiz = ${hasQuiz};
var currentChapter = 0;
var quizAnswers = {};
var phase = "chapters"; // chapters | quiz | results

function renderChapters() {
  var el = document.getElementById("chaptersView");
  el.innerHTML = "";
  chapters.forEach(function(ch, i) {
    var div = document.createElement("div");
    div.className = "chapter" + (i === currentChapter ? " active" : "");
    div.textContent = (i + 1) + ". " + ch.title;
    div.onclick = function() { currentChapter = i; renderChapters(); renderScript(); };
    el.appendChild(div);
  });
  updateProgress();
}

function renderScript() {
  var el = document.getElementById("scriptArea");
  if (!chapters[currentChapter]) { el.textContent = ""; return; }
  var ch = chapters[currentChapter];
  var segments = script.filter(function(s) {
    return s.startTime >= ch.startSeconds && s.startTime < ch.endSeconds;
  });
  el.innerHTML = segments.map(function(s) { return "<p>" + escapeHtmlJs(s.text) + "</p>"; }).join("");
}

function renderQuiz() {
  var el = document.getElementById("quizSection");
  el.style.display = "block";
  document.getElementById("chaptersView").style.display = "none";
  document.getElementById("scriptArea").style.display = "none";
  phase = "quiz";
  document.getElementById("nextBtn").textContent = "Submit Answers";

  el.innerHTML = quiz.map(function(q, i) {
    var optionsHtml = q.options.map(function(opt, oi) {
      return '<button class="quiz-option" data-qi="' + i + '" data-oi="' + oi + '" onclick="selectOption(' + i + ',' + oi + ')">' + escapeHtmlJs(opt) + '</button>';
    }).join("");
    return '<div class="quiz-card" id="qcard-' + i + '"><h3>Q' + (i+1) + ': ' + escapeHtmlJs(q.question) + '</h3>' + optionsHtml + '</div>';
  }).join("");
}

function selectOption(qi, oi) {
  quizAnswers[qi] = oi;
  var btns = document.querySelectorAll('[data-qi="' + qi + '"]');
  btns.forEach(function(b) { b.style.background = "#1a1a4e"; b.style.borderColor = "#333"; });
  var sel = document.querySelector('[data-qi="' + qi + '"][data-oi="' + oi + '"]');
  if (sel) { sel.style.background = "#0f3460"; sel.style.borderColor = "#e94560"; }
}

function submitQuiz() {
  var correct = 0;
  quiz.forEach(function(q, i) {
    var btns = document.querySelectorAll('[data-qi="' + i + '"]');
    btns.forEach(function(b) { b.disabled = true; });
    var answer = quizAnswers[i];
    if (answer === q.correctIndex) {
      correct++;
      var cb = document.querySelector('[data-qi="' + i + '"][data-oi="' + answer + '"]');
      if (cb) cb.className = "quiz-option correct";
    } else {
      if (answer !== undefined) {
        var wb = document.querySelector('[data-qi="' + i + '"][data-oi="' + answer + '"]');
        if (wb) wb.className = "quiz-option incorrect";
      }
      var rb = document.querySelector('[data-qi="' + i + '"][data-oi="' + q.correctIndex + '"]');
      if (rb) rb.className = "quiz-option correct";
    }
    // Show explanation
    var card = document.getElementById("qcard-" + i);
    if (card && q.explanation) {
      var exDiv = document.createElement("div");
      exDiv.className = "explanation";
      exDiv.textContent = q.explanation;
      card.appendChild(exDiv);
    }
  });

  var pct = quiz.length > 0 ? Math.round((correct / quiz.length) * 100) : 100;
  var passed = pct >= 80;

  // SCORM score mapping (#705)
  scormSetScore(pct, 0, 100);
  scormSetStatus(passed ? "passed" : "failed");

  setTimeout(function() { showResults(correct, quiz.length, pct, passed); }, 1500);
}

function showResults(correct, total, pct, passed) {
  phase = "results";
  document.getElementById("quizSection").style.display = "none";
  var el = document.getElementById("resultsSection");
  el.style.display = "block";
  el.innerHTML = '<h2>Quiz Results</h2>' +
    '<div class="score-display ' + (passed ? "passed" : "failed") + '">' + pct + '%</div>' +
    '<p>' + correct + ' of ' + total + ' correct</p>' +
    '<p style="margin-top:0.5rem;color:' + (passed ? '#4ade80' : '#f87171') + '">' +
    (passed ? 'Passed!' : 'Not passed (80% required)') + '</p>';
  document.getElementById("nextBtn").textContent = "Finish";
  updateStatus(passed ? "Score: " + pct + "% — Passed" : "Score: " + pct + "% — Failed");
  updateProgress();
}

function handleNext() {
  if (phase === "chapters") {
    if (currentChapter < chapters.length - 1) {
      currentChapter++;
      renderChapters();
      renderScript();
    } else if (hasQuiz) {
      renderQuiz();
    } else {
      scormSetStatus("completed");
      finishCourse();
    }
  } else if (phase === "quiz") {
    submitQuiz();
  } else if (phase === "results") {
    finishCourse();
  }
}

function finishCourse() {
  scormFinish();
  updateStatus("Course completed");
  document.getElementById("nextBtn").disabled = true;
  document.getElementById("nextBtn").textContent = "Completed";
}

function updateProgress() {
  var total = chapters.length + (hasQuiz ? 1 : 0);
  var current = currentChapter + (phase === "results" ? 1 : 0) + (phase !== "chapters" ? 1 : 0);
  var pct = Math.min(100, Math.round((current / total) * 100));
  document.getElementById("progressBar").style.width = pct + "%";
}

function escapeHtmlJs(s) {
  var d = document.createElement("div");
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}

// ── Init ──
window.onload = function() {
  scormInit();
  renderChapters();
  renderScript();
};

window.onbeforeunload = function() { scormFinish(); };
</script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
