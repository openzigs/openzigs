---
title: "ADR-0001: Post-Action Registry Plugin System"
status: "Accepted"
date: "2025-07-14"
authors: ["Matthew Cronin"]
tags: ["architecture", "decision", "post-actions", "plugin-system", "registry"]
supersedes: ""
superseded_by: ""
---

# ADR-0001: Post-Action Registry Plugin System

## Status

Proposed | **Accepted** | Rejected | Superseded | Deprecated

## Context

Pipeline stages in openzigs support optional "post-actions" — deterministic operations that execute after a stage completes (e.g., creating GitHub issues from findings, sending webhook notifications). The original implementation hardcoded post-action types in three places:

1. **Backend dispatch** (`src/tasks/post-actions.ts`) — a `switch` statement mapping action types to handler functions. Adding a new action required modifying this switch and writing inline handling code.
2. **UI dropdown** (`ui/components/pipeline/pipeline-editor.tsx`) — a `POST_ACTION_TYPES` constant array. Adding a new option required editing the constant.
3. **UI config form** — a dedicated React component per action type (`GitHubIssuesConfig`). Each new action needed a bespoke form component with hardcoded field names, labels, and input types.

This approach had several problems:

- **Tight coupling**: UI and backend shared implicit knowledge of field names/types with no contract.
- **Poor extensibility**: Every new action required coordinated edits across three files in two packages.
- **No discoverability**: There was no API to ask "what post-actions exist?" — the UI just knew.
- **No validation metadata**: Field constraints (min/max, required, enums) were scattered across UI components and backend validation.

## Decision

Replace the hardcoded post-action system with a **Post-Action Registry** — a singleton registry where action types are registered at startup with a handler function and a JSON Schema config descriptor. The UI fetches available types from a new API endpoint and renders config forms dynamically from the schema.

**Key design choices:**

1. **Singleton registry** (`PostActionRegistryImpl`) with `register()`, `unregister()`, `get()`, `list()`, `execute()` methods.
2. **JSON Schema subset** (`ConfigSchema` / `ConfigFieldSchema`) for config descriptors — supports `string`, `number`, `boolean`, `array` field types with `title`, `description`, `default`, `enum`, `enumLabels`, `placeholder`, `minimum`, `maximum`, and `items` metadata.
3. **API endpoint** (`GET /api/admin/post-actions`) returns all registered types with their schemas but without handler functions (safe serialisation via `PostActionTypeInfo`).
4. **Dynamic UI form renderer** (`DynamicConfigForm` component) that maps field schemas to appropriate HTML inputs: text inputs, number inputs, checkboxes, select dropdowns, and comma-separated array inputs.
5. **Built-in registrations** happen at server startup via `registerBuiltinPostActions()` before the Express server starts listening.

## Consequences

### Positive

- **POS-001**: Adding a new post-action type requires a single `postActionRegistry.register()` call — no UI code changes needed.
- **POS-002**: Config form rendering is fully data-driven — the UI adapts automatically to any registered schema with no bespoke components.
- **POS-003**: The API endpoint provides a single source of truth for available actions, eliminating implicit coupling between frontend and backend.
- **POS-004**: Field-level metadata (titles, descriptions, defaults, constraints) lives alongside the handler, keeping documentation and implementation co-located.
- **POS-005**: The registry pattern enables future plugin loading (e.g., scanning a directory for post-action modules at startup).

### Negative

- **NEG-001**: Dynamic form rendering trades flexibility for some UX polish — custom layouts, conditional field visibility, or complex validation require extending the schema vocabulary.
- **NEG-002**: The JSON Schema subset is intentionally minimal; supporting nested objects, `oneOf`, or conditional schemas would require additional UI rendering logic.
- **NEG-003**: The `usePostActionTypes()` hook makes a network request on every mount of the `PostActionEditor` component; while lightweight, this could be optimised with SWR or a context provider if the post-action type list becomes large.

## Alternatives Considered

### Zod-based schema with `z.toJSONSchema()`

- **ALT-001**: **Description**: Use Zod schemas (already a project dependency) to define config validation, then convert to JSON Schema via `z.toJSONSchema()` for the UI. This would provide runtime validation and type inference alongside the form descriptor.
- **ALT-002**: **Rejection Reason**: `z.toJSONSchema()` generates full JSON Schema with `$schema`, `$ref`, and vocabulary features that far exceed what a simple config form needs. The output would require a heavy JSON Schema form library (e.g., `react-jsonschema-form`) on the UI side, adding significant bundle weight for little benefit. A minimal custom subset is simpler, lighter, and gives us full control over the form rendering.

### Hardcoded component registry (React-side)

- **ALT-003**: **Description**: Keep backend dispatch but register React components in a frontend registry keyed by action type. Each action would have a dedicated React component, but discovery would be centralised.
- **ALT-004**: **Rejection Reason**: This still requires a new React component per action type and doesn't solve the backend/frontend coupling problem. The config structure remains implicit — there's no machine-readable descriptor the backend can validate against.

### External plugin files (dynamic import)

- **ALT-005**: **Description**: Load post-action definitions from external JS/TS files in a plugins directory via dynamic `import()`, enabling third-party actions without modifying core code.
- **ALT-006**: **Rejection Reason**: Premature for the current use case. The registry pattern is a prerequisite for plugin loading — once the registry exists, adding file-based plugin scanning is a straightforward extension. Shipping the registry first validates the abstraction before adding filesystem discovery complexity.

## Implementation Notes

- **IMP-001**: The registry is a module-level singleton (`postActionRegistry`) exported from `src/tasks/post-action-registry.ts`. Tests use `postActionRegistry.clear()` in `beforeEach` to reset state.
- **IMP-002**: `registerBuiltinPostActions()` is called in `src/server.ts` before `loadConfig()` and Express route mounting, ensuring actions are available when the API serves requests.
- **IMP-003**: The `PostActionTypeInfo` type is `Omit<PostActionDefinition, "handler">` — the `list()` method strips handlers to prevent serialisation of functions over the API.
- **IMP-004**: The `DynamicConfigForm` component handles all five field types (string, string+enum, number, boolean, array) and applies defaults from the schema when the user selects a new action type.
- **IMP-005**: The `send-webhook` built-in action was added alongside the registry to validate the architecture with a second action type beyond `create-github-issues`.

## References

- **REF-001**: Epic #171 — Prompt Library Stage Editing (parent feature)
- **REF-002**: PR #178 — Implementation PR containing the registry, dynamic UI, and built-in actions
- **REF-003**: `src/tasks/post-action-registry.ts` — Registry implementation
- **REF-004**: `src/tasks/post-actions.ts` — Built-in action handlers and registration
- **REF-005**: `ui/components/pipeline/pipeline-editor.tsx` — Dynamic form renderer (`DynamicConfigForm`, `PostActionEditor`)
