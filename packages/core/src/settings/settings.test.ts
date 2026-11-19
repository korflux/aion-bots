// Prova das preferências gerais, idioma e fuso (T28), do nome do dono "Como te chamar" (phase 5, T4) e do interruptor da pesquisa na web (phase 1, T8), contra PostgreSQL real e o provedor
// falso: o padrão de quem não escolheu nada é o comportamento anterior (português do Brasil, America/Sao_Paulo, sem nome); gravar valida o idioma (allowlist), o fuso (existe
// no runtime) e o nome (até 40 caracteres, sem controle), audita (sem o nome) e vale já na próxima execução: o cabeçalho "Idioma" e "Agora" do contexto do modelo e o fuso padrão
// da proposta de rotina do bot. O nome nunca chega ao modelo. Também prova o modelo do resumo da compactação (phase 9, T4): gravação só de modelo validado, auditada e
// independente das janelas, e a função única que o resolve no uso (o salvo se ainda validado; senão, o da conversa, com log só de ids).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DomainError } from '../errors';
import { ORIGIN, createRunsWorld, type RunsWorld } from '../runs/test-support';
import { SettingsService, isValidatedModel, readAppSettings, readSummaryModel, readWebSearchEnabled, resolveSummaryModel } from './service';

let world: RunsWorld;
let settings: SettingsService;

beforeAll(async () => {
  world = await createRunsWorld();
  world.engine.start();
  settings = new SettingsService({ pool: world.pool });
});

afterAll(async () => {
  await world.cleanup();
});

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    return error instanceof DomainError ? error.code : `INESPERADO:${String(error)}`;
  }
};

/** O turno de sistema da última chamada de chat que o provedor falso recebeu. */
const systemOfLastRequest = (): string => (world.conversationRequests().at(-1)?.body?.messages as { role: string; content: string }[])[0]?.content ?? '';
/** O turno que abre a rodada atual na última chamada (leva o bloco `# Dados` com o "Agora" e o fuso, gravado pela execução desde a phase 10, PERF-01). */
const openingOfLastRequest = (): string => (world.conversationRequests().at(-1)?.body?.messages as { role: string; content: string }[]).filter((turn) => turn.role === 'user').at(-1)?.content ?? '';

describe('preferências gerais (idioma e fuso)', () => {
  it('quem não escolheu nada fica com o comportamento anterior: português do Brasil e America/Sao_Paulo', async () => {
    expect(await settings.read()).toEqual({ language: 'pt-BR', timeZone: 'America/Sao_Paulo', ownerName: '' });
    expect(await readAppSettings(world.pool)).toEqual({ language: 'pt-BR', timeZone: 'America/Sao_Paulo' }); // o recorte do contexto não tem o nome
  });

  it('gravar vale para os campos, devolve o estado novo e audita quem, o quê e de onde', async () => {
    expect(await settings.update({ language: 'en', timeZone: 'America/New_York', ownerName: '' }, ORIGIN)).toEqual({ language: 'en', timeZone: 'America/New_York', ownerName: '' });
    expect(await settings.read()).toEqual({ language: 'en', timeZone: 'America/New_York', ownerName: '' });
    const audit = await world.pool.query<{ actor: string; ip: string | null; target: string | null; details: Record<string, unknown> }>(
      "SELECT actor, ip, target, details FROM audit_log WHERE action = 'settings.updated' ORDER BY id",
    );
    expect(audit.rows).toEqual([{ actor: 'owner', ip: ORIGIN.ip, target: 'app_settings', details: { language: 'en', timeZone: 'America/New_York', ownerNameChanged: false } }]);
    expect((await world.pool.query('SELECT count(*) AS total FROM app_settings')).rows[0]).toEqual({ total: '1' }); // continua uma linha só
  });

  it('um fuso desconhecido ou um idioma fora da lista é recusado, com o campo, e nada é gravado', async () => {
    expect(await codeOf(settings.update({ language: 'pt-BR', timeZone: 'Marte/Olimpo', ownerName: '' }, ORIGIN))).toBe('VALIDATION_FAILED');
    expect(await codeOf(settings.update({ language: 'klingon' as never, timeZone: 'UTC', ownerName: '' }, ORIGIN))).toBe('VALIDATION_FAILED');
    expect(await codeOf(settings.update({ language: 'pt-BR', timeZone: "x'; DROP TABLE app_settings; --", ownerName: '' }, ORIGIN))).toBe('VALIDATION_FAILED');
    expect(await settings.read()).toEqual({ language: 'en', timeZone: 'America/New_York', ownerName: '' }); // a gravação anterior segue
    const failure = await settings.update({ language: 'pt-BR', timeZone: 'Marte/Olimpo', ownerName: '' }, ORIGIN).catch((error: unknown) => error as DomainError);
    expect((failure as DomainError).fields).toEqual([{ field: 'timeZone', reason: 'Fuso horário desconhecido.' }]);
  });

  it('vale já na próxima execução: o sistema traz o idioma e o pedido atual traz o "Agora" e o fuso do dono', async () => {
    await settings.update({ language: 'es', timeZone: 'Asia/Tokyo', ownerName: '' }, ORIGIN);
    const bot = await world.createBot();
    await world.waitForStatus(await world.send(bot, 'oi'), 'completed');
    const system = systemOfLastRequest();
    expect(system).toContain('# Dados\n\n- Idioma: espanhol (español)');
    expect(openingOfLastRequest()).toMatch(/^# Dados\n- Modelo desta resposta: .+\n- Agora: .+\n- Fuso: Asia\/Tokyo \(GMT\+09:00\)\n/);
    expect(system).not.toContain('horário de Brasília');
  });

  it('mudar idioma ou fuso não reescreve o bloco já gravado: a rodada anterior segue como foi e só a execução nova usa o idioma e o fuso novos (PERF-01, phase 10)', async () => {
    await settings.update({ language: 'pt-BR', timeZone: 'America/Sao_Paulo', ownerName: '' }, ORIGIN);
    const bot = await world.createBot();
    const first = await world.send(bot, 'primeira rodada');
    await world.waitForStatus(first, 'completed');
    const blockOf = async (runId: string) => (await world.pool.query<{ request_data: string }>('SELECT request_data FROM runs WHERE id = $1', [runId])).rows[0]!.request_data;
    const stored = await blockOf(first);
    expect(stored).toMatch(/^# Dados\n- Modelo desta resposta: .+\n- Agora: .+\n- Fuso: America\/Sao_Paulo \(GMT-03:00\)\n\n# Mensagem\n$/);

    await settings.update({ language: 'en', timeZone: 'Asia/Tokyo', ownerName: '' }, ORIGIN);
    const second = await world.send(bot, 'segunda rodada');
    await world.waitForStatus(second, 'completed');
    const owner = (world.conversationRequests().at(-1)?.body?.messages as { role: string; content: string }[])
      .filter((turn) => turn.role === 'user' && !turn.content.startsWith('# Objetivo do bot ('))
      .map((turn) => turn.content.replace(/\[Evidência do dono: messageId=\d+\]\n\n/g, ''));
    expect(owner[0]).toBe(`${stored}primeira rodada`); // a rodada anterior mantém o bloco gravado, no idioma e no fuso de antes
    expect(owner[1]).toMatch(/^# Dados\n- Modelo desta resposta: .+\n- Agora: .+\n- Fuso: Asia\/Tokyo \(GMT\+09:00\)\n\n# Mensagem\nsegunda rodada$/);
    expect(await blockOf(first)).toBe(stored); // nem no banco
  });

  it('o fuso padrão da proposta de rotina do bot é o do dono (e o fuso dito pelo bot continua valendo)', async () => {
    await settings.update({ language: 'pt-BR', timeZone: 'Europe/Lisbon', ownerName: '' }, ORIGIN);
    const bot = await world.createBot();
    await world.waitForStatus(await world.send(bot, '[rotina:Resumo|07:30]'), 'completed');
    const card = (await world.timeline(bot)).find((entry) => entry.data.type === 'routine_proposal');
    expect(card?.data).toMatchObject({ proposal: { name: 'Resumo', timezone: 'Europe/Lisbon' } });
    await settings.update({ language: 'pt-BR', timeZone: 'America/Sao_Paulo', ownerName: '' }, ORIGIN); // devolve o padrão
    expect(await readAppSettings(world.pool)).toEqual({ language: 'pt-BR', timeZone: 'America/Sao_Paulo' });
  });
});

describe('Como te chamar (nome do dono)', () => {
  const base = { language: 'pt-BR', timeZone: 'America/Sao_Paulo' } as const;
  const lastAudit = () => world.pool.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'settings.updated' ORDER BY id DESC LIMIT 1");

  it('grava, relê, apara os espaços das pontas e aceita 40 caracteres (contados por ponto de código, acentos e emoji incluídos)', async () => {
    expect((await settings.update({ ...base, ownerName: '  Marco  ' }, ORIGIN)).ownerName).toBe('Marco');
    expect((await settings.read()).ownerName).toBe('Marco');
    expect((await world.pool.query('SELECT owner_name FROM app_settings')).rows).toEqual([{ owner_name: 'Marco' }]);
    const forty = 'ã'.repeat(39) + '😀'; // 40 pontos de código, 41 unidades UTF-16
    expect((await settings.update({ ...base, ownerName: forty }, ORIGIN)).ownerName).toBe(forty);
  });

  it('recusa 41 caracteres e qualquer caractere de controle (VALIDATION_FAILED, com o campo) e não grava nada', async () => {
    await settings.update({ ...base, ownerName: 'Marco' }, ORIGIN);
    for (const bad of ['a'.repeat(41), 'Mar\u0000co', 'Mar\nco', 'Mar\tco', 'Mar\u007Fco', 'Mar\u0085co', 'Mar\u2028co', 'Mar\u2029co']) {
      expect([JSON.stringify(bad), await codeOf(settings.update({ ...base, ownerName: bad }, ORIGIN))]).toEqual([JSON.stringify(bad), 'VALIDATION_FAILED']);
    }
    const failure = await settings.update({ ...base, ownerName: 'a'.repeat(41) }, ORIGIN).catch((error: unknown) => error as DomainError);
    expect((failure as DomainError).fields).toEqual([{ field: 'ownerName', reason: 'Valor inválido.' }]);
    expect((await settings.read()).ownerName).toBe('Marco'); // a gravação anterior segue
  });

  it('o banco também recusa mais de 40 caracteres (segunda barreira atrás da validação)', async () => {
    await expect(world.pool.query("UPDATE app_settings SET owner_name = repeat('a', 41)")).rejects.toThrow(/owner_name/);
  });

  it('vazio (ou só espaços) apaga o nome', async () => {
    await settings.update({ ...base, ownerName: 'Marco' }, ORIGIN);
    expect((await settings.update({ ...base, ownerName: '   ' }, ORIGIN)).ownerName).toBe('');
    expect((await settings.read()).ownerName).toBe('');
  });

  it('a auditoria diz só SE o nome mudou, nunca o valor', async () => {
    await settings.update({ ...base, ownerName: '' }, ORIGIN);
    await settings.update({ ...base, ownerName: 'Segredo Do Dono' }, ORIGIN);
    expect((await lastAudit()).rows[0]?.details).toEqual({ language: 'pt-BR', timeZone: 'America/Sao_Paulo', ownerNameChanged: true });
    await settings.update({ ...base, language: 'en', ownerName: 'Segredo Do Dono' }, ORIGIN); // mudou só o idioma
    expect((await lastAudit()).rows[0]?.details).toEqual({ language: 'en', timeZone: 'America/Sao_Paulo', ownerNameChanged: false });
    const everything = JSON.stringify((await world.pool.query('SELECT action, target, details FROM audit_log')).rows);
    expect(everything).not.toContain('Segredo Do Dono');
    await settings.update({ ...base, ownerName: '' }, ORIGIN);
  });

  it('o nome nunca vai ao modelo: nem no turno de sistema, nem no pedido atual, nem nas ferramentas', async () => {
    await settings.update({ ...base, ownerName: 'Zeferino Quartzo' }, ORIGIN);
    const bot = await world.createBot();
    await world.waitForStatus(await world.send(bot, 'oi'), 'completed');
    const requests = world.conversationRequests();
    expect(requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(requests.map((request) => request.body))).not.toContain('Zeferino');
    await settings.update({ ...base, ownerName: '' }, ORIGIN);
  });
});

describe('pesquisa na web (interruptor)', () => {
  const auditRows = () =>
    world.pool.query<{ actor: string; outcome: string; ip: string | null; target: string | null; details: Record<string, unknown> }>(
      "SELECT actor, outcome, ip, target, details FROM audit_log WHERE action = 'settings.web_search' ORDER BY id",
    );

  it('vem ligada por padrão (migration 0017) e a leitura é sempre a do banco, então a mudança vale na próxima consulta do motor', async () => {
    expect(await settings.readWebSearchEnabled()).toBe(true);
    expect(await readWebSearchEnabled(world.pool)).toBe(true);
    expect((await world.pool.query('SELECT web_search_enabled FROM app_settings')).rows).toEqual([{ web_search_enabled: true }]);
    expect((await auditRows()).rows).toEqual([]); // ler não audita
  });

  it('desligar e ligar grava, devolve o valor novo e audita quem, o quê e de onde (só o booleano)', async () => {
    expect(await settings.setWebSearchEnabled(false, ORIGIN)).toBe(false);
    expect(await readWebSearchEnabled(world.pool)).toBe(false);
    expect(await settings.setWebSearchEnabled(true, ORIGIN)).toBe(true);
    expect(await readWebSearchEnabled(world.pool)).toBe(true);
    await settings.setWebSearchEnabled(false, ORIGIN); // fica desligada para o teste seguinte provar o resto
    expect((await auditRows()).rows).toEqual([
      { actor: 'owner', outcome: 'success', ip: ORIGIN.ip, target: 'app_settings', details: { enabled: false } },
      { actor: 'owner', outcome: 'success', ip: ORIGIN.ip, target: 'app_settings', details: { enabled: true } },
      { actor: 'owner', outcome: 'success', ip: ORIGIN.ip, target: 'app_settings', details: { enabled: false } },
    ]);
    expect((await world.pool.query('SELECT count(*) AS total FROM app_settings')).rows[0]).toEqual({ total: '1' }); // continua uma linha só
  });

  it('é independente de idioma e fuso: gravar um não mexe no outro, e as preferências de antes seguem com os campos de sempre', async () => {
    await settings.update({ language: 'es', timeZone: 'Asia/Tokyo', ownerName: '' }, ORIGIN);
    expect(await readWebSearchEnabled(world.pool)).toBe(false); // continua desligada
    expect(await settings.read()).toEqual({ language: 'es', timeZone: 'Asia/Tokyo', ownerName: '' });
    await settings.setWebSearchEnabled(true, ORIGIN);
    expect(await settings.read()).toEqual({ language: 'es', timeZone: 'Asia/Tokyo', ownerName: '' }); // o interruptor não mexeu em idioma e fuso
    await settings.update({ language: 'pt-BR', timeZone: 'America/Sao_Paulo', ownerName: '' }, ORIGIN); // devolve o padrão
  });

  it('sem a linha de app_settings vale o padrão ligado, e gravar a recria sem perder o padrão de idioma e fuso', async () => {
    await world.pool.query('DELETE FROM app_settings');
    expect(await readWebSearchEnabled(world.pool)).toBe(true);
    await settings.setWebSearchEnabled(false, ORIGIN);
    expect(await readWebSearchEnabled(world.pool)).toBe(false);
    expect(await readAppSettings(world.pool)).toEqual({ language: 'pt-BR', timeZone: 'America/Sao_Paulo' });
    expect((await settings.read()).ownerName).toBe(''); // a linha recriada nasce sem nome
    await settings.setWebSearchEnabled(true, ORIGIN);
  });
});

describe('modelo do resumo (compactação de contexto, phase 9, T4)', () => {
  const ok = 'resumo-ok';
  const noTools = 'resumo-sem-ferramentas';
  const failed = 'resumo-falhou';
  const neverTested = 'resumo-so-favorito';
  const conversation = 'modelo-da-conversa';
  const summaryAudits = () =>
    world.pool.query<{ actor: string; ip: string | null; target: string | null; details: Record<string, unknown> }>(
      "SELECT actor, ip, target, details FROM audit_log WHERE action = 'settings.context' AND details->>'scope' = 'summary_model' ORDER BY id",
    );

  /** Perfil de modelo como o teste do provedor o grava: `ok` e `no_tools` têm protocolo; `failed` não; só favoritado nunca foi testado. */
  async function seedProfile(id: string, outcome: 'ok' | 'no_tools' | 'failed' | 'untested'): Promise<void> {
    await world.pool.query('DELETE FROM model_profiles WHERE model_id = $1', [id]);
    if (outcome === 'untested') {
      await world.pool.query('INSERT INTO model_profiles (model_id, favorited_at, created_at, updated_at) VALUES ($1, now(), now(), now())', [id]);
      return;
    }
    await world.pool.query(
      `INSERT INTO model_profiles (model_id, test_status, test_reason, test_protocol, effort_levels, tested_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, '{}', now(), now(), now())`,
      [id, outcome, outcome === 'ok' ? null : outcome === 'no_tools' ? 'no_tool_call' : 'unsupported', outcome === 'failed' ? null : 'chat_completions'],
    );
  }

  beforeAll(async () => {
    await seedProfile(ok, 'ok');
    await seedProfile(noTools, 'no_tools');
    await seedProfile(failed, 'failed');
    await seedProfile(neverTested, 'untested');
  });

  it('quem nunca escolheu fica sem modelo do resumo (o da conversa), e a tela lê as janelas e o modelo juntos', async () => {
    expect(await readSummaryModel(world.pool)).toBeNull();
    expect(await settings.readContextPreferences()).toEqual({ bots: expect.any(Number), generalChat: expect.any(Number), summaryModel: null });
  });

  it('grava um modelo validado (ok ou sem ferramentas, que o resumo não usa), relê e volta ao modelo da conversa com nulo, auditando quem, o quê e de onde', async () => {
    for (const model of [ok, noTools]) {
      expect(await settings.updateContextPreference({ scope: 'summary_model', summaryModel: model }, ORIGIN)).toMatchObject({ summaryModel: model });
      expect(await readSummaryModel(world.pool)).toBe(model);
    }
    expect((await settings.updateContextPreference({ scope: 'summary_model', summaryModel: null }, ORIGIN)).summaryModel).toBeNull();
    expect(await readSummaryModel(world.pool)).toBeNull();
    const audits = (await summaryAudits()).rows;
    expect(audits.map((row) => row.details)).toEqual([
      { scope: 'summary_model', summaryModel: ok },
      { scope: 'summary_model', summaryModel: noTools },
      { scope: 'summary_model', summaryModel: null },
    ]);
    expect(audits.every((row) => row.actor === 'owner' && row.ip === ORIGIN.ip && row.target === 'app_settings')).toBe(true);
    expect((await world.pool.query('SELECT count(*) AS total FROM app_settings')).rows[0]).toEqual({ total: '1' }); // continua uma linha só
  });

  it('recusa o que não é modelo validado (falhou no teste, só favoritado, desconhecido) e o que fere o formato, com o campo, e não grava nada', async () => {
    await settings.updateContextPreference({ scope: 'summary_model', summaryModel: ok }, ORIGIN);
    const auditsBefore = (await summaryAudits()).rowCount;
    for (const bad of [failed, neverTested, 'modelo-que-nao-existe', "x'; DROP TABLE app_settings; --"]) {
      const failure = await settings.updateContextPreference({ scope: 'summary_model', summaryModel: bad }, ORIGIN).catch((error: unknown) => error as DomainError);
      expect([bad, (failure as DomainError).code, (failure as DomainError).fields]).toEqual([bad, 'VALIDATION_FAILED', [{ field: 'summaryModel', reason: 'Escolha um modelo validado.' }]]);
    }
    for (const bad of ['', 'a'.repeat(210), 'mo\ndelo', 7, undefined]) {
      expect([JSON.stringify(bad), await codeOf(settings.updateContextPreference({ scope: 'summary_model', summaryModel: bad } as never, ORIGIN))]).toEqual([JSON.stringify(bad), 'VALIDATION_FAILED']);
    }
    expect(await readSummaryModel(world.pool)).toBe(ok); // a escolha anterior segue
    expect((await summaryAudits()).rowCount).toBe(auditsBefore); // recusa não audita como sucesso
  });

  it('é independente das janelas: gravar uma não mexe na outra, e o banco recusa vazio e mais de 209 caracteres (segunda barreira)', async () => {
    await settings.updateContextPreference({ scope: 'summary_model', summaryModel: ok }, ORIGIN);
    await settings.updateContextPreference({ scope: 'bots', windowTokens: 131072 }, ORIGIN);
    expect(await settings.readContextPreferences()).toMatchObject({ bots: 131072, summaryModel: ok });
    const windows = await settings.readContextPreferences();
    await settings.updateContextPreference({ scope: 'summary_model', summaryModel: null }, ORIGIN);
    expect(await settings.readContextPreferences()).toEqual({ ...windows, summaryModel: null });
    await settings.updateContextPreference({ scope: 'bots', windowTokens: 262144 }, ORIGIN); // devolve o padrão (256k desde a 0046)
    await expect(world.pool.query("UPDATE app_settings SET summary_model = repeat('a', 210)")).rejects.toThrow(/summary_model/);
    await expect(world.pool.query("UPDATE app_settings SET summary_model = ''")).rejects.toThrow(/summary_model/);
  });

  it('resolve o modelo efetivo: vazio usa o da conversa; o salvo vale enquanto estiver validado no uso; invalidado ou removido cai no da conversa e registra só ids', async () => {
    const logger = { warn: vi.fn() };
    await settings.updateContextPreference({ scope: 'summary_model', summaryModel: null }, ORIGIN);
    expect(await resolveSummaryModel(world.pool, conversation, logger)).toBe(conversation);

    await settings.updateContextPreference({ scope: 'summary_model', summaryModel: ok }, ORIGIN);
    expect(await isValidatedModel(world.pool, ok)).toBe(true);
    expect(await resolveSummaryModel(world.pool, conversation, logger)).toBe(ok);
    expect(await resolveSummaryModel(world.pool, ok, logger)).toBe(ok); // igual ao da conversa: nada a trocar
    expect(logger.warn).not.toHaveBeenCalled();

    // Um novo teste do modelo falhou: o salvo deixa de ser validado e o resumo volta ao modelo da conversa, sem apagar a escolha do dono.
    await seedProfile(ok, 'failed');
    expect(await isValidatedModel(world.pool, ok)).toBe(false);
    expect(await resolveSummaryModel(world.pool, conversation, logger)).toBe(conversation);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenLastCalledWith({ summaryModel: ok, conversationModel: conversation }, expect.stringContaining('modelo do resumo'));
    expect(await readSummaryModel(world.pool)).toBe(ok);

    // Perfil removido: o mesmo.
    await world.pool.query('DELETE FROM model_profiles WHERE model_id = $1', [ok]);
    expect(await resolveSummaryModel(world.pool, conversation, logger)).toBe(conversation);
    expect(logger.warn).toHaveBeenCalledTimes(2);

    // Voltou a ser validado: a mesma escolha volta a valer, sem o dono precisar escolher de novo.
    await seedProfile(ok, 'ok');
    expect(await resolveSummaryModel(world.pool, conversation, logger)).toBe(ok);
    await settings.updateContextPreference({ scope: 'summary_model', summaryModel: null }, ORIGIN);
  });
});
