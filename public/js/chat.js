/* eslint-disable no-undef */
(function () {
  "use strict";

  // ── Elements ──
  const messagesEl = document.getElementById("messages");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("message-input");
  const sendBtn = document.getElementById("send-btn");
  const statusDot = document.getElementById("connection-status");
  const modelSelect = document.getElementById("model-select");
  const approvalOverlay = document.getElementById("approval-overlay");
  const approvalTool = document.getElementById("approval-tool");
  const approvalExplanation = document.getElementById("approval-explanation");
  const approvalPreview = document.getElementById("approval-preview");
  const approvalApproveBtn = document.getElementById("approval-approve");
  const approvalDenyBtn = document.getElementById("approval-deny");

  // ── State ──
  let chatId = null;
  let streamingMessageEl = null;
  let streamingContent = "";
  let pendingApprovalId = null;

  // ── Socket.IO ──
  const socket = io({
    transports: ["websocket", "polling"]
  });

  socket.on("connect", () => {
    statusDot.className = "status-dot connected";
    statusDot.title = "Connected";
  });

  socket.on("disconnect", () => {
    statusDot.className = "status-dot disconnected";
    statusDot.title = "Disconnected";
    input.disabled = true;
    sendBtn.disabled = true;
  });

  socket.on("chat:connected", (data) => {
    chatId = data.chatId;
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  });

  socket.on("chat:response", (data) => {
    finalizeStream();
    if (data.content) {
      appendMessage("assistant", data.content);
    }
  });

  socket.on("chat:stream", (data) => {
    if (!streamingMessageEl) {
      streamingMessageEl = createMessageEl("assistant");
      streamingContent = "";
      messagesEl.appendChild(streamingMessageEl);
    }
    streamingContent += data.chunk;
    streamingMessageEl.textContent = streamingContent;
    appendCursor(streamingMessageEl);
    scrollToBottom();
  });

  socket.on("chat:stream:end", () => {
    finalizeStream();
  });

  socket.on("chat:error", (data) => {
    finalizeStream();
    appendMessage("error", data.error || "An error occurred");
    enableInput();
  });

  socket.on("approval:request", (data) => {
    pendingApprovalId = data.id;
    approvalTool.textContent = data.tool;
    approvalExplanation.textContent = data.explanation || "";
    approvalPreview.textContent = data.preview || JSON.stringify(data.args, null, 2);
    approvalOverlay.classList.remove("hidden");
  });

  // ── Approval handlers ──
  function handleApprovalResponse(approved) {
    if (pendingApprovalId) {
      socket.emit("approval:response", { approvalId: pendingApprovalId, approved });
      pendingApprovalId = null;
      approvalOverlay.classList.add("hidden");
    }
  }

  approvalApproveBtn.addEventListener("click", () => handleApprovalResponse(true));
  approvalDenyBtn.addEventListener("click", () => handleApprovalResponse(false));

  // ── Send message ──
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !chatId) return;

    appendMessage("user", text);
    socket.emit("chat:message", {
      content: text,
      model: modelSelect.value || undefined
    });

    input.value = "";
    autoResize();
    disableInput();
  });

  // Enter to send, Shift+Enter for newline
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event("submit"));
    }
  });

  // Auto-resize textarea
  input.addEventListener("input", autoResize);

  function autoResize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 150) + "px";
  }

  // ── Helpers ──
  function createMessageEl(role) {
    const el = document.createElement("div");
    el.className = "message " + role;
    return el;
  }

  function appendMessage(role, text) {
    const el = createMessageEl(role);
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function appendCursor(el) {
    let cursor = el.querySelector(".cursor");
    if (!cursor) {
      cursor = document.createElement("span");
      cursor.className = "cursor";
    }
    el.appendChild(cursor);
  }

  function finalizeStream() {
    if (streamingMessageEl) {
      const cursor = streamingMessageEl.querySelector(".cursor");
      if (cursor) cursor.remove();
      streamingMessageEl = null;
      streamingContent = "";
      enableInput();
    }
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function disableInput() {
    input.disabled = true;
    sendBtn.disabled = true;
  }

  function enableInput() {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  }

  // ── Models ──
  async function loadModels() {
    try {
      const res = await fetch("/api/models");
      if (!res.ok) return;
      const data = await res.json();
      modelSelect.innerHTML = "";
      if (data.models && data.models.length > 0) {
        for (const model of data.models) {
          const opt = document.createElement("option");
          opt.value = model.id;
          opt.textContent = model.id;
          if (data.selectedModel === model.id) {
            opt.selected = true;
          }
          modelSelect.appendChild(opt);
        }
        modelSelect.disabled = false;
      } else {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No models available";
        modelSelect.appendChild(opt);
      }
    } catch (err) {
      // Models endpoint not available, leave disabled
      console.error("Failed to load models:", err);
    }
  }

  modelSelect.addEventListener("change", async () => {
    const modelId = modelSelect.value;
    if (!modelId) return;
    try {
      await fetch("/api/models/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId })
      });
    } catch (err) {
      // Silently fail on save — selection still used per-message
      console.warn("Failed to persist model selection:", err);
    }
  });

  loadModels();
})();
