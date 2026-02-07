/* eslint-disable no-undef */
(function () {
  "use strict";

  var promptList = document.getElementById("prompt-list");
  var formContainer = document.getElementById("prompt-form-container");
  var searchInput = document.getElementById("library-search");
  var addBtn = document.getElementById("add-prompt-btn");

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

  function parseList(value) {
    return value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
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

  // ── Load prompts ──
  var searchTimer = null;

  searchInput.addEventListener("input", function () {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      loadPrompts(searchInput.value.trim());
    }, 250);
  });

  addBtn.addEventListener("click", function () {
    showForm(null);
  });

  async function loadPrompts(query) {
    try {
      var url = "/api/admin/prompts";
      if (query) url += "?q=" + encodeURIComponent(query);
      var res = await fetch(url);
      if (!res.ok) throw new Error("Failed to load prompts");
      var data = await res.json();
      renderList(data.prompts || []);
    } catch (err) {
      promptList.innerHTML = '<div class="loading">Failed to load prompts.</div>';
      console.error(err);
    }
  }

  function renderList(prompts) {
    promptList.innerHTML = "";
    if (prompts.length === 0) {
      var empty = document.createElement("div");
      empty.className = "library-empty";
      empty.textContent = searchInput.value.trim()
        ? "No prompts match your search."
        : 'No prompts saved yet. Click "+ New Prompt" to create one.';
      promptList.appendChild(empty);
      return;
    }
    for (var i = 0; i < prompts.length; i++) {
      promptList.appendChild(createCard(prompts[i]));
    }
  }

  function createCard(prompt) {
    var card = document.createElement("div");
    card.className = "prompt-card";

    // Header: name + actions
    var header = document.createElement("div");
    header.className = "prompt-card-header";

    var name = document.createElement("div");
    name.className = "prompt-card-name";
    name.textContent = prompt.name;
    header.appendChild(name);

    var actions = document.createElement("div");
    actions.className = "prompt-card-actions";

    var editBtn = document.createElement("button");
    editBtn.className = "sidecar-btn restart";
    editBtn.textContent = "Edit";
    (function (p) {
      editBtn.addEventListener("click", function () { showForm(p); });
    })(prompt);
    actions.appendChild(editBtn);

    var deleteBtn = document.createElement("button");
    deleteBtn.className = "sidecar-btn delete-btn";
    deleteBtn.textContent = "Delete";
    (function (p) {
      deleteBtn.addEventListener("click", function () { deletePrompt(p.id, p.name); });
    })(prompt);
    actions.appendChild(deleteBtn);

    header.appendChild(actions);
    card.appendChild(header);

    // Description
    if (prompt.description) {
      var desc = document.createElement("div");
      desc.className = "prompt-card-desc";
      desc.textContent = prompt.description;
      card.appendChild(desc);
    }

    // Template preview
    var templatePre = document.createElement("pre");
    templatePre.className = "prompt-card-template";
    templatePre.textContent = prompt.template.length > 300
      ? prompt.template.slice(0, 300) + "…"
      : prompt.template;
    card.appendChild(templatePre);

    // Tags
    if (prompt.tags && prompt.tags.length > 0) {
      var tagsRow = document.createElement("div");
      tagsRow.className = "prompt-card-tags";
      for (var j = 0; j < prompt.tags.length; j++) {
        var tag = document.createElement("span");
        tag.className = "prompt-tag";
        tag.textContent = prompt.tags[j];
        tagsRow.appendChild(tag);
      }
      card.appendChild(tagsRow);
    }

    // Metadata
    var meta = document.createElement("div");
    meta.className = "prompt-card-meta";
    meta.textContent = "Updated " + new Date(prompt.updatedAt).toLocaleDateString();
    card.appendChild(meta);

    return card;
  }

  // ── Form ──
  function showForm(existing) {
    formContainer.className = "prompt-form-container";
    formContainer.innerHTML = "";

    var heading = document.createElement("h3");
    heading.className = "prompt-form-heading";
    heading.textContent = existing ? "Edit Prompt" : "New Prompt";
    formContainer.appendChild(heading);

    var nameInput = createTextInput(existing ? existing.name : "", "e.g., daily-summary");
    formContainer.appendChild(createField("Name", nameInput, "A unique, descriptive identifier."));

    var descInput = createTextInput(existing ? existing.description : "", "What this prompt does…");
    formContainer.appendChild(createField("Description", descInput, "Optional — helps you remember what it's for."));

    var templateArea = document.createElement("textarea");
    templateArea.className = "text-input prompt-textarea";
    templateArea.rows = 8;
    templateArea.placeholder = "Write your prompt template here.\nUse {{variable}} for dynamic placeholders.";
    templateArea.value = existing ? existing.template : "";

    var templateField = createField("Template", templateArea, null);
    formContainer.appendChild(templateField);

    // Live variable preview
    var previewRow = document.createElement("div");
    previewRow.className = "prompt-variable-preview";
    previewRow.id = "variable-preview";
    templateField.appendChild(previewRow);

    function updatePreview() {
      var matches = templateArea.value.match(/\{\{(\w+)\}\}/g);
      previewRow.innerHTML = "";
      if (matches && matches.length > 0) {
        var unique = [];
        var seen = {};
        for (var k = 0; k < matches.length; k++) {
          var v = matches[k].replace(/[{}]/g, "");
          if (!seen[v]) { seen[v] = true; unique.push(v); }
        }
        var label = document.createElement("span");
        label.className = "prompt-preview-label";
        label.textContent = "Variables: ";
        previewRow.appendChild(label);
        for (var m = 0; m < unique.length; m++) {
          var pill = document.createElement("code");
          pill.className = "prompt-variable-pill";
          pill.textContent = "{{" + unique[m] + "}}";
          previewRow.appendChild(pill);
        }
      }
    }
    templateArea.addEventListener("input", updatePreview);
    updatePreview();

    var tagsInput = createTextInput(
      existing && existing.tags ? existing.tags.join(", ") : "",
      "marketing, daily, report"
    );
    formContainer.appendChild(createField("Tags", tagsInput, "Comma-separated. Used for filtering."));

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
    saveBtn.textContent = existing ? "Update Prompt" : "Save Prompt";
    (function (ex) {
      saveBtn.addEventListener("click", function () {
        savePrompt(ex, nameInput, descInput, templateArea, tagsInput, saveBtn);
      });
    })(existing);
    formActions.appendChild(saveBtn);
    formContainer.appendChild(formActions);

    formContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
    nameInput.focus();
  }

  async function savePrompt(existing, nameInput, descInput, templateArea, tagsInput, button) {
    var name = nameInput.value.trim();
    var template = templateArea.value.trim();
    if (!name || !template) {
      showToast("Name and template are required.");
      return;
    }

    var payload = {
      name: name,
      template: template,
      description: descInput.value.trim(),
      tags: parseList(tagsInput.value)
    };

    button.disabled = true;
    try {
      var url = existing ? "/api/admin/prompts/" + existing.id : "/api/admin/prompts";
      var method = existing ? "PUT" : "POST";
      var res = await fetch(url, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        throw new Error(data.error || "Failed to save prompt");
      }
      showToast(existing ? "Prompt updated" : "Prompt saved");
      formContainer.className = "prompt-form-container hidden";
      await loadPrompts(searchInput.value.trim());
    } catch (err) {
      showToast("Error: " + (err.message || err));
    } finally {
      button.disabled = false;
    }
  }

  async function deletePrompt(id, name) {
    if (!confirm('Delete prompt "' + name + '"? This cannot be undone.')) return;
    try {
      var res = await fetch("/api/admin/prompts/" + id, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      showToast('Prompt "' + name + '" deleted');
      await loadPrompts(searchInput.value.trim());
    } catch (err) {
      showToast("Error: " + (err.message || err));
    }
  }

  // ── Init ──
  loadPrompts();
})();
