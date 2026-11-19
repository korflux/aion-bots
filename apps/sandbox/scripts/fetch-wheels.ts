// Etapa de build da imagem do sandbox (roda só no Dockerfile, em Node 26, que executa TypeScript direto): baixa os wheels do Python
// e grava o lockfile reduzido que o Pyodide usa em execução. Nada é baixado depois que a imagem existe (spec, Suposição 21).
//
// Cadeia de confiança dos hashes:
// - Pyodide e o `pyodide-lock.json` vêm do pacote npm `pyodide@314.0.7`, conferido pelo sha512 do `pnpm-lock.yaml`;
// - os wheels de numpy, scipy, pandas, matplotlib e dependências vêm do CDN oficial do Pyodide e são conferidos pelo sha256 desse lockfile;
// - openpyxl e et_xmlfile (puro Python, ausentes do lockfile do Pyodide) vêm do PyPI com sha256 fixado em `PYPI_WHEELS` abaixo.
// Qualquer hash divergente ou pacote ausente derruba o build (falha fechada).
//
// Uso: node scripts/fetch-wheels.ts <pasta do pacote pyodide> <pasta de saída dos wheels>
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Formato mínimo de uma entrada do `pyodide-lock.json` usado aqui; os demais campos são copiados sem alteração. */
interface LockPackage {
  name: string;
  version: string;
  file_name: string;
  sha256: string;
  depends: string[];
  [extra: string]: unknown;
}
interface PyodideLock {
  info: Record<string, unknown>;
  packages: Record<string, LockPackage>;
}

// Versão do Pyodide e endereço oficial do CDN dos wheels dessa versão. Precisa acompanhar `pyodide` no package.json do app.
const PYODIDE_VERSION = '314.0.7';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

// Pacotes pedidos pela spec (CODE-01); as dependências saem do próprio lockfile do Pyodide. `sqlite3` é da biblioteca padrão.
const PYODIDE_ROOTS = ['numpy', 'scipy', 'pandas', 'matplotlib'];

// Wheels do PyPI com versão e sha256 fixos (conferidos em https://pypi.org/pypi/<nome>/json em 2026-10-09). Entram no lockfile reduzido
// como pacotes comuns, para o `loadPackage` local conferir o mesmo hash na carga.
const PYPI_WHEELS: LockPackage[] = [
  {
    name: 'et-xmlfile',
    version: '2.0.0',
    file_name: 'et_xmlfile-2.0.0-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a/et_xmlfile-2.0.0-py3-none-any.whl',
    sha256: '7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa',
    depends: [],
    imports: ['et_xmlfile'],
  },
  {
    name: 'openpyxl',
    version: '3.1.5',
    file_name: 'openpyxl-3.1.5-py2.py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506/openpyxl-3.1.5-py2.py3-none-any.whl',
    sha256: '5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2',
    depends: ['et-xmlfile'],
    imports: ['openpyxl'],
  },
];

/**
 * Fecho transitivo das dependências a partir dos pacotes pedidos; pacote ausente do lockfile derruba o build. Devolve a chave do
 * lockfile (nome normalizado, ex.: `pillow`) com a entrada, porque `name` pode ter outra grafia (`Pillow`).
 */
function dependencyClosure(lock: PyodideLock, roots: string[]): Map<string, LockPackage> {
  const seen = new Map<string, LockPackage>();
  const queue = [...roots];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (seen.has(name)) continue;
    const entry = lock.packages[name];
    if (!entry) throw new Error(`pacote ${name} ausente do pyodide-lock.json`);
    seen.set(name, entry);
    queue.push(...entry.depends);
  }
  return seen;
}

/** Baixa um arquivo e só o grava se o sha256 bater com o fixado. */
async function downloadVerified(url: string, sha256: string, target: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download falhou (${response.status}): ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) throw new Error(`sha256 divergente para ${path.basename(target)}: esperado ${sha256}, obtido ${actual}`);
  await writeFile(target, bytes);
  process.stdout.write(`ok ${sha256} ${path.basename(target)}\n`);
}

async function main(): Promise<void> {
  const [pyodideDir, outDir] = process.argv.slice(2);
  if (!pyodideDir || !outDir) throw new Error('uso: node scripts/fetch-wheels.ts <pasta do pyodide> <pasta de saída>');
  const pkg = JSON.parse(await readFile(path.join(pyodideDir, 'package.json'), 'utf8')) as { version: string };
  if (pkg.version !== PYODIDE_VERSION) throw new Error(`pyodide instalado ${pkg.version} difere do fixado ${PYODIDE_VERSION}`);
  const lock = JSON.parse(await readFile(path.join(pyodideDir, 'pyodide-lock.json'), 'utf8')) as PyodideLock;

  await mkdir(outDir, { recursive: true });
  const fromPyodide = dependencyClosure(lock, PYODIDE_ROOTS);
  for (const entry of fromPyodide.values()) {
    await downloadVerified(PYODIDE_CDN + entry.file_name, entry.sha256, path.join(outDir, entry.file_name));
  }
  for (const entry of PYPI_WHEELS) {
    await downloadVerified(String(entry.url), entry.sha256, path.join(outDir, entry.file_name));
  }

  // Lockfile reduzido: só o que está na pasta. Sem `url`, o Pyodide resolve cada wheel pelo `packageBaseUrl` local.
  const packages: Record<string, LockPackage> = {};
  for (const [key, entry] of fromPyodide) packages[key] = entry;
  for (const { url: _url, ...entry } of PYPI_WHEELS) {
    packages[entry.name] = {
      ...entry,
      install_dir: 'site',
      package_type: 'package',
      unvendored_tests: false,
      tool: {},
    };
  }
  await writeFile(path.join(outDir, 'pyodide-lock.json'), JSON.stringify({ info: lock.info, packages }));
  process.stdout.write(`${Object.keys(packages).length} pacotes conferidos\n`);
}

await main();
