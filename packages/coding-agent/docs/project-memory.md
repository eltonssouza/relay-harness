# Project initialization and graph memory

Run `/init` in a trusted project. Relay creates a project-specific `AGENTS.md` when absent, preserves an existing guide, and appends the distributed core guidelines from `resources/AGENTS-template.md` once. A model task then inspects README files, manifests, source, tests and CI to enrich the guide with verified project knowledge. Existing instructions take precedence. Initialization changes documentation and derived memory, not project implementation.

The guide follows a specification that evolves: record durable architecture, conventions, confirmed hurdles and solutions, and a verification checklist; update existing rules rather than accumulating task logs. The model needs a configured provider for this enrichment. The initial guide and graph are generated locally without provider calls.

## Local memory

Relay writes `.relay/memory/graph.json` and an offline `.relay/memory/graph.html` at the Git repository root, or at the working directory for projects without Git. `/graph` refreshes the index and opens the viewer. You can also open the HTML file directly. Search, type filters, node details, relationships, pan and zoom work without a server or an Obsidian installation.

The built-in project development logbook records work separately at `.relay/memory/logbook/`. See [Project development logbook](logbook.md) for its event format, commands, and recovery limits.

The graph indexes files, directories, JavaScript package manifests and dependencies, named declarations, JavaScript/TypeScript static imports and re-exports, literal `require` calls, and relative Markdown links. Workspace package names connect to their local manifests. Other languages appear in the file map with detected declarations; their imports are not resolved. Import extraction is lexical navigation, not a compiler: aliases, generated imports and dynamic module loading require source inspection.

The harness automatically refreshes initialized memory before every model call and at task completion. This includes files created, changed, renamed or deleted during the same task, and edits to `AGENTS.md`. Like project instructions, graph context stays current for subsequent model calls. No manual refresh is required during normal development. Updates scan the repository and reuse unchanged entries; changes made while Relay is idle appear on the next task, graph query or `/graph`.

Up to six relevant entries and their direct relationships enter the system context, bounded to 6,000 characters. The deferred `project_memory` tool retrieves other entries and refreshes first. The complete graph is never injected into the model context. This reduces repeated exploration; it does not guarantee a fixed token saving or replace source verification.

Git discovery respects nested ignore files for untracked files and includes tracked files. Without Git, discovery respects `.gitignore` and `.relayignore`. Dependency, build, cache and graph output directories, common credential files, `.env` files and symlinks are excluded. Large and binary files retain path/size metadata but no text-derived summary. Source bodies and environment values are not copied into memory. File names, symbols and documentation headings remain local project data; review them before sharing the generated graph.

Indexing is limited to 30,000 files and text extraction to 256 KiB per file. The command reports incomplete indexing. `/init refresh` updates memory without calling a model or altering `AGENTS.md`. Add `.relay/memory/` to your project's ignore rules if you do not want derived memory versioned. The HTML viewer is a snapshot; refresh the browser after the index changes.
