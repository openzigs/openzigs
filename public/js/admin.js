/* eslint-disable no-undef */
(function () {
  "use strict";

  const toolsList = document.getElementById("tools-list");
  const envStatus = document.getElementById("env-status");
  const channelsForm = document.getElementById("channels-form");
  const sidecarsPanel = document.getElementById("sidecars-panel");
  const localServersPanel = document.getElementById("local-servers-panel");

  // ── Socket.IO for live sidecar updates ──
  var socket = null;
  try {
    if (typeof io !== "undefined") {
      socket = io();
    }
  } catch (_e) {
    // Socket.IO not available
  }

  // ── Toast ──
  let toastEl = null;
  let toastTimer = null;

  function showToast(message) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add("visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 2000);
  }

  function parseList(value) {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function createField(labelText, inputEl, hintText) {
    const field = document.createElement("div");
    field.className = "form-field";

    const label = document.createElement("label");
    label.className = "form-label";
    label.textContent = labelText;
    field.appendChild(label);

    field.appendChild(inputEl);

    if (hintText) {
      const hint = document.createElement("div");
      hint.className = "form-hint";
      hint.textContent = hintText;
      field.appendChild(hint);
    }

    return field;
  }

  function createTextInput(value, placeholder) {
    const input = document.createElement("input");
    input.className = "text-input";
    input.type = "text";
    input.value = value ?? "";
    input.placeholder = placeholder ?? "";
    return input;
  }

  function createToggle(value) {
    const toggle = document.createElement("label");
    toggle.className = "toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!value;
    toggle.appendChild(checkbox);
    const slider = document.createElement("span");
    slider.className = "slider";
    toggle.appendChild(slider);
    return { toggle, checkbox };
  }

  // ── Load tools ──
  async function loadTools() {
    try {
      const res = await fetch("/api/admin/tools");
      if (!res.ok) throw new Error("Failed to load tools");
      const data = await res.json();
      renderTools(data.tools);
    } catch (err) {
      toolsList.innerHTML = '<div class="loading">Failed to load tools.</div>';
      console.error(err);
    }
  }

  async function loadChannels() {
    try {
      const [channelsRes, modelsRes] = await Promise.all([
        fetch("/api/admin/channels"),
        fetch("/api/models")
      ]);
      
      if (!channelsRes.ok) throw new Error("Failed to load channels");
      if (!modelsRes.ok) throw new Error("Failed to load models");
      
      const channelsData = await channelsRes.json();
      const modelsData = await modelsRes.json();
      
      renderChannels(channelsData.channels, modelsData.models);
    } catch (err) {
      channelsForm.innerHTML = '<div class="loading">Failed to load configuration.</div>';
      console.error(err);
    }
  }

  function renderTools(grouped) {
    toolsList.innerHTML = "";
    var categoryOrder = [
      "filesystem", "search", "browser", "shell",
      "productivity", "social", "documents",
      "personal", "data", "developer"
    ];

    for (var c = 0; c < categoryOrder.length; c++) {
      var category = categoryOrder[c];
      var allTools = grouped[category];
      if (!allTools || allTools.length === 0) continue;

      // Filter out tools that belong to an MCP sidecar (they appear in sidecar cards)
      var tools = [];
      for (var f = 0; f < allTools.length; f++) {
        if (!allTools[f].source) tools.push(allTools[f]);
      }
      if (tools.length === 0) continue;

      var section = document.createElement("div");
      section.className = "tool-category";

      var label = document.createElement("div");
      label.className = "tool-category-label";
      label.textContent = category;
      section.appendChild(label);

      for (var t = 0; t < tools.length; t++) {
        var tool = tools[t];
        var item = document.createElement("div");
        item.className = "tool-item";

        var info = document.createElement("div");
        info.className = "tool-info";

        var name = document.createElement("div");
        name.className = "tool-name";
        name.textContent = tool.name;
        info.appendChild(name);

        var desc = document.createElement("div");
        desc.className = "tool-desc";
        desc.textContent = tool.description;
        info.appendChild(desc);

        item.appendChild(info);

        var risk = document.createElement("span");
        risk.className = "tool-risk " + tool.riskLevel;
        risk.textContent = tool.riskLevel;
        item.appendChild(risk);

        var toggle = document.createElement("label");
        toggle.className = "toggle";
        var checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = tool.enabled;
        checkbox.addEventListener("change", (function(toolName) {
          return function () { toggleTool(toolName, this.checked, this); };
        })(tool.name));
        toggle.appendChild(checkbox);
        var slider = document.createElement("span");
        slider.className = "slider";
        toggle.appendChild(slider);
        item.appendChild(toggle);

        section.appendChild(item);
      }

      toolsList.appendChild(section);
    }
  }

  function createSelect(value, options, placeholder) {
    const select = document.createElement("select");
    select.className = "text-input";
    
    if (placeholder) {
      const emptyOption = document.createElement("option");
      emptyOption.value = "";
      emptyOption.textContent = placeholder;
      select.appendChild(emptyOption);
    }
    
    for (const opt of options) {
      const option = document.createElement("option");
      option.value = opt.id;
      option.textContent = opt.id; // Models currently just have ID
      if (opt.id === value) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    
    return select;
  }

  function renderChannels(channels, models) {
    channelsForm.innerHTML = "";

    const telegram = channels.telegram || {};
    const discord = channels.discord || {};

    const form = document.createElement("form");
    form.className = "channels-panel";

    const telegramCard = document.createElement("div");
    telegramCard.className = "channel-card";
    const telegramHeader = document.createElement("div");
    telegramHeader.className = "channel-header";
    const telegramTitle = document.createElement("div");
    telegramTitle.className = "channel-title";
    telegramTitle.textContent = "Telegram";
    telegramHeader.appendChild(telegramTitle);
    const telegramToggle = createToggle(telegram.enabled);
    telegramHeader.appendChild(telegramToggle.toggle);
    telegramCard.appendChild(telegramHeader);
    
    // Model Selector
    const telegramModelSelect = createSelect(telegram.model, models, "Default (System)");
    telegramCard.appendChild(
      createField("Model", telegramModelSelect, "Model used for Telegram replies.")
    );

    const telegramWebhookInput = createTextInput(telegram.webhookUrl, "https://example.com/telegram/webhook");
    telegramCard.appendChild(
      createField("Webhook URL", telegramWebhookInput, "Required for inbound messages (set via tunnel).")
    );

    const telegramWebhookSecretInput = createTextInput(telegram.webhookSecret, "random-secret-token");
    telegramCard.appendChild(
      createField("Webhook Secret", telegramWebhookSecretInput, "Optional: strongly random token (validates incoming webhooks).")
    );

    const telegramAdminInput = createTextInput(telegram.adminUserId, "123456789");
    telegramCard.appendChild(
      createField("Admin User ID", telegramAdminInput, "Optional: user allowed to run /toggle.")
    );

    const telegramAllowedInput = createTextInput((telegram.allowedUsers || []).join(", "), "user1, user2");
    telegramCard.appendChild(
      createField("Allowed Users", telegramAllowedInput, "Comma-separated Telegram user IDs.")
    );

    form.appendChild(telegramCard);

    const discordCard = document.createElement("div");
    discordCard.className = "channel-card";
    const discordHeader = document.createElement("div");
    discordHeader.className = "channel-header";
    const discordTitle = document.createElement("div");
    discordTitle.className = "channel-title";
    discordTitle.textContent = "Discord";
    discordHeader.appendChild(discordTitle);
    const discordToggle = createToggle(discord.enabled);
    discordHeader.appendChild(discordToggle.toggle);
    discordCard.appendChild(discordHeader);

    const discordAllowedInput = createTextInput((discord.allowedGuilds || []).join(", "), "guild-id-1, guild-id-2");
    discordCard.appendChild(
      createField("Allowed Guilds", discordAllowedInput, "Comma-separated guild IDs. Leave empty for DMs only.")
    );

    form.appendChild(discordCard);

    const actions = document.createElement("div");
    actions.className = "form-actions";
    const saveButton = document.createElement("button");
    saveButton.type = "submit";
    saveButton.className = "primary-button";
    saveButton.textContent = "Save & Restart";
    actions.appendChild(saveButton);
    form.appendChild(actions);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      saveButton.disabled = true;
      try {
        const payload = {
          telegram: {
            enabled: telegramToggle.checkbox.checked,
            model: telegramModelSelect.value,
            webhookUrl: telegramWebhookInput.value.trim(),
            webhookSecret: telegramWebhookSecretInput.value.trim(),
            adminUserId: telegramAdminInput.value.trim(),
            allowedUsers: parseList(telegramAllowedInput.value)
          },
          discord: {
            enabled: discordToggle.checkbox.checked,
            allowedGuilds: parseList(discordAllowedInput.value)
          }
        };
        const res = await fetch("/api/admin/channels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to save channels");
        }
        showToast("Channels saved. Restart server to apply.");
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        showToast("Error: " + message);
      } finally {
        saveButton.disabled = false;
      }
    });

    channelsForm.appendChild(form);
  }

  async function toggleTool(name, enabled, checkbox) {
    checkbox.disabled = true;
    try {
      const res = await fetch("/api/admin/tools/" + encodeURIComponent(name) + "/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed");
      }
      showToast(name + " " + (enabled ? "enabled" : "disabled"));
    } catch (err) {
      checkbox.checked = !enabled;
      showToast("Error: " + err.message);
    } finally {
      checkbox.disabled = false;
    }
  }

  // ── Load env status ──
  async function loadEnv() {
    try {
      const res = await fetch("/api/admin/env");
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      renderEnv(data.env);
    } catch (err) {
      envStatus.innerHTML = '<div class="loading">Failed to load env status.</div>';
      console.error(err);
    }
  }

  function renderEnv(entries) {
    envStatus.innerHTML = "";
    for (const entry of entries) {
      const item = document.createElement("div");
      item.className = "env-item";

      const dot = document.createElement("span");
      dot.className = "env-dot " + (entry.configured ? "configured" : "missing");
      item.appendChild(dot);

      const label = document.createElement("span");
      label.className = "env-label";
      label.textContent = entry.name;
      item.appendChild(label);

      const status = document.createElement("span");
      status.className = "env-status-text";
      status.textContent = entry.configured ? "Configured" : "Not set";
      item.appendChild(status);

      envStatus.appendChild(item);
    }
  }

  // ── Load MCP Sidecars ──
  var sidecarData = null;

  async function loadSidecars() {
    try {
      var res = await fetch("/api/admin/sidecars");
      if (!res.ok) throw new Error("Failed to load sidecars");
      sidecarData = await res.json();
      renderSidecars(sidecarData);
    } catch (err) {
      sidecarsPanel.innerHTML = '<div class="loading">Failed to load MCP servers.</div>';
      console.error(err);
    }
  }

  function renderSidecars(data) {
    sidecarsPanel.innerHTML = "";

    // Docker status banner
    var dockerBanner = document.createElement("div");
    dockerBanner.className = "docker-banner " + (data.dockerAvailable ? "docker-ok" : "docker-missing");
    var dockerIcon = document.createElement("span");
    dockerIcon.className = "docker-icon";
    dockerIcon.textContent = data.dockerAvailable ? "●" : "○";
    dockerBanner.appendChild(dockerIcon);
    var dockerText = document.createElement("span");
    dockerText.textContent = data.dockerAvailable
      ? "Docker connected — auto-provisioning active"
      : "Docker not available — configure sidecar URLs manually via environment variables";
    dockerBanner.appendChild(dockerText);
    sidecarsPanel.appendChild(dockerBanner);

    // Sidecar cards
    var grid = document.createElement("div");
    grid.className = "sidecar-grid";

    var credentials = data.credentials || [];
    var statuses = data.sidecars || [];

    for (var i = 0; i < credentials.length; i++) {
      var cred = credentials[i];
      var status = statuses.find(function (s) { return s.name === cred.platform; }) || null;
      var card = createSidecarCard(cred, status, data.dockerAvailable);
      grid.appendChild(card);
    }

    sidecarsPanel.appendChild(grid);
  }

  function createSidecarCard(cred, status, dockerAvailable) {
    var card = document.createElement("div");
    card.className = "sidecar-card";
    card.setAttribute("data-sidecar", cred.platform);

    // Header row: expand icon + name + enable toggle + status badge (clickable to toggle)
    var header = document.createElement("div");
    header.className = "sidecar-header";

    var headerLeft = document.createElement("div");
    headerLeft.className = "sidecar-header-left";

    var expandIcon = document.createElement("span");
    expandIcon.className = "sidecar-expand-icon";
    expandIcon.textContent = "▶";
    headerLeft.appendChild(expandIcon);

    var title = document.createElement("div");
    title.className = "sidecar-title";
    title.textContent = cred.label;
    headerLeft.appendChild(title);

    header.appendChild(headerLeft);

    var headerRight = document.createElement("div");
    headerRight.className = "sidecar-header-right";

    // Server-level enable/disable toggle
    var serverToggle = document.createElement("label");
    serverToggle.className = "toggle";
    var serverCheckbox = document.createElement("input");
    serverCheckbox.type = "checkbox";
    serverCheckbox.checked = cred.enabled !== false;
    (function (platform, cb) {
      cb.addEventListener("change", function (e) {
        e.stopPropagation();
        toggleSidecar(platform, cb.checked, cb);
      });
    })(cred.platform, serverCheckbox);
    serverToggle.appendChild(serverCheckbox);
    var serverSlider = document.createElement("span");
    serverSlider.className = "slider";
    serverToggle.appendChild(serverSlider);
    serverToggle.addEventListener("click", function (e) { e.stopPropagation(); });
    headerRight.appendChild(serverToggle);

    var badge = document.createElement("span");
    badge.className = "sidecar-badge";
    if (!cred.imageAvailable) {
      badge.classList.add("coming-soon");
      badge.textContent = "Coming Soon";
    } else if (!cred.enabled) {
      badge.classList.add("stopped");
      badge.textContent = "Disabled";
    } else if (status && status.running && status.healthy) {
      badge.classList.add("healthy");
      badge.textContent = "Healthy";
    } else if (status && status.running && !status.healthy) {
      badge.classList.add("unhealthy");
      badge.textContent = "Unhealthy";
    } else if (status && status.error === "credentials_missing") {
      badge.classList.add("unconfigured");
      badge.textContent = "No Credentials";
    } else if (status && !status.running) {
      badge.classList.add("stopped");
      badge.textContent = "Stopped";
    } else {
      badge.classList.add("unknown");
      badge.textContent = "Unknown";
    }
    headerRight.appendChild(badge);
    header.appendChild(headerRight);
    card.appendChild(header);

    // Toggle expand/collapse on header click
    header.addEventListener("click", function () {
      card.classList.toggle("expanded");
    });

    // Body: collapsible content
    var body = document.createElement("div");
    body.className = "sidecar-body";

    // Coming soon notice
    if (!cred.imageAvailable) {
      var notice = document.createElement("div");
      notice.className = "sidecar-coming-soon";
      notice.textContent = "Docker image not yet available. This integration is coming in a future release.";
      body.appendChild(notice);
      card.appendChild(body);
      return card;
    }

    // Credential input fields
    if (cred.envVars.length > 0) {
      var credSection = document.createElement("div");
      credSection.className = "sidecar-creds";

      var credLabel = document.createElement("div");
      credLabel.className = "sidecar-creds-label";
      credLabel.textContent = "API Credentials";
      credSection.appendChild(credLabel);

      var inputs = {};

      for (var j = 0; j < cred.envVars.length; j++) {
        var envVar = cred.envVars[j];
        var fieldWrapper = document.createElement("div");
        fieldWrapper.className = "sidecar-cred-field";

        var fieldLabel = document.createElement("label");
        fieldLabel.className = "sidecar-cred-label";
        fieldLabel.textContent = envVar.name;
        fieldWrapper.appendChild(fieldLabel);

        var inputRow = document.createElement("div");
        inputRow.className = "sidecar-cred-input-row";

        var input = document.createElement("input");
        input.className = "sidecar-cred-input";
        input.type = "password";
        input.placeholder = envVar.configured ? "••••••••  (already set)" : "Paste your key here…";
        input.setAttribute("data-env", envVar.name);
        input.setAttribute("autocomplete", "off");
        inputRow.appendChild(input);

        var toggleVis = document.createElement("button");
        toggleVis.type = "button";
        toggleVis.className = "sidecar-cred-toggle";
        toggleVis.textContent = "👁";
        toggleVis.title = "Show/hide value";
        (function (inp, btn) {
          btn.addEventListener("click", function (e) {
            e.stopPropagation();
            if (inp.type === "password") {
              inp.type = "text";
              btn.textContent = "🔒";
            } else {
              inp.type = "password";
              btn.textContent = "👁";
            }
          });
        })(input, toggleVis);
        inputRow.appendChild(toggleVis);

        fieldWrapper.appendChild(inputRow);

        var statusIndicator = document.createElement("div");
        statusIndicator.className = "sidecar-cred-indicator " + (envVar.configured ? "configured" : "missing");
        statusIndicator.textContent = envVar.configured ? "✓ Configured" : "✗ Not set";
        fieldWrapper.appendChild(statusIndicator);

        credSection.appendChild(fieldWrapper);
        inputs[envVar.name] = input;
      }

      body.appendChild(credSection);

      // Save credentials button
      var saveActions = document.createElement("div");
      saveActions.className = "sidecar-actions";

      var saveBtn = document.createElement("button");
      saveBtn.className = "sidecar-btn save";
      saveBtn.textContent = "Save Credentials";
      (function (platform, inputsMap, btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          saveCredentials(platform, inputsMap, btn);
        });
      })(cred.platform, inputs, saveBtn);
      saveActions.appendChild(saveBtn);

      if (dockerAvailable) {
        var restartBtn = document.createElement("button");
        restartBtn.className = "sidecar-btn restart";
        restartBtn.textContent = "Restart";
        restartBtn.disabled = !status || status.error === "credentials_missing";
        (function (name, btn) {
          btn.addEventListener("click", function (e) {
            e.stopPropagation();
            restartSidecar(name, btn);
          });
        })(cred.platform, restartBtn);
        saveActions.appendChild(restartBtn);
      }

      body.appendChild(saveActions);
    } else {
      var noCredsNote = document.createElement("div");
      noCredsNote.className = "sidecar-creds-label";
      noCredsNote.textContent = "No credentials required";
      body.appendChild(noCredsNote);

      // Actions for no-cred sidecars (just restart)
      if (dockerAvailable) {
        var actionsDiv = document.createElement("div");
        actionsDiv.className = "sidecar-actions";

        var restBtn = document.createElement("button");
        restBtn.className = "sidecar-btn restart";
        restBtn.textContent = "Restart";
        restBtn.disabled = !status;
        (function (name, btn) {
          btn.addEventListener("click", function (e) {
            e.stopPropagation();
            restartSidecar(name, btn);
          });
        })(cred.platform, restBtn);
        actionsDiv.appendChild(restBtn);

        body.appendChild(actionsDiv);
      }
    }

    // Per-tool toggles
    var toolsSection = document.createElement("div");
    toolsSection.className = "sidecar-tools";
    var toolsLabel = document.createElement("div");
    toolsLabel.className = "sidecar-tools-label";
    toolsLabel.textContent = "Tools";
    toolsSection.appendChild(toolsLabel);

    var toolsLoading = document.createElement("div");
    toolsLoading.className = "loading";
    toolsLoading.textContent = "Loading tools…";
    toolsSection.appendChild(toolsLoading);
    body.appendChild(toolsSection);

    // Lazy-load tools when card is first expanded
    var toolsLoaded = false;
    header.addEventListener("click", function () {
      if (toolsLoaded || !card.classList.contains("expanded")) return;
      toolsLoaded = true;
      loadSidecarTools(cred.platform, toolsSection, toolsLoading);
    });

    // URL info (below actions)
    if (status && status.url) {
      var urlRow = document.createElement("div");
      urlRow.className = "sidecar-url";
      urlRow.textContent = status.url;
      body.appendChild(urlRow);
    }

    card.appendChild(body);
    return card;
  }

  async function loadSidecarTools(platform, container, loadingEl) {
    try {
      var res = await fetch("/api/admin/sidecars/" + encodeURIComponent(platform) + "/tools");
      if (!res.ok) {
        loadingEl.textContent = "No tools found.";
        return;
      }
      var data = await res.json();
      var tools = data.tools || [];
      if (loadingEl.parentNode) loadingEl.remove();

      for (var i = 0; i < tools.length; i++) {
        var tool = tools[i];
        var item = document.createElement("div");
        item.className = "sidecar-tool-item";

        var info = document.createElement("div");
        info.className = "sidecar-tool-info";

        var nameEl = document.createElement("div");
        nameEl.className = "sidecar-tool-name";
        nameEl.textContent = tool.name;
        info.appendChild(nameEl);

        if (tool.description) {
          var descEl = document.createElement("div");
          descEl.className = "sidecar-tool-desc";
          descEl.textContent = tool.description;
          info.appendChild(descEl);
        }

        item.appendChild(info);

        var risk = document.createElement("span");
        risk.className = "tool-risk " + tool.riskLevel;
        risk.textContent = tool.riskLevel;
        item.appendChild(risk);

        var toggle = document.createElement("label");
        toggle.className = "toggle";
        var checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = tool.enabled;
        (function (toolName, cb) {
          cb.addEventListener("change", function (e) {
            e.stopPropagation();
            toggleTool(toolName, cb.checked, cb);
          });
        })(tool.name, checkbox);
        toggle.appendChild(checkbox);
        var slider = document.createElement("span");
        slider.className = "slider";
        toggle.appendChild(slider);
        item.appendChild(toggle);

        container.appendChild(item);
      }
    } catch (err) {
      loadingEl.textContent = "Failed to load tools.";
      console.error(err);
    }
  }

  async function toggleSidecar(name, enabled, checkbox) {
    checkbox.disabled = true;
    try {
      var res = await fetch("/api/admin/sidecars/" + encodeURIComponent(name) + "/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: enabled })
      });
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        throw new Error(data.error || "Failed");
      }
      showToast(name + " " + (enabled ? "enabled" : "disabled") + " — restart required");
      await loadSidecars();
    } catch (err) {
      checkbox.checked = !enabled;
      showToast("Error: " + (err && err.message ? err.message : String(err)));
    } finally {
      checkbox.disabled = false;
    }
  }

  async function saveCredentials(platform, inputs, button) {
    // Collect non-empty inputs
    var credentials = {};
    var hasValue = false;
    for (var key in inputs) {
      var value = inputs[key].value.trim();
      if (value) {
        credentials[key] = value;
        hasValue = true;
      }
    }

    if (!hasValue) {
      showToast("Enter at least one credential to save.");
      return;
    }

    button.disabled = true;
    button.textContent = "Saving…";
    try {
      var res = await fetch("/api/admin/sidecars/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials: credentials })
      });
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        throw new Error(data.error || "Failed to save credentials");
      }
      showToast(platform + " credentials saved! Restart to activate.");
      // Clear inputs and reload to show updated status
      for (var k in inputs) {
        inputs[k].value = "";
      }
      await loadSidecars();
    } catch (err) {
      var message = err && err.message ? err.message : String(err);
      showToast("Error: " + message);
    } finally {
      button.disabled = false;
      button.textContent = "Save Credentials";
    }
  }

  async function restartSidecar(name, button) {
    button.disabled = true;
    button.textContent = "Restarting…";
    try {
      var res = await fetch("/api/admin/sidecars/" + encodeURIComponent(name) + "/restart", {
        method: "POST"
      });
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        throw new Error(data.error || "Failed to restart");
      }
      showToast(name + " restarted");
      await loadSidecars();
    } catch (err) {
      var message = err && err.message ? err.message : String(err);
      showToast("Error: " + message);
    } finally {
      button.disabled = false;
      button.textContent = "Restart";
    }
  }

  // ── Socket.IO live sidecar status ──
  if (socket) {
    socket.on("sidecar:status", function (status) {
      // Update the specific card in-place
      var card = document.querySelector('[data-sidecar="' + status.name + '"]');
      if (card) {
        var badge = card.querySelector(".sidecar-badge");
        if (badge) {
          badge.className = "sidecar-badge";
          if (status.running && status.healthy) {
            badge.classList.add("healthy");
            badge.textContent = "Healthy";
          } else if (status.running && !status.healthy) {
            badge.classList.add("unhealthy");
            badge.textContent = "Unhealthy";
          } else {
            badge.classList.add("stopped");
            badge.textContent = "Stopped";
          }
        }
      }
    });

    socket.on("local-server:status", function (status) {
      var card = document.querySelector('[data-local-server="' + status.name + '"]');
      if (card) {
        var badge = card.querySelector(".sidecar-badge");
        if (badge) {
          badge.className = "sidecar-badge";
          if (status.running) {
            badge.classList.add("healthy");
            badge.textContent = "Running (" + status.toolCount + " tools)";
          } else if (status.error === "credentials_missing") {
            badge.classList.add("unconfigured");
            badge.textContent = "No Credentials";
          } else if (status.error === "runtime_unavailable") {
            badge.classList.add("stopped");
            badge.textContent = "Runtime Missing";
          } else {
            badge.classList.add("stopped");
            badge.textContent = "Stopped";
          }
        }
      }
    });
  }

  // ── Load Local MCP Servers ──
  async function loadLocalServers() {
    try {
      var res = await fetch("/api/admin/local-servers");
      if (!res.ok) throw new Error("Failed to load local servers");
      var data = await res.json();
      renderLocalServers(data);
    } catch (err) {
      localServersPanel.innerHTML = '<div class="loading">Failed to load local MCP servers.</div>';
      console.error(err);
    }
  }

  function renderLocalServers(data) {
    localServersPanel.innerHTML = "";

    var grid = document.createElement("div");
    grid.className = "sidecar-grid";

    var servers = data.servers || [];
    var credentials = data.credentials || [];
    var definitions = data.definitions || [];

    for (var i = 0; i < definitions.length; i++) {
      var def = definitions[i];
      var status = servers.find(function (s) { return s.name === def.name; }) || null;
      var cred = credentials.find(function (c) { return c.server === def.name; }) || null;
      var card = createLocalServerCard(def, status, cred);
      grid.appendChild(card);
    }

    localServersPanel.appendChild(grid);
  }

  function createLocalServerCard(def, status, cred) {
    var card = document.createElement("div");
    card.className = "sidecar-card";
    card.setAttribute("data-local-server", def.name);

    // Header row: name + status badge
    var header = document.createElement("div");
    header.className = "sidecar-header";

    var title = document.createElement("div");
    title.className = "sidecar-title";
    title.textContent = def.label;
    header.appendChild(title);

    var runtimeTag = document.createElement("span");
    runtimeTag.className = "local-server-runtime";
    runtimeTag.textContent = def.runtime;
    header.appendChild(runtimeTag);

    var badge = document.createElement("span");
    badge.className = "sidecar-badge";
    if (status && status.running) {
      badge.classList.add("healthy");
      badge.textContent = "Running (" + status.toolCount + " tools)";
    } else if (status && status.error === "credentials_missing") {
      badge.classList.add("unconfigured");
      badge.textContent = "No Credentials";
    } else if (status && status.error === "runtime_unavailable") {
      badge.classList.add("stopped");
      badge.textContent = "Runtime Missing";
    } else if (status && status.error === "process_crashed") {
      badge.classList.add("unhealthy");
      badge.textContent = "Crashed";
    } else if (status && !status.running) {
      badge.classList.add("stopped");
      badge.textContent = "Stopped";
    } else {
      badge.classList.add("unknown");
      badge.textContent = "Unknown";
    }
    header.appendChild(badge);
    card.appendChild(header);

    // Command info
    var cmdInfo = document.createElement("div");
    cmdInfo.className = "sidecar-url";
    cmdInfo.textContent = def.command + " " + def.args.join(" ");
    card.appendChild(cmdInfo);

    // Credential fields (if any)
    if (cred && cred.envVars.length > 0) {
      var credSection = document.createElement("div");
      credSection.className = "sidecar-creds";

      var credLabel = document.createElement("div");
      credLabel.className = "sidecar-creds-label";
      credLabel.textContent = "API Credentials";
      credSection.appendChild(credLabel);

      var inputs = {};

      for (var j = 0; j < cred.envVars.length; j++) {
        var envVar = cred.envVars[j];
        var fieldWrapper = document.createElement("div");
        fieldWrapper.className = "sidecar-cred-field";

        var fieldLabel = document.createElement("label");
        fieldLabel.className = "sidecar-cred-label";
        fieldLabel.textContent = envVar.name;
        fieldWrapper.appendChild(fieldLabel);

        var inputRow = document.createElement("div");
        inputRow.className = "sidecar-cred-input-row";

        var input = document.createElement("input");
        input.className = "sidecar-cred-input";
        input.type = "password";
        input.placeholder = envVar.configured ? "••••••••  (already set)" : "Paste your key here…";
        input.setAttribute("data-env", envVar.name);
        input.setAttribute("autocomplete", "off");
        inputRow.appendChild(input);

        var toggleVis = document.createElement("button");
        toggleVis.type = "button";
        toggleVis.className = "sidecar-cred-toggle";
        toggleVis.textContent = "👁";
        toggleVis.title = "Show/hide value";
        (function (inp, btn) {
          btn.addEventListener("click", function () {
            if (inp.type === "password") {
              inp.type = "text";
              btn.textContent = "🔒";
            } else {
              inp.type = "password";
              btn.textContent = "👁";
            }
          });
        })(input, toggleVis);
        inputRow.appendChild(toggleVis);

        fieldWrapper.appendChild(inputRow);

        var statusIndicator = document.createElement("div");
        statusIndicator.className = "sidecar-cred-indicator " + (envVar.configured ? "configured" : "missing");
        statusIndicator.textContent = envVar.configured ? "✓ Configured" : "✗ Not set";
        fieldWrapper.appendChild(statusIndicator);

        credSection.appendChild(fieldWrapper);
        inputs[envVar.name] = input;
      }

      card.appendChild(credSection);

      // Save + Restart buttons
      var saveActions = document.createElement("div");
      saveActions.className = "sidecar-actions";

      var saveBtn = document.createElement("button");
      saveBtn.className = "sidecar-btn save";
      saveBtn.textContent = "Save Credentials";
      (function (serverName, inputsMap, btn) {
        btn.addEventListener("click", function () {
          saveCredentials(serverName, inputsMap, btn);
        });
      })(def.name, inputs, saveBtn);
      saveActions.appendChild(saveBtn);

      var restartBtn = document.createElement("button");
      restartBtn.className = "sidecar-btn restart";
      restartBtn.textContent = "Restart";
      (function (name, btn) {
        btn.addEventListener("click", function () {
          restartLocalServer(name, btn);
        });
      })(def.name, restartBtn);
      saveActions.appendChild(restartBtn);

      card.appendChild(saveActions);
    } else {
      var noCredsNote = document.createElement("div");
      noCredsNote.className = "sidecar-creds-label";
      noCredsNote.textContent = "No credentials required";
      card.appendChild(noCredsNote);

      // Just a restart button
      var actionsDiv = document.createElement("div");
      actionsDiv.className = "sidecar-actions";

      var restBtn = document.createElement("button");
      restBtn.className = "sidecar-btn restart";
      restBtn.textContent = "Restart";
      (function (name, btn) {
        btn.addEventListener("click", function () {
          restartLocalServer(name, btn);
        });
      })(def.name, restBtn);
      actionsDiv.appendChild(restBtn);

      card.appendChild(actionsDiv);
    }

    // Error detail
    if (status && status.error && status.error !== "credentials_missing") {
      var errorNote = document.createElement("div");
      errorNote.className = "sidecar-coming-soon";
      errorNote.textContent = "Error: " + status.error;
      card.appendChild(errorNote);
    }

    return card;
  }

  async function restartLocalServer(name, button) {
    button.disabled = true;
    button.textContent = "Restarting…";
    try {
      var res = await fetch("/api/admin/local-servers/" + encodeURIComponent(name) + "/restart", {
        method: "POST"
      });
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        throw new Error(data.error || "Failed to restart");
      }
      showToast(name + " restarted");
      await loadLocalServers();
    } catch (err) {
      var message = err && err.message ? err.message : String(err);
      showToast("Error: " + message);
    } finally {
      button.disabled = false;
      button.textContent = "Restart";
    }
  }

  // ── Init ──
  loadTools();
  loadChannels();
  loadSidecars();
  loadLocalServers();
  loadEnv();
})();
