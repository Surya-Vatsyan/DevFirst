# DevFirst

DevFirst is a security-focused JavaScript/TypeScript analysis platform with:

- an HTTP API for ZIP-based project scanning
- a production-ready CLI for local and CI/CD usage
- static security scanning with optional AI-assisted explanations
- optional sandbox execution for runtime behavior checks

It is designed for deterministic output, CI build gating, and practical developer workflows (including audited override support).

## Highlights

- Static analysis for common risky patterns (SQL injection, XSS vectors, hardcoded secrets, taint-flow-style checks)
- Secure ZIP extraction with traversal protection, entry limits, and size limits
- Optional sandbox execution stage for runtime risk signals
- AI explanation layer (optional, controlled by API key)
- Deterministic grouping/sorting and top-risk prioritization
- CI/CD controls:
  - `--fail-on=high|medium|low`
  - `--override="reason"` with audit logging
  - `--json` and `--output=...`
  - `--quiet`
  - optional `devguard.config.json`

## Tech Stack

- Node.js + Express
- OpenAI Node SDK (optional AI layer)
- Multer + Unzipper for secure upload/extraction
- Jest + Supertest for tests

## Project Structure

```text
.
├─ app.js
├─ server.js
├─ cli/
│  ├─ index.js
│  ├─ formatter.js
│  ├─ printer.js
│  └─ utils.js
├─ sandbox/
│  └─ executor.js
├─ src/
│  ├─ config/
│  ├─ controllers/
│  ├─ core/
│  │  ├─ analyzeProject.js
│  │  ├─ fileCollector.js
│  │  ├─ blockAnalyzer.js
│  │  ├─ executionEngine.js
│  │  ├─ findingEnricher.js
│  │  └─ resultBuilder.js
│  ├─ middlewares/
│  ├─ routes/
│  ├─ services/
│  └─ utils/
├─ tests/
└─ uploads/ + reports/ (runtime artifacts)
```

## Requirements

- Node.js 18+ recommended
- npm
- Docker (optional but recommended for sandbox execution stage)
- OpenAI API key (optional, only if you want AI features)

## Installation

```bash
npm install
```

## Environment Variables

Create/update `.env`:

```env
NODE_ENV=development
PORT=3000

# Optional AI
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5
```

## Run the API Server

```bash
npm start
```

Server starts on `http://localhost:3000` (or your configured `PORT`).

## API Endpoints

### Health

`GET /health`

### Upload and analyze ZIP

`POST /api/upload` (`multipart/form-data`, field name: `file`)

Security constraints include:

- ZIP max size: 10 MB
- max entries: 5000
- max extracted file size: 2 MB
- allowed extensions: `.js`, `.json`, `.ts`
- path traversal and duplicate entry protections

### Explain snippet (AI)

`POST /api/explain`

Request body:

```json
{
  "codeSnippet": "const sql = \"SELECT * FROM users WHERE id=\" + userInput;"
}
```

### Fetch report by ID

`GET /api/report/:reportId`

## CLI Usage

The project exposes a `devguard` binary.

### Local run (without global install)

```bash
node cli/index.js scan <path>
```

### Global run

```bash
npm link
devguard scan <path>
```

On Windows PowerShell with strict execution policy, use:

```powershell
devguard.cmd scan <path>
```

### Core commands

```bash
devguard scan .
devguard scan . --json
devguard scan . --json --output=report.json
devguard scan . --fail-on=high
devguard scan . --override="urgent production fix"
devguard scan . --quiet
```

### CLI flags

- `--json`: machine-readable JSON output
- `--output=<path>`: write JSON output to a file (used with `--json`)
- `--quiet`: minimal summary output (suppresses rich/emoji formatting)
- `--fail-on=high|medium|low`: CI build gate threshold
- `--override="reason"`: bypass blocking exit code and append audit entry

### Exit codes

- `0`: success or override-applied pass
- `1`: blocked build or operational error

## Config File

Optional `devguard.config.json` in repo root:

```json
{
  "failOn": "medium",
  "ignore": ["node_modules", "dist"]
}
```

Rules:

- CLI flags override config values
- `ignore` filters findings by file path matching

## JSON Output Shape

`--json` mode returns:

```json
{
  "success": true,
  "summary": {},
  "topRisks": [],
  "groupedFindings": [],
  "execution": {},
  "aiReport": {}
}
```

## Override Audit Log

When a blocking scan is bypassed via `--override`, DevGuard appends an entry to:

`devguard-overrides.log`

Each line is JSON with:

- `timestamp`
- `reason`
- `severityCounts`
- `topRisks`

## Testing

```bash
npm test
```

Integration tests cover:

- upload security constraints (invalid ZIP, traversal rejection, size limits)
- concurrency behavior
- rate limiting
- end-to-end upload/report flow

## CI/CD Example

```bash
devguard scan . --json --output=devguard-report.json --fail-on=medium
```

Recommended policy:

- keep `failOn` at `high` or `medium`
- use `--override` only for urgent, accountable exceptions
- archive JSON reports as build artifacts

## Security Notes

- DevGuard never disables scanning when override is used; override affects exit blocking only.
- Sandbox execution requires Docker; if unavailable, static analysis still runs.
- API and CLI are intended to be deterministic and automation-friendly.

## License

ISC

