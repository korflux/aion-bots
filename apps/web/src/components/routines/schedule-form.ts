// Formulário da rotina no cliente: valores em texto (como os campos os guardam), a montagem da agenda a partir deles e a validação
// antes do envio. Funções puras, testadas em schedule-form.test.ts.
//
// A forma da agenda é validada com o MESMO schema da API (`routineScheduleSettingsSchema` de @aion/shared), então o formato nunca
// diverge do servidor. As regras com motivo legível (intervalo mínimo de 5 minutos, cron válido, janela, data no futuro, fuso)
// ficam com o servidor: a prévia as devolve a cada alteração e o salvar as recusa com o mesmo motivo (SCHEDULE_INVALID).
import {
  DEFAULT_ROUTINE_TIMEZONE,
  ROUTINE_INSTRUCTION_MAX,
  ROUTINE_MAX_RUNS_LIMIT,
  ROUTINE_NAME_MAX,
  WEEKDAYS,
  routineScheduleSettingsSchema,
  type MonthPosition,
  type RoutineProposal,
  type RoutineReplace,
  type RoutineScheduleSettings,
  type RoutineView,
  type ScheduleDefinition,
  type Weekday,
} from '@aion/shared';

/** Tipos do controle segmentado; Mensal reúne as três modalidades do contrato do servidor. */
export type ScheduleKind = 'once' | 'interval' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'cron';

export const SCHEDULE_KINDS: readonly { value: ScheduleKind; label: string }[] = [
  { value: 'once', label: 'Única' },
  { value: 'interval', label: 'Intervalo' },
  { value: 'daily', label: 'Diária' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'monthly', label: 'Mensal' },
  { value: 'yearly', label: 'Anual' },
  { value: 'cron', label: 'Cron' },
];

/** Nome completo (acessível) e letra de cada dia (design: pílulas S T Q Q S S D). */
export const WEEKDAY_LABELS: Record<Weekday, { letter: string; name: string }> = {
  MO: { letter: 'S', name: 'Segunda-feira' },
  TU: { letter: 'T', name: 'Terça-feira' },
  WE: { letter: 'Q', name: 'Quarta-feira' },
  TH: { letter: 'Q', name: 'Quinta-feira' },
  FR: { letter: 'S', name: 'Sexta-feira' },
  SA: { letter: 'S', name: 'Sábado' },
  SU: { letter: 'D', name: 'Domingo' },
};

export const POSITION_LABELS: Record<MonthPosition, string> = { first: 'primeira', second: 'segunda', third: 'terceira', fourth: 'quarta', last: 'última' };

export const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export interface RoutineFormValues {
  name: string;
  botId: string;
  instruction: string;
  kind: ScheduleKind;
  /** Única: `AAAA-MM-DDTHH:mm`, a hora de parede no fuso da rotina. */
  onceAt: string;
  /** Intervalo: o número como texto (o dono pode apagar ou digitar lixo antes de corrigir). */
  everyText: string;
  unit: 'minutes' | 'hours';
  windowOn: boolean;
  windowFrom: string;
  windowTo: string;
  /** Diária e semanal. */
  times: string[];
  days: Weekday[];
  /** Mensal. */
  monthlyMode: 'day' | 'position' | 'business';
  /** `1` a `31` ou `last`. */
  monthDay: string;
  position: MonthPosition;
  positionWeekday: Weekday;
  monthTime: string;
  /** Posição útil 1 a 20 ou last como texto do seletor, sem regra de calendário no cliente. */
  businessPosition: string;
  /** Anual. */
  yearMonth: string;
  yearDay: string;
  yearTime: string;
  cron: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
  maxRunsText: string;
}

/** Campos que podem ter erro. `schedule` é o erro da agenda como um todo (a tela o mostra na seção Agenda). */
export type RoutineFormField = 'name' | 'botId' | 'instruction' | 'schedule' | 'timezone' | 'startsAt' | 'endsAt' | 'maxRuns';
export type RoutineFormErrors = Partial<Record<RoutineFormField, string>>;

const pad = (value: number): string => String(value).padStart(2, '0');

/** Amanhã às 09:00 (hora do navegador) no formato do campo: nunca está no passado em fuso nenhum. */
function tomorrowMorning(now: Date): string {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T09:00`;
}

/** Formulário de uma rotina nova: diária às 07:00 no fuso padrão. */
export function emptyRoutineForm(botId = '', now: Date = new Date()): RoutineFormValues {
  return {
    name: '',
    botId,
    instruction: '',
    kind: 'daily',
    onceAt: tomorrowMorning(now),
    everyText: '30',
    unit: 'minutes',
    windowOn: false,
    windowFrom: '09:00',
    windowTo: '18:00',
    times: ['07:00'],
    days: ['MO', 'TU', 'WE', 'TH', 'FR'],
    monthlyMode: 'day',
    monthDay: '1',
    position: 'first',
    positionWeekday: 'MO',
    monthTime: '09:00',
    businessPosition: '1',
    yearMonth: '1',
    yearDay: '1',
    yearTime: '09:00',
    cron: '0 7 * * 1-5',
    timezone: DEFAULT_ROUTINE_TIMEZONE,
    startsAt: '',
    endsAt: '',
    maxRunsText: '',
  };
}

/** A definição da agenda a partir dos campos do tipo escolhido (ainda sem validar). */
function scheduleOf(values: RoutineFormValues): unknown {
  switch (values.kind) {
    case 'once':
      return { type: 'once', at: values.onceAt };
    case 'interval':
      return {
        type: 'interval',
        every: values.everyText.trim() === '' ? Number.NaN : Number(values.everyText),
        unit: values.unit,
        window: values.windowOn ? { from: values.windowFrom, to: values.windowTo } : null,
      };
    case 'daily':
      return { type: 'daily', times: values.times };
    case 'weekly':
      return { type: 'weekly', days: WEEKDAYS.filter((day) => values.days.includes(day)), times: values.times };
    case 'monthly':
      if (values.monthlyMode === 'business') return { type: 'monthly_business_day', position: values.businessPosition === 'last' ? 'last' : Number(values.businessPosition), time: values.monthTime };
      return values.monthlyMode === 'day'
        ? { type: 'monthly_day', day: values.monthDay === 'last' ? 'last' : Number(values.monthDay), time: values.monthTime }
        : { type: 'monthly_position', position: values.position, weekday: values.positionWeekday, time: values.monthTime };
    case 'yearly':
      return { type: 'yearly', month: Number(values.yearMonth), day: Number(values.yearDay), time: values.yearTime };
    case 'cron':
      return { type: 'cron', expression: values.cron.trim() };
  }
}

/**
 * A agenda do formulário no formato da API, ou `null` se ainda está incompleta ou fora da forma (campo vazio, hora quebrada, número
 * que não é número). É o que a prévia envia a cada alteração; as regras com motivo legível ficam com o servidor.
 */
export function settingsOf(values: RoutineFormValues): RoutineScheduleSettings | null {
  const parsed = routineScheduleSettingsSchema.safeParse({
    schedule: scheduleOf(values),
    timezone: values.timezone.trim(),
    startsAt: values.startsAt === '' ? null : values.startsAt,
    endsAt: values.endsAt === '' ? null : values.endsAt,
    maxRuns: values.maxRunsText.trim() === '' ? null : Number(values.maxRunsText),
  });
  return parsed.success ? parsed.data : null;
}

export type RoutineDraft = RoutineReplace;

export interface RoutineFormResult {
  draft: RoutineDraft | null;
  errors: RoutineFormErrors;
}

/** Valida o formulário inteiro antes do envio e monta o corpo da API. */
export function validateRoutineForm(values: RoutineFormValues): RoutineFormResult {
  const errors: RoutineFormErrors = {};
  const name = values.name.trim();
  const instruction = values.instruction.trim();
  if (name === '') errors.name = 'Informe o nome.';
  else if (Array.from(name).length > ROUTINE_NAME_MAX) errors.name = `Use até ${ROUTINE_NAME_MAX} caracteres.`;
  if (values.botId === '') errors.botId = 'Escolha o bot.';
  if (instruction === '') errors.instruction = 'Informe a instrução.';
  else if (Array.from(instruction).length > ROUTINE_INSTRUCTION_MAX) errors.instruction = `Use até ${ROUTINE_INSTRUCTION_MAX.toLocaleString('pt-BR')} caracteres.`;

  if (values.maxRunsText.trim() !== '') {
    const maxRuns = Number(values.maxRunsText);
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > ROUTINE_MAX_RUNS_LIMIT) {
      errors.maxRuns = `Informe um número de 1 a ${ROUTINE_MAX_RUNS_LIMIT.toLocaleString('pt-BR')}.`;
    }
  }
  if (values.timezone.trim() === '') errors.timezone = 'Informe o fuso horário.';
  const settings = settingsOf(values);
  if (settings === null && !errors.maxRuns && !errors.timezone) errors.schedule = 'Complete a agenda.';

  if (Object.keys(errors).length > 0 || settings === null) return { draft: null, errors };
  return { draft: { name, botId: values.botId, instruction, ...settings }, errors };
}

/** Preenche os campos de um tipo da agenda, deixando os outros no padrão. */
function applySchedule(base: RoutineFormValues, schedule: ScheduleDefinition): RoutineFormValues {
  switch (schedule.type) {
    case 'once':
      return { ...base, kind: 'once', onceAt: schedule.at };
    case 'interval':
      return {
        ...base,
        kind: 'interval',
        everyText: String(schedule.every),
        unit: schedule.unit,
        windowOn: schedule.window !== null,
        ...(schedule.window ? { windowFrom: schedule.window.from, windowTo: schedule.window.to } : {}),
      };
    case 'daily':
      return { ...base, kind: 'daily', times: [...schedule.times] };
    case 'weekly':
      return { ...base, kind: 'weekly', days: [...schedule.days], times: [...schedule.times] };
    case 'monthly_day':
      return { ...base, kind: 'monthly', monthlyMode: 'day', monthDay: String(schedule.day), monthTime: schedule.time };
    case 'monthly_business_day':
      return { ...base, kind: 'monthly', monthlyMode: 'business', businessPosition: String(schedule.position), monthTime: schedule.time };
    case 'monthly_position':
      return { ...base, kind: 'monthly', monthlyMode: 'position', position: schedule.position, positionWeekday: schedule.weekday, monthTime: schedule.time };
    case 'yearly':
      return { ...base, kind: 'yearly', yearMonth: String(schedule.month), yearDay: String(schedule.day), yearTime: schedule.time };
    case 'cron':
      return { ...base, kind: 'cron', cron: schedule.expression };
  }
}

/** Os campos que a agenda e o período compartilham, a partir de uma rotina salva ou de uma proposta do bot. */
function fromSettings(base: RoutineFormValues, settings: RoutineScheduleSettings): RoutineFormValues {
  return {
    ...applySchedule(base, settings.schedule),
    timezone: settings.timezone,
    startsAt: settings.startsAt ?? '',
    endsAt: settings.endsAt ?? '',
    maxRunsText: settings.maxRuns === null ? '' : String(settings.maxRuns),
  };
}

/** O formulário de edição de uma rotina salva. */
export function formFromRoutine(routine: RoutineView, now: Date = new Date()): RoutineFormValues {
  const base = { ...emptyRoutineForm(routine.bot.id, now), name: routine.name, instruction: routine.instruction };
  return fromSettings(base, {
    schedule: routine.schedule,
    timezone: routine.timezone,
    startsAt: routine.startsAt,
    endsAt: routine.endsAt,
    maxRuns: routine.maxRuns,
  });
}

/** O formulário preenchido pela proposta de um bot (botão Editar do cartão), para o dono ajustar antes de salvar. */
export function formFromProposal(proposal: RoutineProposal, botId: string, now: Date = new Date()): RoutineFormValues {
  return fromSettings({ ...emptyRoutineForm(botId, now), name: proposal.name, instruction: proposal.instruction }, proposal);
}

/** Traduz os motivos de um `VALIDATION_FAILED` da API para os campos do formulário (o que não se reconhece vira erro da agenda). */
export function errorsFromApi(fields: readonly { field: string; reason: string }[] | undefined): RoutineFormErrors {
  const errors: RoutineFormErrors = {};
  for (const { field, reason } of fields ?? []) {
    const head = field.split('.')[0] ?? '';
    if (head === 'name') errors.name = 'Nome inválido.';
    else if (head === 'botId') errors.botId = 'Escolha o bot.';
    else if (head === 'instruction') errors.instruction = 'Instrução inválida.';
    else if (head === 'timezone') errors.timezone = 'Fuso horário inválido.';
    else if (head === 'startsAt') errors.startsAt = 'Data de início inválida.';
    else if (head === 'endsAt') errors.endsAt = 'Data de fim inválida.';
    else if (head === 'maxRuns') errors.maxRuns = 'Limite inválido.';
    else errors.schedule = head === 'schedule' && reason !== 'Valor inválido.' ? reason : 'Complete a agenda.';
  }
  return errors;
}
