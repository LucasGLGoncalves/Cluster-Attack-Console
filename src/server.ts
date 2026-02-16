import express, { Request, Response, NextFunction } from "express";
import { exec } from "child_process";
import os from "os";
import http from "http";

type ChaosJobType =
  | "cpu"
  | "memory"
  | "disk"
  | "io"
  | "fork"
  | "net";

type ChaosJob = {
  id: string;
  type: ChaosJobType;
  startedAt: number;
  endsAt: number;
  detail: Record<string, unknown>;
};

const app = express();
const PORT = Number.parseInt(`${process.env.PORT || 3000}`, 10);

// Simula "graceful shutdown" com atraso (útil para testar preStop/terminationGracePeriodSeconds)
const SIGTERM_SECONDS =
  Number.parseInt(`${process.env.SIGTERM_SECONDS || 20}`, 10) * 1000;

// Segurança básica para não "armar" ataques por acidente em ambientes compartilhados.
// - Se OPERATOR_TOKEN estiver definido, endpoints de caos exigem o header X-Operator-Token.
// - SAFE_MODE limita duração e intensidade.
const OPERATOR_TOKEN = (process.env.OPERATOR_TOKEN || "").trim();
const SAFE_MODE = `${process.env.SAFE_MODE || "true"}`.toLowerCase() !== "false";

// Limites (ajuste via env se quiser). Em SAFE_MODE, os valores são usados como teto.
const LIMITS = {
  maxSeconds: Number.parseInt(`${process.env.MAX_SECONDS || 45}`, 10),
  maxCpuWorkers: Number.parseInt(`${process.env.MAX_CPU_WORKERS || 4}`, 10),
  maxMemMB: Number.parseInt(`${process.env.MAX_MEM_MB || 1024}`, 10),
  maxVmWorkers: Number.parseInt(`${process.env.MAX_VM_WORKERS || 2}`, 10),
  maxDiskWorkers: Number.parseInt(`${process.env.MAX_DISK_WORKERS || 2}`, 10),
  maxIoWorkers: Number.parseInt(`${process.env.MAX_IO_WORKERS || 2}`, 10),
  maxForkWorkers: Number.parseInt(`${process.env.MAX_FORK_WORKERS || 50}`, 10),
  maxNetConcurrency: Number.parseInt(`${process.env.MAX_NET_CONCURRENCY || 150}`, 10),
} as const;

let healthy = true;
let readyUntil = Date.now();

const jobs: ChaosJob[] = [];
const netJobs = new Map<string, { stop: () => void }>();

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const n = Number.parseInt(`${value}`, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function nowMs() {
  return Date.now();
}

function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

function requireToken(req: Request, res: Response, next: NextFunction) {
  if (!OPERATOR_TOKEN) return next();
  const token = `${req.header("X-Operator-Token") || ""}`.trim();
  if (!token || token !== OPERATOR_TOKEN) {
    return res.status(403).json({
      ok: false,
      error: "Acesso negado. Informe X-Operator-Token.",
    });
  }
  return next();
}

function addJob(type: ChaosJobType, seconds: number, detail: Record<string, unknown>) {
  const startedAt = nowMs();
  const endsAt = startedAt + seconds * 1000;
  const job: ChaosJob = {
    id: makeId(type),
    type,
    startedAt,
    endsAt,
    detail,
  };
  jobs.push(job);
  return job;
}

function pruneJobs() {
  const t = nowMs();
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    if (jobs[i].endsAt <= t) jobs.splice(i, 1);
  }
}

function isReady() {
  return nowMs() >= readyUntil;
}

// Middleware de "queda geral" (simula pod doente), mas permite consultar status.
app.use((req: Request, res: Response, next: NextFunction) => {
  const allowWhenUnhealthy =
    req.path === "/health" ||
    req.path === "/ready" ||
    req.path.startsWith("/api/");

  if (!healthy && !allowWhenUnhealthy) {
    return res.status(503).send("");
  }
  return next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");

// ---------- UI ----------
app.get("/", (_req: Request, res: Response) => {
  res.render("index");
});

// ---------- Probes ----------
app.get("/health", (_req: Request, res: Response) => {
  if (!healthy) return res.status(500).send("Internal Server Error");
  return res.status(200).send("ok");
});

app.get("/ready", (_req: Request, res: Response) => {
  if (!isReady()) return res.status(500).send("");
  return res.status(200).send("Ok");
});

// ---------- API de Status (observabilidade básica) ----------
app.get("/api/config", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    requiresToken: Boolean(OPERATOR_TOKEN),
    safeMode: SAFE_MODE,
    limits: LIMITS,
    node: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
    },
  });
});

app.get("/api/status", (_req: Request, res: Response) => {
  pruneJobs();
  res.json({
    ok: true,
    app: {
      name: process.env.APP_NAME || "CHAOS OPS CONSOLE",
      version: process.env.APP_VERSION || "2.0.0",
      mode: process.env.APP_MODE || "red-team-sim",
    },
    runtime: {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: Date.now() - Math.floor(process.uptime() * 1000),
      hostname: os.hostname(),
      loadavg: os.loadavg(),
      memory: {
        rss: process.memoryUsage().rss,
        heapUsed: process.memoryUsage().heapUsed,
        heapTotal: process.memoryUsage().heapTotal,
      },
    },
    probes: {
      healthy,
      ready: isReady(),
      readyUntil,
    },
    chaos: {
      activeJobs: jobs,
    },
  });
});

app.get("/api/env", (req: Request, res: Response) => {
  const showSecrets = `${process.env.SHOW_SECRETS || "false"}`.toLowerCase() === "true";
  const prefix = `${req.query.prefix || "APP_"}`;

  // Lista fixa para treino (ConfigMap/Secret). Se não existir, retorna um fallback.
  // Você pode mudar este array para os nomes que quiser testar.
  const requiredKeys = [
    "APP_NAME",
    "APP_VERSION",
    "APP_MODE",
    "APP_OPERATOR",
    "APP_TARGET_CLUSTER",
    "APP_REGION",
    "APP_TEAM",
    "APP_OPERATION",
    "APP_INCIDENT_MODE",
    "APP_NAMESPACE",
    "APP_POD_LABEL",
    "APP_NODEPOOL",
    "APP_ALERT_CHANNEL",
    "APP_RUNBOOK_URL",
    "APP_TRACE_ID",
    "APP_BUILD_ID",
    "APP_COMMIT_SHA",
    "APP_PASSWORD",
    "APP_TOKEN",
    "APP_SECRET_KEY",
  ];

  const env: Record<string, string> = {};

  const getValue = (k: string) => {
    const raw = process.env[k];
    if (!raw) return "erro de configuração, valor não encontrado";
    const looksSecret = /(PASS|PASSWORD|TOKEN|SECRET|KEY)/i.test(k);
    return looksSecret && !showSecrets ? "***masked***" : raw;
  };

  // 1) chaves obrigatórias
  for (const k of requiredKeys) {
    if (k.startsWith(prefix)) env[k] = getValue(k);
  }

  // 2) qualquer env adicional com prefixo escolhido, ou prefixo LEAK_ (para simular "exfil")
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (!k.startsWith(prefix) && !k.startsWith("LEAK_")) continue;
    if (env[k]) continue;
    env[k] = getValue(k);
  }

  res.json({ ok: true, prefix, showSecrets, values: env });
});

// ---------- Controles de Estado ----------
app.put("/control/unhealth", requireToken, (_req: Request, res: Response) => {
  healthy = false;
  res.json({ ok: true, message: "Aplicação marcada como DOENTE (liveness deve falhar)." });
});

app.put("/control/health", requireToken, (_req: Request, res: Response) => {
  healthy = true;
  res.json({ ok: true, message: "Aplicação marcada como SAUDÁVEL (liveness deve passar)." });
});

app.put("/control/unreadyfor/:seconds", requireToken, (req: Request, res: Response) => {
  const seconds = clampInt(req.params.seconds, 1, 3600, 60);
  readyUntil = nowMs() + seconds * 1000;
  res.json({
    ok: true,
    message: `Aplicação indisponível para readiness por ${seconds}s.`,
    readyUntil,
  });
});

app.put("/control/ready", requireToken, (_req: Request, res: Response) => {
  readyUntil = nowMs();
  res.json({ ok: true, message: "Aplicação pronta novamente (readiness OK)." });
});

// Compatibilidade com endpoints antigos
app.put("/unhealth", requireToken, (_req: Request, res: Response) => {
  healthy = false;
  res.send("A aplicação agora está fora.");
});

app.put("/unreadfor/:seconds", requireToken, (req: Request, res: Response) => {
  const seconds = clampInt(req.params.seconds, 1, 3600, 60);
  readyUntil = nowMs() + seconds * 1000;
  res.send(`A aplicação indisponível por ${seconds} segundos.`);
});

// ---------- Caos / Stress (auto contido) ----------
// Observação: tudo abaixo é intencionalmente "self-target" para laboratório.
// Não há lógica para atingir serviços externos.

function safeSeconds(seconds: number) {
  if (!SAFE_MODE) return seconds;
  return Math.min(seconds, LIMITS.maxSeconds);
}

app.put("/attack/cpu", requireToken, (req: Request, res: Response) => {
  const seconds = safeSeconds(clampInt(req.body?.seconds, 1, 600, 30));
  const workers = SAFE_MODE
    ? clampInt(req.body?.workers, 1, LIMITS.maxCpuWorkers, 2)
    : clampInt(req.body?.workers, 1, 4096, 2);

  const cmd = `stress -c ${workers} -t ${seconds}s`;
  exec(cmd);
  const job = addJob("cpu", seconds, { workers, cmd });
  res.json({ ok: true, message: "CPU surge acionado.", job });
});

app.put("/attack/memory", requireToken, (req: Request, res: Response) => {
  const seconds = safeSeconds(clampInt(req.body?.seconds, 1, 600, 30));
  const workers = SAFE_MODE
    ? clampInt(req.body?.workers, 1, LIMITS.maxVmWorkers, 1)
    : clampInt(req.body?.workers, 1, 4096, 1);
  const mb = SAFE_MODE
    ? clampInt(req.body?.mb, 64, LIMITS.maxMemMB, 512)
    : clampInt(req.body?.mb, 64, 1024 * 128, 512);

  const cmd = `stress --vm ${workers} --vm-bytes ${mb}M -t ${seconds}s`;
  exec(cmd);
  const job = addJob("memory", seconds, { workers, mb, cmd });
  res.json({ ok: true, message: "RAM flood acionado.", job });
});

app.put("/attack/disk", requireToken, (req: Request, res: Response) => {
  const seconds = safeSeconds(clampInt(req.body?.seconds, 1, 600, 30));
  const workers = SAFE_MODE
    ? clampInt(req.body?.workers, 1, LIMITS.maxDiskWorkers, 1)
    : clampInt(req.body?.workers, 1, 1024, 1);

  const cmd = `stress --hdd ${workers} -t ${seconds}s`;
  exec(cmd);
  const job = addJob("disk", seconds, { workers, cmd });
  res.json({ ok: true, message: "Disk thrash acionado.", job });
});

app.put("/attack/io", requireToken, (req: Request, res: Response) => {
  const seconds = safeSeconds(clampInt(req.body?.seconds, 1, 600, 30));
  const workers = SAFE_MODE
    ? clampInt(req.body?.workers, 1, LIMITS.maxIoWorkers, 1)
    : clampInt(req.body?.workers, 1, 1024, 1);

  const cmd = `stress --io ${workers} -t ${seconds}s`;
  exec(cmd);
  const job = addJob("io", seconds, { workers, cmd });
  res.json({ ok: true, message: "IO storm acionado.", job });
});

app.put("/attack/fork", requireToken, (req: Request, res: Response) => {
  const seconds = safeSeconds(clampInt(req.body?.seconds, 1, 600, 20));
  const workers = SAFE_MODE
    ? clampInt(req.body?.workers, 1, LIMITS.maxForkWorkers, 25)
    : clampInt(req.body?.workers, 1, 20000, 25);

  const cmd = `stress --fork ${workers} -t ${seconds}s`;
  exec(cmd);
  const job = addJob("fork", seconds, { workers, cmd });
  res.json({ ok: true, message: "Fork swarm acionado.", job });
});

function startNetSpike(concurrency: number, seconds: number) {
  const jobId = makeId("net");
  const endAt = nowMs() + seconds * 1000;
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });

  let stopped = false;
  const tick = () => {
    if (stopped) return;
    if (nowMs() >= endAt) {
      stopped = true;
      agent.destroy();
      return;
    }

    for (let i = 0; i < concurrency; i += 1) {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: PORT,
          path: "/health",
          method: "GET",
          agent,
          timeout: 1500,
        },
        (r: http.IncomingMessage) => {
          // drena resposta para evitar leak
          r.resume();
        }
      );
      req.on("error", () => undefined);
      req.on("timeout", () => {
        req.destroy();
      });
      req.end();
    }
    setImmediate(tick);
  };

  setImmediate(tick);
  const stop = () => {
    stopped = true;
    agent.destroy();
  };

  netJobs.set(jobId, { stop });
  setTimeout(() => {
    if (netJobs.has(jobId)) {
      netJobs.get(jobId)!.stop();
      netJobs.delete(jobId);
    }
  }, seconds * 1000);

  return jobId;
}

app.put("/attack/net", requireToken, (req: Request, res: Response) => {
  const seconds = safeSeconds(clampInt(req.body?.seconds, 1, 600, 20));
  const concurrency = SAFE_MODE
    ? clampInt(req.body?.concurrency, 1, LIMITS.maxNetConcurrency, 80)
    : clampInt(req.body?.concurrency, 1, 20000, 80);

  const netId = startNetSpike(concurrency, seconds);
  const job = addJob("net", seconds, { concurrency, netId, target: "127.0.0.1:/health" });
  res.json({ ok: true, message: "Network spike acionado (self-target).", job });
});

// Compatibilidade com endpoints antigos
app.put("/stress/cpu", requireToken, (_req: Request, res: Response) => {
  exec("stress -c 2 -t 30s");
  addJob("cpu", 30, { workers: 2, cmd: "stress -c 2 -t 30s" });
  res.send("Aplicação em estresse de CPU.");
});

app.put("/stress/memory", requireToken, (_req: Request, res: Response) => {
  exec("stress --vm 1 --vm-bytes 512M -t 30s");
  addJob("memory", 30, { workers: 1, mb: 512, cmd: "stress --vm 1 --vm-bytes 512M -t 30s" });
  res.send("Aplicação em estresse de memória.");
});

// ---------- Encerramento ----------
app.put("/control/exit/success", requireToken, (_req: Request, res: Response) => {
  res.json({ ok: true, message: "Encerrando com sucesso (exit 0)." });
  // dá tempo do browser receber a resposta
  setTimeout(() => process.exit(0), 150);
});

app.put("/control/exit/fail", requireToken, (_req: Request, res: Response) => {
  res.json({ ok: true, message: "Encerrando com falha (exit 1)." });
  setTimeout(() => process.exit(1), 150);
});

app.put("/control/sigterm", requireToken, (_req: Request, res: Response) => {
  res.json({ ok: true, message: "Enviando SIGTERM para o próprio processo." });
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 150);
});

// Compatibilidade com endpoints antigos
app.put("/exit/success", requireToken, (_req: Request, res: Response) => {
  res.send("Aplicação encerrada com sucesso.");
  setTimeout(() => process.exit(0), 150);
});

app.put("/exit/fail", requireToken, (_req: Request, res: Response) => {
  res.send("Aplicação encerrada com sucesso.");
  setTimeout(() => process.exit(1), 150);
});

process.on("SIGTERM", () => {
  console.log(`SIGTERM recebido. Aguardando ${SIGTERM_SECONDS}ms antes de encerrar...`);
  setTimeout(() => {
    console.log("Encerrando processo");
    process.exit(0);
  }, SIGTERM_SECONDS);
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
