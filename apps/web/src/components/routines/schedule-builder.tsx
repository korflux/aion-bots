'use client';

// Construtor de agenda do editor de rotina (design: Editor de rotina → Agenda): o controle segmentado do tipo (Única, Intervalo, Diária,
// Semanal, Mensal, Anual, Cron) e os campos de cada tipo, mais o fuso. Só desenha os campos e entrega as mudanças; a montagem da
// definição e a validação estão em `schedule-form.ts`, e a prévia é do `RoutinePreview`.
//
// Campos nativos de propósito (`datetime-local`, `time`, `select`, `datalist`): o teclado, o leitor de tela e o seletor do celular
// vêm prontos, e o valor já sai no formato que a API espera (`AAAA-MM-DDTHH:mm`, `HH:mm`).
import { MONTH_POSITIONS, WEEKDAYS } from '@aion/shared';
import { Plus, X } from 'lucide-react';
import { useId } from 'react';
import { SegmentedControl } from '@/components/approvals/segmented-control';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { timeZoneOptions } from '@/lib/time-zones';
import { cn } from '@/lib/cn';
import { MONTH_NAMES, POSITION_LABELS, SCHEDULE_KINDS, WEEKDAY_LABELS, type RoutineFormValues } from './schedule-form';

interface BuilderProps {
  values: RoutineFormValues;
  onChange: (patch: Partial<RoutineFormValues>) => void;
  /** Erro da agenda como um todo (motivo legível do servidor ou "Complete a agenda"). */
  scheduleError?: string;
  timezoneError?: string;
  /** Descrição legível gerada pela prévia, mostrada sob o cron. */
  cronDescription: string | null;
}

const describedBy = (...ids: (string | false | undefined)[]): string | undefined => ids.filter(Boolean).join(' ') || undefined;

/** Lista de horários com "adicionar horário" e remover (o `x` leva o nome do horário). */
function TimesField({ label, times, onChange }: { label: string; times: string[]; onChange: (times: string[]) => void }) {
  const base = useId();
  function add() {
    const taken = new Set(times);
    const next = ['09:00', '12:00', '15:00', '18:00', '21:00', '06:00', '08:00', '10:00'].find((time) => !taken.has(time)) ?? '09:00';
    onChange([...times, next]);
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-medium text-fg">{label}</legend>
      {times.map((time, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            id={`${base}-${index}`}
            type="time"
            aria-label={`Horário ${index + 1}`}
            value={time}
            onChange={(event) => onChange(times.map((current, at) => (at === index ? event.target.value : current)))}
            className="w-36"
          />
          {times.length > 1 ? (
            <Button variant="ghost" size="icon" aria-label={`Remover horário ${time || index + 1}`} onClick={() => onChange(times.filter((_, at) => at !== index))}>
              <X className="size-4" strokeWidth={1.5} aria-hidden />
            </Button>
          ) : null}
        </div>
      ))}
      <div>
        <Button variant="ghost" size="sm" onClick={add}>
          <Plus className="size-4" strokeWidth={1.5} aria-hidden />
          Adicionar horário
        </Button>
      </div>
    </fieldset>
  );
}

/** Sete pílulas de dia (S T Q Q S S D), cada uma com o nome completo acessível. */
function WeekdayPills({ days, onChange }: { days: RoutineFormValues['days']; onChange: (days: RoutineFormValues['days']) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-fg">Dias da semana</legend>
      <div className="flex gap-1.5">
        {WEEKDAYS.map((day) => {
          const on = days.includes(day);
          return (
            <button
              key={day}
              type="button"
              aria-pressed={on}
              aria-label={WEEKDAY_LABELS[day].name}
              onClick={() => onChange(on ? days.filter((current) => current !== day) : [...days, day])}
              className={cn(
                'size-9 shrink-0 rounded-full border text-sm font-medium transition-colors max-md:size-9',
                on ? 'border-transparent bg-action text-action-fg' : 'border-line-strong bg-surface text-muted hover:bg-surface-hover hover:text-fg',
              )}
            >
              <span aria-hidden>{WEEKDAY_LABELS[day].letter}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function ScheduleBuilder({ values, onChange, scheduleError, timezoneError, cronDescription }: BuilderProps) {
  const base = useId();
  const zones = timeZoneOptions();
  const errorId = `${base}-erro`;
  const invalid = scheduleError ? true : undefined;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="mb-1.5 text-sm font-medium text-fg">Tipo de agenda</p>
        <SegmentedControl
          label="Tipo de agenda"
          options={SCHEDULE_KINDS.map((kind) => ({ value: kind.value, label: kind.label }))}
          value={values.kind}
          onChange={(kind) => onChange({ kind })}
          className="flex w-full flex-wrap"
        />
      </div>

      {values.kind === 'once' ? (
        <div>
          <Label htmlFor={`${base}-quando`}>Data e hora</Label>
          <Input
            id={`${base}-quando`}
            type="datetime-local"
            value={values.onceAt}
            onChange={(event) => onChange({ onceAt: event.target.value })}
            aria-invalid={invalid}
            aria-describedby={describedBy(scheduleError && errorId)}
            className="max-w-64"
          />
        </div>
      ) : null}

      {values.kind === 'interval' ? (
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor={`${base}-cada`}>A cada</Label>
            <div className="flex items-center gap-2">
              <Input
                id={`${base}-cada`}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={values.everyText}
                onChange={(event) => onChange({ everyText: event.target.value })}
                aria-invalid={invalid}
                aria-describedby={describedBy(scheduleError && errorId)}
                className="w-24"
              />
              <Select aria-label="Unidade do intervalo" value={values.unit} onChange={(event) => onChange({ unit: event.target.value as RoutineFormValues['unit'] })} className="w-32">
                <option value="minutes">minutos</option>
                <option value="hours">horas</option>
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input type="checkbox" checked={values.windowOn} onChange={(event) => onChange({ windowOn: event.target.checked })} className="size-4" />
            Somente em uma janela do dia
          </label>
          {values.windowOn ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
              <Input type="time" aria-label="Janela: início" value={values.windowFrom} onChange={(event) => onChange({ windowFrom: event.target.value })} className="w-32" />
              <span>até</span>
              <Input type="time" aria-label="Janela: fim" value={values.windowTo} onChange={(event) => onChange({ windowTo: event.target.value })} className="w-32" />
            </div>
          ) : null}
        </div>
      ) : null}

      {values.kind === 'daily' ? <TimesField label="Horários" times={values.times} onChange={(times) => onChange({ times })} /> : null}

      {values.kind === 'weekly' ? (
        <>
          <WeekdayPills days={values.days} onChange={(days) => onChange({ days })} />
          <TimesField label="Horários" times={values.times} onChange={(times) => onChange({ times })} />
        </>
      ) : null}

      {values.kind === 'monthly' ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1.5 text-sm font-medium text-fg">Modalidade mensal</legend>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="radio" name={`${base}-modo`} checked={values.monthlyMode === 'day'} onChange={() => onChange({ monthlyMode: 'day' })} className="size-4" />
              Dia do mês
            </label>
            <Select
              aria-label="Dia do mês"
              value={values.monthDay}
              disabled={values.monthlyMode !== 'day'}
              onChange={(event) => onChange({ monthDay: event.target.value })}
              className="w-28"
            >
              {Array.from({ length: 31 }, (_, index) => (
                <option key={index + 1} value={String(index + 1)}>
                  {index + 1}
                </option>
              ))}
              <option value="last">último</option>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="radio" name={`${base}-modo`} checked={values.monthlyMode === 'position'} onChange={() => onChange({ monthlyMode: 'position' })} className="size-4" />
              Dia da semana
            </label>
            <Select
              aria-label="Posição no mês"
              value={values.position}
              disabled={values.monthlyMode !== 'position'}
              onChange={(event) => onChange({ position: event.target.value as RoutineFormValues['position'] })}
              className="w-32"
            >
              {MONTH_POSITIONS.map((position) => (
                <option key={position} value={position}>
                  {POSITION_LABELS[position]}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Dia da semana"
              value={values.positionWeekday}
              disabled={values.monthlyMode !== 'position'}
              onChange={(event) => onChange({ positionWeekday: event.target.value as RoutineFormValues['positionWeekday'] })}
              className="w-44"
            >
              {WEEKDAYS.map((day) => (
                <option key={day} value={day}>
                  {WEEKDAY_LABELS[day].name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="radio" name={`${base}-modo`} checked={values.monthlyMode === 'business'} onChange={() => onChange({ monthlyMode: 'business' })} className="size-4" />
              Dia útil
            </label>
            <Select aria-label="Posição do dia útil" value={values.businessPosition} disabled={values.monthlyMode !== 'business'} onChange={(event) => onChange({ businessPosition: event.target.value })} className="w-44">
              {['Primeiro', 'Segundo', 'Terceiro', 'Quarto', 'Quinto', 'Sexto', 'Sétimo', 'Oitavo', 'Nono', 'Décimo', 'Décimo primeiro', 'Décimo segundo', 'Décimo terceiro', 'Décimo quarto', 'Décimo quinto', 'Décimo sexto', 'Décimo sétimo', 'Décimo oitavo', 'Décimo nono', 'Vigésimo'].map((label, index) => <option key={label} value={String(index + 1)}>{label}</option>)}
              <option value="last">Último</option>
            </Select>
          </div>
          {values.monthlyMode === 'business' ? <p className="text-xs text-subtle">Segunda a sexta, incluindo feriados.</p> : null}
          {values.monthlyMode === 'day' && values.monthDay !== 'last' && Number(values.monthDay) > 28 ? (
            <p className="text-xs text-subtle">Em meses sem esse dia, executa no último dia do mês.</p>
          ) : null}
          <div>
            <Label htmlFor={`${base}-hora-mes`}>Horário</Label>
            <Input id={`${base}-hora-mes`} type="time" value={values.monthTime} onChange={(event) => onChange({ monthTime: event.target.value })} className="w-36" />
          </div>
        </fieldset>
      ) : null}

      {values.kind === 'yearly' ? (
        <fieldset className="flex flex-wrap items-end gap-3">
          <legend className="mb-1.5 text-sm font-medium text-fg">Data anual</legend>
          <div>
            <Label htmlFor={`${base}-dia-ano`}>Dia</Label>
            <Input
              id={`${base}-dia-ano`}
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              value={values.yearDay}
              onChange={(event) => onChange({ yearDay: event.target.value })}
              aria-invalid={invalid}
              aria-describedby={describedBy(scheduleError && errorId)}
              className="w-20"
            />
          </div>
          <div>
            <Label htmlFor={`${base}-mes-ano`}>Mês</Label>
            <Select id={`${base}-mes-ano`} value={values.yearMonth} onChange={(event) => onChange({ yearMonth: event.target.value })} className="w-40">
              {MONTH_NAMES.map((name, index) => (
                <option key={name} value={String(index + 1)}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor={`${base}-hora-ano`}>Horário</Label>
            <Input id={`${base}-hora-ano`} type="time" value={values.yearTime} onChange={(event) => onChange({ yearTime: event.target.value })} className="w-36" />
          </div>
        </fieldset>
      ) : null}

      {values.kind === 'cron' ? (
        <div>
          <Label htmlFor={`${base}-cron`}>Expressão cron</Label>
          <Input
            id={`${base}-cron`}
            value={values.cron}
            onChange={(event) => onChange({ cron: event.target.value })}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid}
            aria-describedby={describedBy(`${base}-cron-ajuda`, scheduleError && errorId)}
            className="font-mono text-[13px]"
          />
          <p id={`${base}-cron-ajuda`} className="mt-1.5 text-xs text-subtle">
            Modo avançado. Cinco campos: minuto, hora, dia do mês, mês e dia da semana. Exemplo: <span className="font-mono">0 7 * * 1-5</span> (dias úteis às 07:00).
          </p>
          {cronDescription ? <p className="mt-1 text-sm text-muted">{cronDescription}</p> : null}
        </div>
      ) : null}

      {scheduleError ? (
        <p id={errorId} className="text-xs text-danger">
          {scheduleError}
        </p>
      ) : null}

      <div>
        <Label htmlFor={`${base}-fuso`}>Fuso horário</Label>
        <Input
          id={`${base}-fuso`}
          list={`${base}-fusos`}
          value={values.timezone}
          onChange={(event) => onChange({ timezone: event.target.value })}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={timezoneError ? true : undefined}
          aria-describedby={describedBy(timezoneError && `${base}-fuso-erro`)}
          className="max-w-80"
        />
        <datalist id={`${base}-fusos`}>
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        {timezoneError ? (
          <p id={`${base}-fuso-erro`} className="mt-1.5 text-xs text-danger">
            {timezoneError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
