# Personal Assistant Expansion

## Epic Description
This epic focuses on transforming OpenZigs into a full-fledged Personal Assistant with advanced document handling capabilities and enhanced tool management features. The goal is to integrate various MCP servers, implement granular control over tool usage, and ensure robust session management and security protocols.

### Child Issues:

1. **Integrations** - Implement Core Personal Assistant MCP Servers (Gmail, Calendar, Slack, Postgres).
   - Description: Integrate the following MCP servers to enhance OpenZigs' capabilities:
     - **Gmail**: Implement the Gmail MCP server for reading/searching emails and drafting replies. Reference: [Gmail MCP Server](https://github.com/GongRzhe/Gmail-MCP-Server).
     - **Calendar**: Integrate a calendar service for scheduling and managing events.
     - **Slack**: Implement Slack integration for messaging and notifications.
     - **Postgres**: Integrate a PostgreSQL MCP server for database access. Reference: [Postgres MCP Server](https://github.com/quarkiverse/quarkus-mcp-servers/tree/main/jdbc).
   - Related Documentation: Update `ARCHITECTURE.md` and `USER_GUIDE.md`.

2. **Document Processing** - Implement Markitdown MCP Wrapper (File conversion service).
   - Description: Create a tool that converts various files (PDF, Office, etc.) into Markdown for LLM consumption using the Markitdown MCP server. Reference: [Markitdown](https://github.com/microsoft/markitdown).
   - Related Documentation: Update `ARCHITECTURE.md` and `USER_GUIDE.md`.

3. **Granular Control** - Implement Per-Tool Enable/Disable Logic in Config & UI.
   - Description: Develop a new layer of control in `config.json` allowing users to enable an MCP server (e.g., "Gmail") but disable specific tools within it (e.g., enable `read_email` but disable `send_email`). Update the UI to allow users to toggle tools individually.
   - Related Documentation: Update `ARCHITECTURE.md` and `USER_GUIDE.md`.

4. **Architecture** - Design Session Management & Dynamic Tool Loading Strategy.
   - Description: Investigate strategies for managing the LLM's context window and session state, especially with many tools enabled. Analyze whether to implement dynamic tool loading based on user intent and whether to maintain a persistent session manager.
   - Related Documentation: Update `ARCHITECTURE.md` and `USER_GUIDE.md`.

5. **Security** - Implement Human-Confirmation Flow for Destructive Tools.
   - Description: Develop a mechanism to flag specific tools as "High Risk" (like `postgres.query` or `gmail.send`) and require explicit user confirmation in the UI before execution.
   - Related Documentation: Update `ARCHITECTURE.md` and `USER_GUIDE.md`.