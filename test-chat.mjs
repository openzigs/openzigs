import { io } from "./ui/node_modules/socket.io-client/build/esm/index.js";

const token = "125285b1a6cf63dfef1a0c66cea0d179738220ccf6e8d4cdaad6a61f15aeaaeb";
const s = io("http://localhost:3000", {
  auth: { token },
  query: { clientId: "test-node-" + Date.now() },
});

let chatId;

s.on("connect", () => {
  console.log("socket connected, waiting for chat:connected...");
});

s.on("chat:connected", (data) => {
  chatId = data.chatId;
  console.log("chat:connected, chatId:", chatId);

  // Send first message using "content" field (not "message")
  s.emit("chat:message", { content: "what model are you?" });

  let fullResponse = "";
  let msgCount = 0;

  s.on("chat:stream", (d) => {
    const text = d.chunk || "";
    process.stdout.write(text);
    fullResponse += text;
  });

  s.on("chat:stream:end", () => {
    msgCount++;
    if (msgCount === 1) {
      console.log("\n\n--- FIRST MESSAGE OK ---");
      console.log("Response length:", fullResponse.length);

      // Send second message in same chat
      fullResponse = "";
      s.emit("chat:message", { content: "tell me more about yourself" });
    } else {
      console.log("\n\n--- SECOND MESSAGE OK ---");
      console.log("Response length:", fullResponse.length);
      s.disconnect();
      process.exit(0);
    }
  });

  s.on("chat:error", (d) => {
    console.error("\nERROR:", JSON.stringify(d));
    s.disconnect();
    process.exit(1);
  });
});

s.on("connect_error", (e) => {
  console.error("Connection error:", e.message);
  process.exit(1);
});

// Timeout after 2 minutes
setTimeout(() => {
  console.error("Timeout after 2 minutes");
  s.disconnect();
  process.exit(1);
}, 120000);
