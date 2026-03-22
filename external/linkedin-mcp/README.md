# LinkedIn MCP Server

A Model Context Protocol (MCP) server that provides integration with LinkedIn's API, enabling AI applications to interact with LinkedIn profiles and company pages programmatically.

## Features

### Tools

| Tool | Description |
|------|-------------|
| `linkedin_get_profile` | Get authenticated LinkedIn user profile |
| `linkedin_get_posts` | Get recent posts from LinkedIn profile or company |
| `linkedin_create_post` | Publish a text post on LinkedIn |
| `linkedin_get_company` | Get LinkedIn company/organization page info |
| `linkedin_send_message` | Send a LinkedIn direct message |
| `linkedin_get_conversations` | List recent LinkedIn message conversations |
| `linkedin_get_post_comments` | Get comments on a LinkedIn post |
| `linkedin_reply_to_comment` | Reply to a comment on a LinkedIn post |

## Prerequisites

- Python 3.10+
- LinkedIn Developer account
- LinkedIn OAuth2 access token (obtain via 3-legged OAuth authorization code flow)

## Installation

```bash
cd external/linkedin-mcp
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Configuration

Create a `.env` file in the `linkedin-mcp` directory:

```env
LINKEDIN_ACCESS_TOKEN=your_oauth2_access_token
# Optional
LINKEDIN_CLIENT_ID=your_client_id
LINKEDIN_CLIENT_SECRET=your_client_secret
LINKEDIN_REFRESH_TOKEN=your_refresh_token
LINKEDIN_PERSON_ID=urn:li:person:xxx
LINKEDIN_ORG_ID=your_org_id
```

## Usage

```bash
python -m src.linkedin_mcp_server
```

The server communicates over stdio using the MCP protocol.

## License

[FSL-1.1-MIT](LICENSE.md) — Copyright 2026 Zylos Labs LLC
