# ClawEvolve Python Sidecar

This service runs official Python GEPA optimization and exposes a strict HTTP API used by the OpenClaw plugin.

## Endpoints
1. `GET /healthz`
2. `POST /v1/evolve`

## Auth
If `CLAW_EVOLVE_SIDECAR_API_KEY` is set, requests must include:
`Authorization: Bearer <token>`

## Run Locally
```bash
cd sidecar
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export OPENAI_API_KEY=...
uvicorn app:app --host 0.0.0.0 --port 8091
```

## Run With Docker
```bash
docker build -t claw-evolve-sidecar -f sidecar/Dockerfile .
docker run --rm -p 8091:8091 \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -e CLAW_EVOLVE_SIDECAR_API_KEY=your-token \
  claw-evolve-sidecar
```

## Request Contract
`POST /v1/evolve` JSON fields:
1. `seedGenome`
2. `trajectories`
3. `generations`
4. `populationSize`
5. `objectiveWeights` (optional)
6. `algorithm` (optional)
7. `gepa` (optional sidecar GEPA runtime knobs)

The response returns:
1. `champion`
2. `championEvaluation`
3. `history`
4. `algorithm`

