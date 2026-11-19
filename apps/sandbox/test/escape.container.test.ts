// Suíte de fuga (A15) contra o container real. Cada teste é um ataque em Python que imprime "BLOQUEADO <detalhe>" quando a camada
// segura e "FUGA <detalhe>" quando passa; o teste exige ao menos um BLOQUEADO e nenhuma FUGA. Os ataques não se limitam ao import
// direto: usam `_pyodide_core` (alcançável por `sys.modules` mesmo com os módulos bloqueados) para criar objetos JavaScript e testar as
// camadas do realm e das permissões do Node. O ambiente e o disco do container são conferidos por `docker exec`, fora do processo filho.
import { execFileSync } from 'node:child_process';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asRun, canaryHits, canaryInnerUrl, containerName, dockerExec, runPython, sandboxToken, waitHealth } from './client.js';

/** Prelúdio comum: `attempt` roda uma tentativa e imprime FUGA se ela der certo, BLOQUEADO se lançar. */
const PRELUDE = `
import sys, os, gc
core = sys.modules.get("_pyodide_core")

def attempt(label, fn, escaped=lambda value: True):
    try:
        value = fn()
    except BaseException as exc:
        print("BLOQUEADO", label, type(exc).__name__)
        return
    if escaped(value):
        print("FUGA", label, repr(value)[:120])
    else:
        print("BLOQUEADO", label, "sem efeito")

def js_object():
    return core.to_js({"a": 1})
`;

/** Roda o ataque e exige: execução concluída, ao menos uma tentativa bloqueada e nenhuma fuga, sem rede. */
async function expectBlocked(attack: string): Promise<string> {
  const result = asRun(await runPython(PRELUDE + attack));
  expect(result.error, result.output).toBeNull();
  expect(result.outcome).toBe('ok');
  expect(result.output).toContain('BLOQUEADO');
  expect(result.output).not.toContain('FUGA');
  return result.output;
}

describe('suíte de fuga do sandbox (A15)', () => {
  let hitsBefore = 0;

  beforeAll(async () => {
    hitsBefore = await canaryHits();
  });

  beforeEach(async () => {
    await waitHealth((body) => body.ready === 2);
  });

  it('controle: o canário é alcançável pela rede do container (fora do processo isolado)', () => {
    // Prova que o bloqueio dos testes de rede vem das camadas do sandbox, não da falta de rede no container.
    const probe = dockerExec(['node', '-e', `fetch(${JSON.stringify(`${canaryInnerUrl}/__ping`)}).then(r => r.text()).then(t => console.log(t))`]);
    expect(probe.ok).toBe(true);
    expect(probe.stdout.trim()).toBe('canario');
  });

  it('ponte js: o módulo js não é importável nem alcançável, e o objeto global ficou vazio', async () => {
    await expectBlocked(`
import importlib
attempt("import js", lambda: __import__("js"))
attempt("importlib js", lambda: importlib.import_module("js"))
attempt("sys.modules js", lambda: sys.modules["js"])
hook = sys.modules["_pyodide._importhook"]
attempt("registro do jsfinder", lambda: [k for k in getattr(hook.jsfinder, "jsproxies", {}) if k in ("js", "pyodide_js")], lambda found: bool(found))
attempt("register_js_module com proxy", lambda: hook.register_js_module("js2", js_object()) or __import__("js2").constructor.constructor("return globalThis")())
`);
  });

  it('pyodide_js: a API do Pyodide não é importável nem sobra como objeto no heap do Python', async () => {
    await expectBlocked(`
attempt("import pyodide_js", lambda: __import__("pyodide_js"))
attempt("import pyodide.ffi", lambda: __import__("pyodide.ffi"))
def api_proxies():
    found = []
    for obj in gc.get_objects():
        try:
            if type(type(obj)).__name__ == "_JsProxyMetaClass":
                if any(hasattr(obj, name) for name in ("loadPackage", "runPython", "FS", "_api", "globalThis", "process")):
                    found.append(type(obj).__name__)
        except BaseException:
            pass
    return found
attempt("objeto da API no heap", api_proxies, lambda found: bool(found))
`);
  });

  it('construtor de Function e eval: geração de código a partir de texto é recusada', async () => {
    await expectBlocked(`
F = js_object().constructor.constructor
attempt("Function", lambda: F("return globalThis")())
attempt("Function de import()", lambda: F("return import('node:fs')")())
attempt("Function.prototype.constructor", lambda: F.prototype.constructor("return 1")())
`);
  });

  it('pilha de chamadas: Error.prepareStackTrace travado não entrega os quadros ao Python', async () => {
    await expectBlocked(`
frames = []
def capture(err, callsites):
    frames.extend(callsites)
    return "capturado"
hook = core.create_proxy(capture)
try:
    js_object().constructor.constructor("x")
except BaseException as exc:
    ErrorClass = exc.js_error.constructor.__proto__
def install():
    ErrorClass.prepareStackTrace = hook
    js_object().constructor.constructor("y")
attempt("prepareStackTrace", install)
attempt("quadros capturados", lambda: len(frames), lambda count: count > 0)
`);
  });

  it('loadBinaryFile e leitura de arquivos do host: o runtime e o sistema do container não aparecem no Python', async () => {
    const output = await expectBlocked(`
attempt("loadBinaryFile pela API", lambda: __import__("pyodide_js")._api.loadBinaryFile("/app/runtime/runner.js"))
attempt("ler runner.js", lambda: open("/app/runtime/runner.js").read())
attempt("ler /etc/passwd", lambda: open("/etc/passwd").read())
attempt("ler /proc/self/environ", lambda: open("/proc/self/environ").read())
attempt("ler server.js", lambda: open("/app/server.js").read())
attempt("pasta do host na raiz", lambda: [d for d in os.listdir("/") if d in ("app", "etc", "usr", "var", "root")], lambda found: bool(found))
`);
    expect(output).toContain('BLOQUEADO ler runner.js');
  });

  it('montagem de disco e escrita: sem NODEFS, /data/ só leitura e nada gravado no disco do container', async () => {
    await expectBlocked(`
attempt("mountNodeFS", lambda: __import__("pyodide_js").mountNodeFS("/host", "/"))
attempt("FS.mount pela API", lambda: __import__("pyodide_js").FS.mount)
attempt("escrever em /data", lambda: open("/data/entrada.csv", "w").write("x"))
attempt("criar em /data", lambda: open("/data/novo.txt", "w").write("x"))
attempt("apagar em /data", lambda: os.remove("/data/entrada.csv"))
open("/tmp/aion-fuga.txt", "w").write("x")
os.makedirs("/app", exist_ok=True)
open("/app/aion-fuga.txt", "w").write("x")
print("BLOQUEADO escrita só no disco em memória")
`);
    // O que o Python "gravou" ficou no sistema de arquivos em memória do processo descartado, não no disco do container.
    expect(dockerExec(['test', '-e', '/tmp/aion-fuga.txt']).ok).toBe(false);
    expect(dockerExec(['test', '-e', '/app/aion-fuga.txt']).ok).toBe(false);
  });

  it('importação dinâmica: nenhum módulo JavaScript novo é carregado', async () => {
    await expectBlocked(`
F = js_object().constructor.constructor
attempt("import() por Function", lambda: F("return import('node:child_process')")())
attempt("import() por Function.prototype.constructor", lambda: F.prototype.constructor("return import('ws')")())
`);
  });

  it('rede: fetch, pyfetch, WebSocket, urllib e socket não saem do processo', async () => {
    const before = await canaryHits();
    const result = asRun(await runPython(`${PRELUDE}
url = ${JSON.stringify(`${canaryInnerUrl}/fuga`)}
host = url.split("//")[1].split(":")[0]
attempt("pyfetch", lambda: __import__("pyodide.http").http.pyfetch(url))
attempt("urllib", lambda: __import__("urllib.request").request.urlopen(url, timeout=3).read())
import socket
attempt("socket", lambda: socket.create_connection((host, 8080), timeout=3))
attempt("socket por IP", lambda: socket.create_connection(("1.1.1.1", 80), timeout=3))
attempt("WebSocket pela ponte js", lambda: __import__("js").WebSocket.new(url))
`));
    expect(result.outcome).toBe('ok');
    expect(result.output).not.toContain('FUGA');
    expect(result.output).toContain('BLOQUEADO pyfetch');
    expect(result.output).toContain('BLOQUEADO urllib');
    expect(result.output).toContain('BLOQUEADO socket');
    expect(await canaryHits()).toBe(before);
  });

  it('loadPackage por URL e pip: nenhum pacote é baixado', async () => {
    const before = await canaryHits();
    await expectBlocked(`
url = ${JSON.stringify(`${canaryInnerUrl}/pacote-0.1-py3-none-any.whl`)}
attempt("loadPackage", lambda: __import__("pyodide_js").loadPackage(url))
attempt("micropip", lambda: __import__("micropip").install(url))
attempt("pip", lambda: __import__("pip"))
`);
    expect(await canaryHits()).toBe(before);
  });

  it('processo: subprocess, fork e spawn não existem no Python', async () => {
    await expectBlocked(`
import subprocess
attempt("subprocess", lambda: subprocess.run(["id"]))
attempt("fork", lambda: os.fork())
attempt("posix_spawn", lambda: os.posix_spawn("/bin/sh", ["sh"], {}))
`);
  });

  it('ambiente: o Python não vê variáveis do container nem o token', async () => {
    const result = asRun(await runPython('import os, json\nprint(json.dumps(dict(os.environ)))'));
    const environment = JSON.parse(result.output) as Record<string, string>;
    expect(Object.keys(environment).filter((key) => key.startsWith('AION_'))).toEqual([]);
    expect(Object.values(environment).join('\n')).not.toContain(sandboxToken);
    expect(result.output).not.toContain(sandboxToken);
  });

  it('container: só variáveis permitidas e nenhum segredo do Aion; a imagem não traz token', () => {
    const allowed = new Set(['PATH', 'HOSTNAME', 'HOME', 'NODE_VERSION', 'YARN_VERSION', 'NODE_ENV', 'PORT', 'AION_SANDBOX_TOKEN']);
    const keys = dockerExec(['env']).stdout.split('\n').filter(Boolean).map((line) => line.split('=')[0] ?? '');
    expect(keys.filter((key) => !allowed.has(key))).toEqual([]);
    const imageEnv = execFileSync('docker', ['inspect', '--format', '{{json .Config.Env}}', 'aion-sandbox:test'], { encoding: 'utf8' });
    expect(imageEnv).not.toContain('AION_SANDBOX_TOKEN');
    expect(imageEnv).not.toMatch(/AION_MASTER_KEY|DATABASE_URL|AION_OWNER|COMPOSIO|OPENCODE|FCM/);
  });

  it('processos de Python: ambiente vazio e só as flags de isolamento do Node (camadas a e c)', () => {
    // Lido de /proc pelo container (mesmo usuário), fora do processo isolado: cada processo de Python aquecido. O próprio `sh` desta
    // inspeção é pulado ($$): a linha de comando dele contém "runner.js" e o ambiente dele é o do `docker exec`, não o de um filho.
    const script =
      'for p in /proc/[0-9]*; do [ "$p" = "/proc/$$" ] && continue; if grep -q runner.js "$p/cmdline" 2>/dev/null; then ' +
      'echo "$(wc -c < "$p/environ") $(tr "\\0" " " < "$p/cmdline")"; fi; done';
    const lines = dockerExec(['sh', '-c', script]).stdout.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      const [environBytes, ...command] = line.trim().split(' ');
      expect(environBytes).toBe('0');
      expect(command).toContain('--permission');
      expect(command).toContain('--disallow-code-generation-from-strings');
      expect(command.filter((arg) => arg.startsWith('--allow-'))).toEqual(['--allow-fs-read=/app/runtime/']);
    }
    expect(containerName).toMatch(/^aion-sbx-/);
  });

  it('nenhuma tentativa da suíte chegou ao canário', async () => {
    expect(await canaryHits()).toBe(hitsBefore);
  });
});
