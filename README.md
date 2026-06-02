# github-copilot-credits-counter

Reads your local VS Code chat session files and summarizes GitHub Copilot credit usage per project — no API calls, no authentication required.

## How it works

VS Code stores Copilot chat sessions locally on disk. This tool scans those files, extracts the credit cost and model for each completed request, and aggregates the results per project.

### Limitations

- Only sessions stored locally by VS Code are counted. Cleared or missing sessions won't appear.
- Only completed requests have credit data — cancelled or failed ones are skipped.
- The internal session format may change with VS Code updates, which could break parsing.
- Token counts are not always available, depending on the model and Copilot version.

## Usage

Run directly with npx — no installation required:

```bash
# npm
npx github-copilot-credits-counter@latest

# pnpm
pnpm dlx github-copilot-credits-counter@latest
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

## Development

This project was only tested with VS Code on macOS. It may work on other platforms but that is not guaranteed. I'm open to contributions to improve cross-platform compatibility.
