# 🧪 Chaos Ops Console – DevOps Incident Lab

Uma aplicação leve, feita para laboratório, que simula falhas e consumo de recursos dentro do próprio pod/container.
O objetivo é permitir que você pratique:

- Liveness e readiness
- Auto-healing e reinícios
- Termination / graceful shutdown (SIGTERM)
- HPA e métricas de consumo
- PDB, rollout e estratégia de mitigação

Além disso, a UI foi repaginada para um visual estilo terminal/hacker, com botões de ataque bem chamativos.

## O que esta aplicação faz

Ela expõe um painel web em `http://localhost:3000` que dispara cenários de caos. Os cenários são auto contidos, ou seja, o alvo é o próprio processo/pod.

### Ataques de consumo

- `PUT /attack/cpu` CPU surge (via `stress -c`)
- `PUT /attack/memory` RAM flood (via `stress --vm`)
- `PUT /attack/disk` Disk thrash (via `stress --hdd`)
- `PUT /attack/io` IO storm (via `stress --io`)
- `PUT /attack/fork` Fork swarm (via `stress --fork`)
- `PUT /attack/net` Network spike (muitas requisições HTTP contra `127.0.0.1:/health`)

### Falhas e controles

- `PUT /control/unhealth` força liveness a falhar (retorna 500 em `/health`)
- `PUT /control/health` recupera liveness
- `PUT /control/unreadyfor/:seconds` força readiness a falhar por N segundos
- `PUT /control/ready` recupera readiness

### Desligamento

- `PUT /control/sigterm` envia SIGTERM para o próprio processo
- `PUT /control/exit/success` finaliza com exit 0
- `PUT /control/exit/fail` finaliza com exit 1

## Segurança de laboratório

Para evitar disparos acidentais em ambientes compartilhados:

- Se `OPERATOR_TOKEN` estiver definido, endpoints de caos exigem o header `X-Operator-Token`.
- `SAFE_MODE` vem ativado por padrão e limita intensidade e duração.

### Variáveis de ambiente úteis

| Variável | Padrão | Descrição |
|---|---:|---|
| `PORT` | 3000 | Porta da aplicação |
| `SIGTERM_SECONDS` | 20 | Atraso para encerrar após SIGTERM (simula graceful shutdown) |
| `OPERATOR_TOKEN` | vazio | Se definido, exige `X-Operator-Token` para disparar caos |
| `SAFE_MODE` | true | Limita intensidade e duração |
| `MAX_SECONDS` | 45 | Teto de duração (SAFE_MODE) |
| `MAX_CPU_WORKERS` | 4 | Teto de CPU workers |
| `MAX_MEM_MB` | 1024 | Teto de memória por ataque |
| `MAX_VM_WORKERS` | 2 | Teto de vm workers |
| `MAX_DISK_WORKERS` | 2 | Teto de disk workers |
| `MAX_IO_WORKERS` | 2 | Teto de io workers |
| `MAX_FORK_WORKERS` | 50 | Teto de fork workers |
| `MAX_NET_CONCURRENCY` | 150 | Teto de concorrência de requests |
| `SHOW_SECRETS` | false | Se true, `GET /api/env` mostra valores completos |

## Observabilidade embutida

- `GET /api/status` retorna probes, jobs em execução, hostname, pid, loadavg e uso de memória do processo.
- `GET /api/env?prefix=APP_` retorna variáveis que começam com `APP_` (com máscara para chaves sensíveis por padrão).

## Rodando com Docker

```bash
docker build -t chaos-ops-console ./src
docker run -p 3000:3000 \
  -e OPERATOR_TOKEN=lab123 \
  -e SAFE_MODE=true \
  --name chaos-ops-console chaos-ops-console
```

Acesse: `http://localhost:3000`

## Kubernetes

Há um manifesto em `k8s/deployment.yml` que você pode adaptar. A recomendação é:

- armazenar `OPERATOR_TOKEN` em Secret
- armazenar as demais configs em ConfigMap

## Estrutura do projeto

```text
├── k8s/
│   ├── deployment.yml
│   └── kind-config.yml
└── src/
    ├── server.ts
    ├── views/index.ejs
    ├── Dockerfile
    ├── package.json
    └── tsconfig.json
```

## Nota de uso

Este projeto é para laboratório e auto teste. Use somente em ambientes que você controla.
