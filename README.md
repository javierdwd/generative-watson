# AI Detective

AI Detective is a detective game built with Next.js, Node.js, Fastify, and
LangGraph.js. CopilotKit connects the interface to the game agent through its
Next.js runtime and AG-UI.

## Features

- The API and game workflow are TypeScript, using `@langchain/langgraph`.
- The incident report explains the crime before interviews begin. The opening
  report contains no suspect names or alibis; selecting a suspect introduces
  their account.
- Cases deliberately vary between homicides and robberies, with a wider range of
  objects, methods, settings, and motives.
- Each hidden evidence slot has a **Reveal** button. It uncovers that clue only,
  without revealing the solution.
- The separate **Display solution** debug control shows the full resolution
  without changing the game's status.

## Run locally

Requirements: Node.js 22 or later, an OpenAI API key, and a TypeSafe API key.

```bash
npm install
cp backend/.env.example backend/.env
```

Add `OPENAI_API_KEY` and `TYPESAFE_API_KEY` to `backend/.env`. OpenAI handles
case generation, validation, and suspect dialogue; Jev via TypeSafe handles
message routing, evidence-unlock decisions, and the case relevance meter. Then
start both services in separate terminals from this directory:

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

Open <http://localhost:3000>. Fastify listens on port `8123`. All interface
requests go through CopilotKit at `/api/copilotkit`, which streams the backend's
`/agui` endpoint. To point the frontend at a different backend, set
`BACKEND_URL` in `frontend/.env.local`.

CopilotKit runs locally and does not need a cloud API key. OpenAI and TypeSafe
keys power the game agent.

The frontend uses CopilotKit's headless `useAgent` and `useCopilotKit` APIs for
case creation, starting the investigation, suspect selection, chat, Reveal,
accusation, timeout, best-effort tab-close cleanup, the relevance meter, and Display solution. AG-UI streams
messages and an explicit public state projection. Session cookies are forwarded
through the runtime; client-supplied state and history cannot overwrite the case.

## Progress logs

The backend uses Pino for API requests, case drafting, validation, corrections,
Jev routing, dialogue, and relevance evaluation. Logs include the stage and elapsed
milliseconds. Set `LOG_LEVEL` in `backend/.env` (`info` by default).

Generation makes one initial draft and at most three corrections of that draft.
Each model request has at most three transport attempts; SDK retries are disabled
to avoid multiplying them. Authentication and configuration errors fail immediately.
The full generation cycle has a three-minute timeout, including validation and repairs.
The ten-minute deadline also cancels in-flight interview requests.

## Verify

```bash
npm run typecheck:backend
npm run typecheck:frontend
npm run test:backend
npm run test:integration
npm run build:backend
npm run build:frontend
```

## GitHub Actions deployment

Pull requests run only `npm run test:backend` and `npm run test:integration`.
Pushing to `main` deploys the backend to the EC2 instance over SSH: the workflow
pulls the latest commit, installs dependencies, builds the backend, and restarts
its PM2 process. The PM2 configuration is
[`ecosystem.config.cjs`](ecosystem.config.cjs). Deploy the Next.js frontend
through its hosting provider, such as Vercel, which can build it from the Git
repository. The EC2 deployment uses no containers.

Configure these repository variables in GitHub:

- `EC2_HOST` — EC2 public DNS name or IP address.
- `EC2_SSH_USER` — Linux account used for deployment.
- `EC2_APP_PATH` — absolute path to the repository checkout on EC2.
- `EC2_KNOWN_HOSTS` — trusted SSH host key line for the EC2 host, obtained and
  verified out of band.

Add `EC2_SSH_PRIVATE_KEY` as a repository secret. Its public key must be in the
deployment account's `~/.ssh/authorized_keys`. The EC2 checkout must have
`main` as its checked-out branch and an `origin` remote. Install Node.js 22 or
later and PM2 on the instance, and configure the production environment files
there before the first deploy. Keep the backend keys in `backend/.env`. Set
`BACKEND_URL` in the frontend hosting provider's environment to the public
backend API address.

## Layout

- `frontend/` — Next.js interface, CopilotKit provider, headless agent hooks,
  and same-origin CopilotKit runtime.
- `backend/src/case-generation.ts` — varied case prompts, validation, and repairs.
- `backend/src/game-graph.ts` — LangGraph state transitions, message routing,
  evidence discovery and Reveal, accusations, timeout, and heat evaluation.
- `backend/src/server.ts` — Fastify routes and in-memory cookie-bound sessions.
- `backend/src/ag-ui.ts` — typed game commands, AG-UI events, and the public
chat/state projection.
- `docs/` — product and game design references.

The canonical case, hidden evidence, and solution remain in the backend session
store. Standard game responses include only public suspect data, discovered
clues, messages, and the outcome. **Display solution** executes an explicit
`solution` command whose debug result is excluded from normal shared state and
chat. The interface uses CopilotKit for all game interactions.

The integration test exercises the real CopilotKit runtime, AG-UI client, Fastify
session handling, and LangGraph actions with a fixture case and stub dialogue,
without making external model requests.
