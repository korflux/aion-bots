// Leitura tolerante dos argumentos que o modelo manda a uma ferramenta: fonte única do caminho "JSON em texto -> valor validado" e da mensagem
// que devolve ao modelo quando o valor não serve. Todo consumidor de `tool_arguments` que precisa do MESMO resultado da chamada original passa
// por aqui: `defineTool.prepare` (todas as ferramentas internas e as ações do conector), as "portas" `composio_execute_action` e `use_tool` (`unwrap`) e a
// releitura da seleção de `discover_tools` (Chat geral). Assim o que foi aceito na chamada é igual ao que a retomada, a auditoria e o catálogo releem.
//
// Por que existe: modelos menores frequentemente mandam um campo de objeto ou lista como TEXTO que contém o JSON (`columns: "[{...}]"`,
// `arguments: "{...}"`). O schema recusava, o modelo repetia o mesmo formato e acabava desistindo (e anotando um "limite" falso na memória).
// Agora, quando o schema recusa um campo por esperar objeto/lista e o valor recebido é um texto que é JSON do tipo esperado, ele é decodificado
// e o conjunto inteiro é validado de novo, pelo mesmo schema. Nada é executado: só `JSON.parse`, e o schema continua decidindo tudo.
import { z } from 'zod';
import { clipText } from './untrusted-content';

/** Teto do corpo bruto (o mesmo da borda HTTP). Vale antes de qualquer parse e limita, por contenção, todo JSON aninhado em texto. */
export const TOOL_ARGUMENTS_MAX_BYTES = 1024 * 1024;
/** Camadas de "JSON dentro de texto" desfeitas por chamada (ex.: `input` como texto cujo `columns` também é texto). */
const MAX_DECODE_ROUNDS = 3;
/** Limite do texto devolvido ao modelo: 640 unidades UTF-16 mantêm o envelope JSON (com escapes e caminhos hostis) abaixo de 4 KiB. */
const MESSAGE_MAX = 640;
/** Parte do limite reservada às entradas; o restante cobre o fechamento e o aviso de campos omitidos. */
const ENTRIES_BUDGET = 560;

type Issue = z.core.$ZodIssue;

export type ToolArgumentsParse<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'too_large' }
  | { ok: false; reason: 'invalid_json' }
  /** `value` é o JSON já decodificado (após as camadas desfeitas), usado só para dizer ao modelo o que faltou, nunca ecoado. */
  | { ok: false; reason: 'invalid_arguments'; issues: Issue[]; value: unknown };

// ---------------------------------------------------------------------------------------------
// JSON Schema publicado ao modelo
// ---------------------------------------------------------------------------------------------

/** Padrão que o Zod gera para `z.uuid()` e para o texto sem caracteres de controle: o servidor já valida, o modelo só paga tokens por eles. */
const CONTROL_FREE_PATTERN = '^[^\\p{Cc}]*$';

/** Descrição longa repetida (o mesmo `.describe()` num schema reutilizado em dois lugares) só precisa aparecer uma vez. */
const REPEATED_DESCRIPTION_MIN = 120;

/**
 * Remove, recursivamente, o que só repete a validação do servidor ou o que já foi dito: `$schema`, o regex de `format: uuid`, o de texto sem
 * controles, o `type: string` ao lado de um `const` de texto e a 2ª ocorrência de uma descrição longa idêntica. `seen` guarda as descrições longas já vistas, na ordem de percurso.
 */
function compactSchemaNode(node: unknown, seen: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((item) => compactSchemaNode(item, seen));
  if (node === null || typeof node !== 'object') return node;
  const source = node as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === '$schema' || (key === 'pattern' && (source.format === 'uuid' || value === CONTROL_FREE_PATTERN))) continue;
    // `const` de texto já diz o tipo: o `"type":"string"` ao lado só repete (nove vezes só na agenda, em cada variante).
    if (key === 'type' && value === 'string' && typeof source.const === 'string') continue;
    if (key === 'description' && typeof value === 'string' && value.length >= REPEATED_DESCRIPTION_MIN) {
      if (seen.has(value)) continue;
      seen.add(value);
    }
    compact[key] = compactSchemaNode(value, seen);
  }
  return compact;
}

type JsonObject = Record<string, unknown>;
const isJsonObject = (node: unknown): node is JsonObject => node !== null && typeof node === 'object' && !Array.isArray(node);

/** Uma variante de união discriminada por `type`: objeto cujo `type` é uma constante de texto. */
const typedBranch = (node: unknown): node is { properties: JsonObject; required?: string[]; additionalProperties?: unknown } =>
  isJsonObject(node) && isJsonObject(node.properties) && isJsonObject(node.properties.type) && typeof node.properties.type.const === 'string';

/**
 * Funde as variantes de uma união discriminada por `type` num só objeto (phase 15, Q7): `type` vira a lista dos valores, as propriedades de todas as variantes entram uma vez cada
 * (a primeira definição vence, se duas variantes divergem num mesmo nome) e só é obrigatório o que TODAS exigem. Foi feito para a coluna de tabela, em que 11 variantes repetiam `id` e `name`
 * e pesavam cerca de 3 KB em cada uma das três ferramentas de estrutura; o que cada tipo exige a mais vai em `help`, na descrição do objeto, e o Zod segue recusando a combinação
 * errada com o motivo (a validação não muda, só o que o modelo lê). Só se aplica a união de 3 variantes ou mais em que TODAS têm `type` constante: uniões de outra chave (`kind`), ou
 * mistas, ficam como estão.
 */
function flattenTypedUnions(node: unknown, help: string): unknown {
  if (Array.isArray(node)) return node.map((item) => flattenTypedUnions(item, help));
  if (!isJsonObject(node)) return node;
  const children: JsonObject = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, flattenTypedUnions(value, help)]));
  const key = Array.isArray(children.oneOf) ? 'oneOf' : Array.isArray(children.anyOf) ? 'anyOf' : null;
  const branches = key === null ? [] : (children[key] as unknown[]);
  if (key === null || branches.length < 3 || !branches.every(typedBranch)) return children;
  const typed = branches as { properties: JsonObject; required?: string[]; additionalProperties?: unknown }[];
  const properties: JsonObject = {};
  for (const branch of typed) for (const [name, value] of Object.entries(branch.properties)) if (!(name in properties)) properties[name] = name === 'type' ? { type: 'string', enum: typed.map((item) => (item.properties.type as JsonObject).const) } : value;
  const required = typed.map((branch) => branch.required ?? []).reduce((common, own) => common.filter((name) => own.includes(name)));
  const { [key]: _union, ...rest } = children;
  return { ...rest, type: 'object', description: help, properties, required, ...(typed.every((branch) => branch.additionalProperties === false) ? { additionalProperties: false } : {}) };
}

/**
 * JSON Schema dos argumentos de uma ferramenta como o MODELO o recebe (campo `tools`, reenviado a cada etapa). O Zod continua sendo a validação
 * autoritativa; aqui só se tira o regex que repete `format: uuid` (cerca de 190 caracteres por campo de id, várias vezes por ferramenta de tabela),
 * o de texto sem controles, o `$schema`, o `type: string` que acompanha um `const` de texto e a repetição de descrições longas idênticas. Os formatos que o modelo precisa seguir (HH:mm, enums,
 * limites) ficam. Com `flatten`, as uniões discriminadas por `type` viram um objeto só (`flattenTypedUnions`), com o texto dado na descrição dele.
 */
export function modelJsonSchema(schema: z.ZodType, options: Parameters<typeof z.toJSONSchema>[1] = { io: 'input' }, flatten?: { help: string }): Record<string, unknown> {
  const compact = compactSchemaNode(z.toJSONSchema(schema, options), new Set());
  return (flatten ? flattenTypedUnions(compact, flatten.help) : compact) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Decodificação de JSON recebido como texto
// ---------------------------------------------------------------------------------------------

/** Lê o valor em `path` percorrendo só propriedades próprias; nunca a cadeia de protótipos. */
function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/** O que o schema esperava num ponto recusado e que um texto pode trazer: objeto ou lista (JSON), número ou booleano (literal). */
type Wanted = 'object' | 'array' | 'number' | 'boolean';

/** Pontos em que o schema esperava objeto, lista, número ou booleano, com o caminho completo; os motivos de cada alternativa de uma união vêm com caminho relativo. */
function containerIssues(issues: readonly Issue[], prefix: readonly PropertyKey[] = [], depth = 0): { path: PropertyKey[]; wanted: Wanted }[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_type') {
      const wanted = ({ object: 'object', record: 'object', array: 'array', tuple: 'array', number: 'number', int: 'number', boolean: 'boolean' } as const)[issue.expected as string];
      return wanted === undefined ? [] : [{ path, wanted }];
    }
    return issue.code === 'invalid_union' && depth < 4 ? issue.errors.flatMap((errors) => containerIssues(errors, path, depth + 1)) : [];
  });
}

/** O valor que o texto traz para o tipo esperado (JSON de objeto ou lista, número ou `true`/`false`), ou `undefined` se o texto não é isso. */
function decodeText(text: string, wanted: Wanted): unknown {
  if (wanted === 'number') return /^\s*-?\d+(\.\d+)?\s*$/.test(text) ? Number(text) : undefined;
  if (wanted === 'boolean') {
    const literal = text.trim().toLowerCase();
    return literal === 'true' ? true : literal === 'false' ? false : undefined;
  }
  try {
    const decoded: unknown = JSON.parse(text);
    return decoded !== null && typeof decoded === 'object' && Array.isArray(decoded) === (wanted === 'array') ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Troca, no valor, cada texto que o schema recusou por esperar outro tipo pelo valor que ele contém. Devolve o novo valor ou `null` se nada mudou. */
function decodeRefusedStrings(root: unknown, issues: readonly Issue[]): { value: unknown } | null {
  let value = root;
  let changed = false;
  for (const { path, wanted } of containerIssues(issues)) {
    const text = valueAt(value, path);
    if (typeof text !== 'string') continue;
    const decoded = decodeText(text, wanted);
    if (decoded === undefined) continue;
    if (path.length === 0) value = decoded;
    else {
      const parent = valueAt(value, path.slice(0, -1)) as Record<PropertyKey, unknown> | null | undefined;
      const key = path[path.length - 1]!;
      // `__proto__` nunca é atribuído: um JSON hostil não pode mexer no protótipo do objeto pai.
      if (parent === null || parent === undefined || typeof parent !== 'object' || key === '__proto__') continue;
      parent[key] = decoded;
    }
    changed = true;
  }
  return changed ? { value } : null;
}

/**
 * Valida `rawArguments` (o JSON em texto da chamada) pelo schema, desfazendo o "JSON dentro de texto" onde o schema esperava objeto ou lista, e o número ou
 * booleano escrito como texto onde o schema esperava número ou booleano. Texto que não decodifica para o tipo esperado segue como erro normal; texto válido
 * para o schema (ex.: uma célula de texto, que é texto por contrato) nunca é tocado. O número NUNCA nasce de um número JSON para uma célula decimal: a conversão
 * é só de texto para número, nunca o contrário, porque decimais exatos de tabela vão como texto e um `double` perderia dígitos.
 */
export function parseToolArguments<S extends z.ZodType>(schema: S, rawArguments: string): ToolArgumentsParse<z.output<S>> {
  // Antes do parse: o modelo não recebe o limite de corpo que protege a borda HTTP.
  if (Buffer.byteLength(rawArguments, 'utf8') > TOOL_ARGUMENTS_MAX_BYTES) return { ok: false, reason: 'too_large' };
  let value: unknown;
  try {
    value = JSON.parse(rawArguments === '' ? '{}' : rawArguments);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  let result = schema.safeParse(value);
  for (let round = 0; !result.success && round < MAX_DECODE_ROUNDS; round += 1) {
    const decoded = decodeRefusedStrings(value, result.error.issues);
    if (decoded === null) break;
    value = decoded.value;
    result = schema.safeParse(value);
  }
  return result.success ? { ok: true, data: result.data } : { ok: false, reason: 'invalid_arguments', issues: result.error.issues, value };
}

// ---------------------------------------------------------------------------------------------
// Mensagem de erro para o modelo
// ---------------------------------------------------------------------------------------------

const TYPE_NAMES: Readonly<Record<string, string>> = { object: 'objeto', record: 'objeto', array: 'lista', tuple: 'lista', string: 'texto', number: 'número', int: 'inteiro', boolean: 'booleano' };

/** Valores do discriminador de um parâmetro que é união de objetos (ex.: `schedule`), lidos do JSON Schema que a própria ferramenta publicou. */
function variantsOf(parameters: Record<string, unknown> | undefined, field: PropertyKey): string {
  const node = (parameters?.properties as Record<string, { oneOf?: unknown; anyOf?: unknown }> | undefined)?.[String(field)];
  const variants = node?.oneOf ?? node?.anyOf;
  if (!Array.isArray(variants) || variants.length < 2) return '';
  type Variant = { properties?: Record<string, { const?: unknown }> };
  const first = (variants[0] as Variant).properties ?? {};
  const key = Object.keys(first).find((name) => variants.every((variant) => typeof (variant as Variant).properties?.[name]?.const === 'string'));
  return key === undefined ? '' : ` com ${key} = ${variants.map((variant) => (variant as Variant).properties![key]!.const).join('|')}`;
}

/** Dica de UUID: o servidor aceita só UUID v4 (3º grupo começa com 4, 4º com 8, 9, a ou b), e um id inventado fora disso é recusado como se fosse outro erro. */
const UUID_HINT = 'esperado UUID v4 (3º grupo começa com 4; 4º com 8, 9, a ou b)';

/**
 * Nó do JSON Schema publicado no caminho do campo, com a descrição do próprio nó (`own`) e a do mapa que o contém quando o campo é uma entrada dele (`map`: as células de
 * tabela, cuja descrição fica no mapa e não em cada coluna). A descrição de um ancestral qualquer não vale: falaria de outro campo.
 */
function schemaAt(parameters: Record<string, unknown> | undefined, path: readonly PropertyKey[]): { node: Record<string, unknown> | undefined; own: string | undefined; map: string | undefined } {
  const asNode = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
  let node = parameters;
  let mapDescription: string | undefined;
  for (const segment of path) {
    if (node === undefined) break;
    const properties = asNode(node.properties);
    if (properties !== undefined && Object.hasOwn(properties, String(segment))) {
      node = asNode(properties[String(segment)]);
      mapDescription = undefined;
    } else if (typeof segment === 'number') {
      node = asNode(node.items);
      mapDescription = undefined;
    } else {
      // A descrição do nó só vale como a do MAPA quando ele é um mapa de verdade (`additionalProperties` com esquema). Um objeto sem a propriedade pedida (uma união, como a
      // `schedule`) não tem entradas: emprestar a descrição dele ao campo de dentro mostrava, na recusa, a frase do pai (phase 15, A18: a mesma agenda inválida recusava com texto
      // diferente em `propose_routine` e em `propose_routine_change`, porque só a segunda descrevia o `schedule`).
      const entries = asNode(node.additionalProperties);
      mapDescription = entries !== undefined && typeof node.description === 'string' ? node.description : undefined;
      node = entries;
    }
  }
  return { node, own: typeof node?.description === 'string' ? node.description : undefined, map: mapDescription };
}

/** Resumo do nome dos campos aceitos por um objeto, lidos do JSON Schema que a ferramenta publicou (vazio se o schema não lista propriedades). */
function acceptedFields(node: Record<string, unknown> | undefined): string {
  const names = Object.keys((node?.properties as Record<string, unknown> | undefined) ?? {});
  return names.length === 0 ? '' : ' (aceitos: ' + names.slice(0, 10).join(', ') + (names.length > 10 ? ', ...' : '') + ')';
}

/** Limite de uma recusa por tamanho, na unidade do tipo (caracteres, itens ou valor). */
function boundHint(issue: Extract<Issue, { code: 'too_small' | 'too_big' }>): string {
  const unit = issue.origin === 'string' ? ' caracteres' : issue.origin === 'array' || issue.origin === 'set' ? ' itens' : '';
  return issue.code === 'too_small' ? 'mínimo ' + String(issue.minimum) + unit : 'máximo ' + String(issue.maximum) + unit;
}

/** O que se esperava no campo, em poucas palavras, ou nulo quando o motivo não cabe numa dica curta e geral. Nunca ecoa o valor recebido, só nomes de campo que o próprio schema ou o modelo escreveu. */
function expectation(issue: Issue, value: unknown, parameters: Record<string, unknown> | undefined): string | null {
  if (issue.code === 'invalid_type') {
    if (valueAt(value, issue.path) === undefined) return 'obrigatório';
    const name = TYPE_NAMES[issue.expected];
    return name === undefined ? null : 'esperado ' + name + (name === 'objeto' && issue.path.length === 1 ? variantsOf(parameters, issue.path[0]!) : '');
  }
  if (issue.code === 'invalid_value') return 'esperado um de ' + issue.values.slice(0, 8).map(String).join('|');
  if (issue.code === 'invalid_union' && 'options' in issue && Array.isArray(issue.options)) return 'esperado um de ' + issue.options.slice(0, 12).map(String).join('|');
  if (issue.code === 'unrecognized_keys') return 'campo não aceito: ' + issue.keys.slice(0, 5).map((key) => clipText(key, 40)).join(', ') + acceptedFields(schemaAt(parameters, issue.path).node);
  if (issue.code === 'invalid_key') return issue.issues.some((inner) => inner.code === 'invalid_format' && inner.format === 'uuid') ? 'chave não é UUID' : 'chave inválida';
  if (issue.code === 'invalid_format') return issue.format === 'uuid' ? UUID_HINT : 'formato inválido' + (issue.format === 'regex' ? '' : ' (' + issue.format + ')');
  if (issue.code === 'too_small' || issue.code === 'too_big') return boundHint(issue);
  if (issue.code === 'custom') {
    const hint = (issue as { params?: { hint?: unknown } }).params?.hint;
    return typeof hint === 'string' ? hint : null;
  }
  return null;
}

/**
 * Troca cada união recusada pelos motivos da alternativa mais próxima (a de menos motivos; no empate, a primeira): o modelo precisa saber o que corrigir, e "campo" sem
 * motivo era o que ele lia quando o valor falhava em todas as alternativas (a célula de tabela, o filtro, a busca do conector). Os caminhos das alternativas são relativos à união.
 */
function flattenUnions(issues: readonly Issue[], prefix: readonly PropertyKey[] = [], depth = 0): Issue[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union' && depth < 4 && issue.errors.length > 0) return flattenUnions(issue.errors.reduce((best, errors) => (errors.length < best.length ? errors : best)), path, depth + 1);
    return [{ ...issue, path } as Issue];
  });
}

/**
 * "Argumentos inválidos (campo: o que se esperava, outro)": nomes de campo (os do schema e, no caminho e em "campo não aceito", as chaves que o modelo escreveu, cortadas) e dicas que vêm do
 * SCHEMA (tipo, opções, limites, descrição); o VALOR enviado pelo modelo nunca é ecoado. Uniões são resumidas pela alternativa mais próxima (`flattenUnions`). A validação é integral, mas a resposta mostra uma amostra curta para não multiplicar contexto em lotes inválidos.
 * `parameters` é o JSON Schema que a ferramenta publicou (opcional): dele vêm a lista de variantes de um parâmetro que é união de objetos, os campos aceitos de um objeto e a
 * descrição do campo recusado.
 */
export function describeArgumentIssues(issues: readonly Issue[], value: unknown, parameters?: Record<string, unknown>): string {
  const fields = new Map<string, string | null>();
  const described = new Set<string>();
  for (const issue of flattenUnions(issues)) {
    const field = issue.path.map(String).join('.') || 'argumentos';
    let hint = expectation(issue, value, parameters);
    // A descrição que o schema publicou diz o formato esperado quando o motivo sozinho não diz: a do mapa de células (entrada recusada de um mapa) e, sem nenhum motivo, a do próprio campo.
    // Cada descrição entra uma vez só na mensagem: oito células recusadas pelo mesmo motivo repetiriam o texto e gastariam o orçamento das demais entradas.
    const at = schemaAt(parameters, issue.path);
    const description = at.map ?? (hint === null ? at.own : undefined);
    if (description !== undefined && !described.has(description)) {
      described.add(description);
      hint = (hint === null ? '' : `${hint}. `) + clipText(description, 130).replace(/\.$/, '');
    }
    if (!fields.has(field) || (fields.get(field) === null && hint !== null)) fields.set(field, hint);
  }
  const shown: string[] = [];
  let used = 0;
  for (const [field, hint] of fields) {
    const name = field.length > 64 ? `${clipText(field, 63)}…` : field;
    const entry = hint === null ? name : `${name}: ${clipText(hint, 200)}`;
    if (shown.length >= 8 || (shown.length > 0 && used + entry.length > ENTRIES_BUDGET)) break;
    shown.push(entry);
    used += entry.length + 2;
  }
  const omitted = fields.size - shown.length;
  return clipText(`Argumentos inválidos (${shown.join(', ')}${omitted ? `; mais ${omitted} campos, ${fields.size} no total` : ''}).`, MESSAGE_MAX);
}
