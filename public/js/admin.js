/* eslint-disable no-undef */
(function () {
  "use strict";

  const toolsList = document.getElementById("tools-list");
  const envStatus = document.getElementById("env-status");
  const channelsForm = document.getElementById("channels-form");
  const sidecarsPanel = document.getElementById("sidecars-panel");

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
    const categoryOrder = ["filesystem", "search", "browser", "shell"];

    for (const category of categoryOrder) {
      const tools = grouped[category];
      if (!tools || tools.length === 0) continue;

      const section = document.createElement("div");
      section.className = "tool-category";

      const label = document.createElement("div");
      label.className = "tool-category-label";
      label.textContent = category;
      section.appendChild(label);

      for (const tool of tools) {
        const item = document.createElement("div");
        item.className = "tool-item";

        const info = document.createElement("div");
        info.className = "tool-info";

        const name = document.createElement("div");
        name.className = "tool-name";
        name.textContent = tool.name;
        info.appendChild(name);

        const desc = document.createElement("div");
        desc.className = "tool-desc";
        desc.textContent = tool.description;
        info.appendChild(desc);

        item.appendChild(info);

        const risk = document.createElement("span");
        risk.className = "tool-risk " + tool.riskLevel;
        risk.textContent = tool.riskLevel;
        item.appendChild(risk);

        const toggle = document.createElement("label");
        toggle.className = "toggle";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = tool.enabled;
        checkbox.addEventListener("change", () => toggleTool(tool.name, checkbox.checked, checkbox));
        toggle.appendChild(checkbox);
        const slider = document.createElement("span");
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

    // Header row: name + status badge
    var header = document.createElement("div");
    header.className = "sidecar-header";

    var title = document.createElement("div");
    title.className = "sidecar-title";
    title.textContent = cred.label;
    header.appendChild(title);

    var badge = document.createElement("span");
    badge.className = "sidecar-badge";
    if (status && status.running && status.healthy) {
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
    header.appendChild(badge);
    card.appendChild(header);

    // Credential checklist
    if (cred.envVars.length > 0) {
      var credSection = document.createElement("div");
      credSection.className = "sidecar-creds";

      var credLabel = document.createElement("div");
      credLabel.className = "sidecar-creds-label";
      credLabel.textContent = "Required credentials";
      credSection.appendChild(credLabel);

      for (var j = 0; j < cred.envVars.length; j++) {
        var envVar = cred.envVars[j];
        var row = document.createElement("div");
        row.className = "sidecar-cred-row";

        var dot = document.createElement("span");
        dot.className = "env-dot " + (envVar.configured ? "configured" : "missing");
        row.appendChild(dot);

        var varName = document.createElement("span");
        varName.className = "sidecar-cred-name";
        varName.textContent = envVar.name;
        row.appendChild(varName);

        var varStatus = document.createElement("span");
        varStatus.className = "sidecar-cred-status " + (envVar.configured ? "configured" : "missing");
        varStatus.textContent = envVar.configured ? "Set" : "Missing";
        row.appendChild(varStatus);

        credSection.appendChild(row);
      }

      card.appendChild(credSection);
    } else {
      var noCredsNote = document.createElement("div");
      noCredsNote.className = "sidecar-creds-label";
      noCredsNote.textContent = "No credentials required";
      card.appendChild(noCredsNote);
    }

    // URL info
    if (status && status.url) {
      var urlRow = document.createElement("div");
      urlRow.className = "sidecar-url";
      urlRow.textContent = status.url;
      card.appendChild(urlRow);
    }

    // Actions
    if (dockerAvailable) {
      var actions = document.createElement("div");
      actions.className = "sidecar-actions";

      var restartBtn = document.createElement("button");
      restartBtn.className = "sidecar-btn restart";
      restartBtn.textContent = "Restart";
      restartBtn.disabled = !status || status.error === "credentials_missing";
      restartBtn.addEventListener("click", function () {
        restartSidecar(cred.platform, restartBtn);
      });
      actions.appendChild(restartBtn);

      card.appendChild(actions);
    }

    return card;
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
  }

  // ── Init ──
  loadTools();
  loadChannels();
  loadSidecars();
  loadEnv();
})();
