/* eslint-disable no-undef */
(function () {
  "use strict";

  var jobList = document.getElementById("job-list");
  var formContainer = document.getElementById("job-form-container");
  var addBtn = document.getElementById("add-job-btn");

  var socket = null;
  try {
    if (typeof io !== "undefined") { socket = io(); }
  } catch (_e) { /* no socket */ }

  // ── Toast ──
  var toastEl = null;
  var toastTimer = null;

  function showToast(message) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add("visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("visible"); }, 2500);
  }

  // ── Helpers ──
  function createField(labelText, inputEl, hintText) {
    var field = document.createElement("div");
    field.className = "form-field";
    var label = document.createElement("label");
    label.className = "form-label";
    label.textContent = labelText;
    field.appendChild(label);
    field.appendChild(inputEl);
    if (hintText) {
      var hint = document.createElement("div");
      hint.className = "form-hint";
      hint.textContent = hintText;
      field.appendChild(hint);
    }
    return field;
  }

  function createTextInput(value, placeholder) {
    var input = document.createElement("input");
    input.className = "text-input";
    input.type = "text";
    input.value = value || "";
    input.placeholder = placeholder || "";
    return input;
  }

  function createToggle(value) {
    var toggle = document.createElement("label");
    toggle.className = "toggle";
    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!value;
    toggle.appendChild(checkbox);
    var slider = document.createElement("span");
    slider.className = "slider";
    toggle.appendChild(slider);
    return { toggle: toggle, checkbox: checkbox };
  }

  // Cached prompt list for the prompt dropdown
  var cachedPrompts = [];

  async function fetchPrompts() {
    try {
      var res = await fetch("/api/admin/prompts");
      if (res.ok) {
        var data = await res.json();
        cachedPrompts = data.prompts || [];
      }
    } catch (_e) { /* silent */ }
  }

  // ── Load jobs ──
  addBtn.addEventListener("click", function () {
    showForm(null);
  });

  async function loadJobs() {
    try {
      var res = await fetch("/api/admin/jobs");
      if (!res.ok) throw new Error("Failed to load jobs");
      var data = await res.json();
      renderList(data.jobs || []);
    } catch (err) {
      jobList.innerHTML = '<div class="loading">Failed to load scheduled jobs.</div>';
      console.error(err);
    }
  }

  function renderList(jobs) {
    jobList.innerHTML = "";
    if (jobs.length === 0) {
      var empty = document.createElement("div");
      empty.className = "library-empty";
      empty.textContent = 'No scheduled jobs yet. Click "+ New Job" to create one.';
      jobList.appendChild(empty);
      return;
    }
    for (var i = 0; i < jobs.length; i++) {
      jobList.appendChild(createCard(jobs[i]));
    }
  }

  function createCard(job) {
    var card = document.createElement("div");
    card.className = "job-card";

    // Header
    var header = document.createElement("div");
    header.className = "prompt-card-header";

    var nameRow = document.createElement("div");
    nameRow.className = "job-name-row";

    var name = document.createElement("div");
    name.className = "prompt-card-name";
    name.textContent = job.name;
    nameRow.appendChild(name);

    var typeBadge = document.createElement("span");
    typeBadge.className = "job-type-badge";
    typeBadge.textContent = job.actionType || "prompt";
    nameRow.appendChild(typeBadge);

    if (!job.enabled) {
      var disabledBadge = document.createElement("span");
      disabledBadge.className = "sidecar-badge stopped";
      disabledBadge.textContent = "DISABLED";
      nameRow.appendChild(disabledBadge);
    }

    header.appendChild(nameRow);

    var actions = document.createElement("div");
    actions.className = "prompt-card-actions";

    // Toggle
    var toggleWrapper = createToggle(job.enabled);
    (function (id, cb) {
      cb.addEventListener("change", function () {
        toggleJob(id, cb.checked, cb);
      });
    })(job.id, toggleWrapper.checkbox);
    actions.appendChild(toggleWrapper.toggle);

    var editBtn = document.createElement("button");
    editBtn.className = "sidecar-btn restart";
    editBtn.textContent = "Edit";
    (function (j) {
      editBtn.addEventListener("click", function () { showForm(j); });
    })(job);
    actions.appendChild(editBtn);

    var deleteBtn = document.createElement("button");
    deleteBtn.className = "sidecar-btn delete-btn";
    deleteBtn.textContent = "Delete";
    (function (j) {
      deleteBtn.addEventListener("click", function () { deleteJob(j.id, j.name); });
    })(job);
    actions.appendChild(deleteBtn);

    header.appendChild(actions);
    card.appendChild(header);

    // Cron + timezone row
    var infoRow = document.createElement("div");
    infoRow.className = "job-info-row";

    var cronLabel = document.createElement("code");
    cronLabel.className = "job-cron";
    cronLabel.textContent = job.cronExpression;
    infoRow.appendChild(cronLabel);

    var tzLabel = document.createElement("span");
    tzLabel.className = "job-tz";
    tzLabel.textContent = job.timezone || "UTC";
    infoRow.appendChild(tzLabel);

    card.appendChild(infoRow);

    // Payload summary
    if (job.actionPayload && Object.keys(job.actionPayload).length > 0) {
      var payloadPre = document.createElement("pre");
      payloadPre.className = "prompt-card-template";
      if (job.actionType === "prompt" && job.actionPayload.promptName) {
        payloadPre.textContent = "Prompt: " + job.actionPayload.promptName;
      } else {
        var payloadStr = JSON.stringify(job.actionPayload, null, 2);
        payloadPre.textContent = payloadStr.length > 200 ? payloadStr.slice(0, 200) + "…" : payloadStr;
      }
      card.appendChild(payloadPre);
    }

    // Stats row
    var statsRow = document.createElement("div");
    statsRow.className = "job-stats-row";

    var runCount = document.createElement("span");
    runCount.className = "job-stat";
    runCount.textContent = "Runs: " + (job.runCount || 0);
    statsRow.appendChild(runCount);

    if (job.lastRunAt) {
      var lastRun = document.createElement("span");
      lastRun.className = "job-stat";
      lastRun.textContent = "Last run: " + new Date(job.lastRunAt).toLocaleString();
      statsRow.appendChild(lastRun);
    }

    card.appendChild(statsRow);
    return card;
  }

  // ── Form ──
  async function showForm(existing) {
    // Make sure we have fresh prompt list for the dropdown
    await fetchPrompts();

    formContainer.className = "prompt-form-container";
    formContainer.innerHTML = "";

    var heading = document.createElement("h3");
    heading.className = "prompt-form-heading";
    heading.textContent = existing ? "Edit Job" : "New Job";
    formContainer.appendChild(heading);

    var nameInput = createTextInput(existing ? existing.name : "", "e.g., daily-report");
    formContainer.appendChild(createField("Name", nameInput, null));

    // Action type selector
    var actionTypeSelect = document.createElement("select");
    actionTypeSelect.className = "text-input";
    var types = ["prompt", "shell", "custom"];
    for (var t = 0; t < types.length; t++) {
      var opt = document.createElement("option");
      opt.value = types[t];
      opt.textContent = types[t].charAt(0).toUpperCase() + types[t].slice(1);
      if (existing && existing.actionType === types[t]) opt.selected = true;
      actionTypeSelect.appendChild(opt);
    }
    formContainer.appendChild(createField("Action Type", actionTypeSelect,
      '"Prompt" executes a saved prompt template. "Shell" runs a command. "Custom" sends raw payload.'));

    // Prompt selector (visible only for prompt type)
    var promptSelectWrapper = document.createElement("div");

    var promptSelect = document.createElement("select");
    promptSelect.className = "text-input";
    var emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "— Select a saved prompt —";
    promptSelect.appendChild(emptyOpt);

    for (var p = 0; p < cachedPrompts.length; p++) {
      var pOpt = document.createElement("option");
      pOpt.value = cachedPrompts[p].name;
      pOpt.textContent = cachedPrompts[p].name + (cachedPrompts[p].description ? " — " + cachedPrompts[p].description : "");
      if (existing && existing.actionPayload && existing.actionPayload.promptName === cachedPrompts[p].name) {
        pOpt.selected = true;
      }
      promptSelect.appendChild(pOpt);
    }

    var promptField = createField("Linked Prompt", promptSelect, "The saved prompt to execute on each run.");
    promptSelectWrapper.appendChild(promptField);

    if (cachedPrompts.length === 0) {
      var noPrompts = document.createElement("div");
      noPrompts.className = "form-hint";
      noPrompts.innerHTML = 'No prompts saved yet. <a href="/library" style="color:var(--accent)">Create one first</a>.';
      promptSelectWrapper.appendChild(noPrompts);
    }
    formContainer.appendChild(promptSelectWrapper);

    // Payload textarea (visible for shell/custom)
    var payloadArea = document.createElement("textarea");
    payloadArea.className = "text-input prompt-textarea";
    payloadArea.rows = 4;
    payloadArea.placeholder = '{"command": "echo hello"}';
    if (existing && existing.actionPayload && existing.actionType !== "prompt") {
      payloadArea.value = JSON.stringify(existing.actionPayload, null, 2);
    }
    var payloadField = createField("Action Payload (JSON)", payloadArea,
      'For shell: {"command": "..."}. For custom: any valid JSON object.');
    formContainer.appendChild(payloadField);

    // Toggle visibility based on action type
    function updateVisibility() {
      var isPrompt = actionTypeSelect.value === "prompt";
      promptSelectWrapper.style.display = isPrompt ? "" : "none";
      payloadField.style.display = isPrompt ? "none" : "";
    }
    actionTypeSelect.addEventListener("change", updateVisibility);
    updateVisibility();

    // Cron expression
    var cronInput = createTextInput(existing ? existing.cronExpression : "", "*/5 * * * *");
    formContainer.appendChild(createField("Cron Expression", cronInput,
      "Standard 5-field cron. Examples: \"0 9 * * *\" (daily 9 AM), \"*/30 * * * *\" (every 30 min), \"0 0 * * MON\" (weekly Monday)."));

    // Cron preview
    var cronPreview = document.createElement("div");
    cronPreview.className = "prompt-variable-preview";
    cronPreview.id = "cron-preview";
    formContainer.appendChild(cronPreview);

    function updateCronPreview() {
      var val = cronInput.value.trim();
      cronPreview.innerHTML = "";
      if (!val) return;
      var parts = val.split(/\s+/);
      if (parts.length !== 5) {
        cronPreview.textContent = "Expected 5 fields: minute hour day-of-month month day-of-week";
        cronPreview.style.color = "var(--danger)";
        return;
      }
      cronPreview.style.color = "var(--text-muted)";
      var labels = ["min", "hour", "day", "month", "weekday"];
      for (var c = 0; c < 5; c++) {
        var seg = document.createElement("code");
        seg.className = "prompt-variable-pill";
        seg.textContent = labels[c] + "=" + parts[c];
        cronPreview.appendChild(seg);
      }
    }
    cronInput.addEventListener("input", updateCronPreview);
    updateCronPreview();

    // Timezone
    var tzInput = createTextInput(existing ? (existing.timezone || "UTC") : "UTC", "America/New_York");
    formContainer.appendChild(createField("Timezone", tzInput, "IANA timezone identifier."));

    // Actions
    var formActions = document.createElement("div");
    formActions.className = "prompt-form-actions";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "sidecar-btn restart";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function () {
      formContainer.className = "prompt-form-container hidden";
    });
    formActions.appendChild(cancelBtn);

    var saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "primary-button";
    saveBtn.textContent = existing ? "Update Job" : "Create Job";
    (function (ex) {
      saveBtn.addEventListener("click", function () {
        saveJob(ex, nameInput, actionTypeSelect, promptSelect, payloadArea, cronInput, tzInput, saveBtn);
      });
    })(existing);
    formActions.appendChild(saveBtn);
    formContainer.appendChild(formActions);

    formContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
    nameInput.focus();
  }

  async function saveJob(existing, nameInput, actionTypeSelect, promptSelect, payloadArea, cronInput, tzInput, button) {
    var name = nameInput.value.trim();
    var cronExpression = cronInput.value.trim();
    if (!name) { showToast("Name is required."); return; }
    if (!cronExpression) { showToast("Cron expression is required."); return; }

    var actionType = actionTypeSelect.value;
    var actionPayload;

    if (actionType === "prompt") {
      var promptName = promptSelect.value;
      if (!promptName) { showToast("Select a prompt for this job."); return; }
      actionPayload = { promptName: promptName };
    } else {
      try {
        actionPayload = JSON.parse(payloadArea.value.trim() || "{}");
      } catch (_e) {
        showToast("Invalid JSON in payload field.");
        return;
      }
    }

    var payload = {
      name: name,
      cronExpression: cronExpression,
      timezone: tzInput.value.trim() || "UTC",
      actionType: actionType,
      actionPayload: actionPayload
    };

    button.disabled = true;
    try {
      var url = existing ? "/api/admin/jobs/" + existing.id : "/api/admin/jobs";
      var method = existing ? "PUT" : "POST";
      var res = await fetch(url, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        throw new Error(data.error || "Failed to save job");
      }
      showToast(existing ? "Job updated" : "Job created");
      formContainer.className = "prompt-form-container hidden";
      await loadJobs();
    } catch (err) {
      showToast("Error: " + (err.message || err));
    } finally {
      button.disabled = false;
    }
  }

  async function toggleJob(id, enabled, checkbox) {
    checkbox.disabled = true;
    try {
      var res = await fetch("/api/admin/jobs/" + id + "/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: enabled })
      });
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        throw new Error(data.error || "Failed to toggle");
      }
      showToast("Job " + (enabled ? "enabled" : "disabled"));
      await loadJobs();
    } catch (err) {
      checkbox.checked = !enabled;
      showToast("Error: " + (err.message || err));
    } finally {
      checkbox.disabled = false;
    }
  }

  async function deleteJob(id, name) {
    if (!confirm('Delete job "' + name + '"? This cannot be undone.')) return;
    try {
      var res = await fetch("/api/admin/jobs/" + id, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      showToast('Job "' + name + '" deleted');
      await loadJobs();
    } catch (err) {
      showToast("Error: " + (err.message || err));
    }
  }

  // ── Socket.IO ──
  if (socket) {
    socket.on("job:executed", function (result) {
      showToast('Job "' + result.jobName + '" ' + (result.success ? "executed" : "failed"));
      loadJobs();
    });
  }

  // ── Init ──
  loadJobs();
})();
