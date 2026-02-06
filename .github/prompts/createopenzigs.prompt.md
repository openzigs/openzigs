@workspace /new

Act as a Senior Software Architect and Product Manager.

I am building a new project called "OpenZigs"—a secure, local, containerized AI agent platform.

The Goal: Create a local web server (Node.js/TypeScript) that allows a user to run a "God Mode" AI agent safely. The agent will utilize the GitHub Copilot SDK for reasoning and the Model Context Protocol (MCP) for tools.

Reference Material: Please analyze the openclaw codebase in my current workspace. Use openclaw as a functional reference for what the agent should do (messaging, file manipulation, autonomy), but do NOT use its implementation method (which uses direct CDP/Puppeteer). OpenZigs must be re-architected to use the modern GitHub Copilot SDK + MCP stack.

Architecture & Tech Stack:

Language: TypeScript (Strict mode).

Runtime: Node.js (running inside a Docker Container for isolation).

Brain: GitHub Copilot SDK (connecting to the user's GitHub account).

Tools: Standard MCP Servers (Filesystem, Brave Search, etc.).

Connectivity: Cloudflare Tunnel (to allow external webhooks like Discord/Telegram to reach the local agent).

Security (Critical): > * A Web UI (likely React/Next.js) where users can explicitly toggle Tools ON/OFF.

"Human-in-the-loop" mode: If a tool is marked "Risky" (e.g., write_file), the agent must pause and ask for permission via the UI or Messaging system before executing.

Your Task: Based on this architecture, please generate a Project Plan consisting of Epics and GitHub Issues.

Requirements for the Output:

Analyze openclaw to see what features we need to port (e.g., "Telegram Integration," "File Management").

Create 3-4 Major Epics (e.g., "Core Agent Setup," "Security & UI," "Messaging Bridge").

Break down Issues: For each Epic, list 3-5 specific user stories/tasks.

Technical Specifics: For the "Core Agent" epic, specifically mention setting up the CopilotClient and connecting it to a local McpServer.

Please output the plan in markdown format so I can copy it into GitHub Issues.