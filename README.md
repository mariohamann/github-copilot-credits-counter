# github-copilot-credits-counter

Extract and summarize GitHub Copilot credit usage from VS Code chat sessions.

## Usage

Run directly with npx — no installation required:

```bash
npx github-copilot-credits-counter
```

This automatically detects your VS Code workspace storage and writes output to a `copilot-credits/` folder in the current directory.

### Options

```bash
# Custom path to VS Code workspaceStorage
npx github-copilot-credits-counter --path ~/Library/Application\ Support/Code/User/workspaceStorage
npx github-copilot-credits-counter -p /custom/path

# Skip writing output files (print to console only)
npx github-copilot-credits-counter --no-write
```

## Output

Results are written to `copilot-credits/` in the current working directory:

```
copilot-credits/
  summary.md          # Markdown report with per-project breakdown
  summary.html        # Interactive HTML report with charts
  data/
    <workspace-hash>.json   # Per-project raw data
```

Each `.json` file in `data/` contains the full session data for one project, including per-model credit usage and token counts.
