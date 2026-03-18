# Repository Guidelines

## Project Structure

- `src/`: VS Code extension source (TypeScript). Main entry: `src/extension.ts`.
- `scripts/`: build tooling (currently `scripts/build.ts` uses esbuild).
- `dist/`: bundled output produced by the build (generated; do not hand-edit).
- `media/`: extension assets (icons, etc.).
- `.vscodeignore`: packaging include/exclude rules for the VSIX.

## Build, Package, and Local Development

This project uses Bun to run scripts.

- Install dependencies: `bun install`
- Build the extension bundle: `bun run build` (outputs to `dist/`)
- Build with sourcemaps for debugging: `bun run build:debug`
- Package a VSIX: `bun run package` (runs `vsce package`)
- Debug in VS Code: run `bun run build:debug`, then press `F5` to start an Extension Host (see `.vscode/launch.json`).

Tip: the build script also supports watch mode via `bun scripts/build.ts --watch` for faster iteration.

## Coding Style & Naming

- Language/runtime: TypeScript, ES modules (`"type": "module"`), targeting Node 18.
- Formatting: keep consistent with existing code (2-space indentation, double quotes, trailing commas, no semicolons).
- Types: prefer explicit types and `import type` for type-only imports; avoid `any`.
- Naming: `camelCase` for values/functions, `PascalCase` for types/classes.
- Output/logging: prefer writing user-visible logs to the VS Code Output channel rather than `console.log`.

## Testing Guidelines

There is currently no `tests/` directory or enforced coverage for this package. If you add tests, prefer Bun’s test runner and place files under `tests/` named `*.test.ts` (example: `tests/strip-ansi.test.ts`).

## Commit & Pull Request Guidelines

- Commit messages follow Conventional Commits (examples seen in history: `feat: ...`, `fix: ...`, `docs: ...`).
- Keep commits focused and avoid checking in generated artifacts (`dist/` and `*.vsix`) unless intentionally releasing.
- PRs should include: a short summary, how to verify (commands + expected behavior), and screenshots/GIFs for user-facing changes (commands, status bar, Output channel, settings).

## Security & Configuration

- Never commit secrets or tokens. Leave debug-only settings like `copilotApi.showToken` off by default.
- Proxy support is opt-in via environment variables when enabled by configuration (see `copilotApi.proxyEnv`).
