// Relógio exclusivo do smoke: o preload controla datas dos processos reais sem configuração de produto.
// Timers continuam reais para a fila, polling e encerramento funcionarem normalmente.
const NativeDate = Date;
const instant = NativeDate.parse(process.env.AION_SMOKE_FIXED_NOW ?? '');
if (!Number.isFinite(instant)) throw new Error('O preload do smoke exige uma data ISO válida.');
globalThis.Date = new Proxy(NativeDate, {
  /** Datas sem argumentos representam o instante da fixture; conversões explícitas permanecem nativas. */
  construct(target, args) { return Reflect.construct(target, args.length ? args : [instant]); },
  /** Também preserva a chamada Date() sem new. */
  apply() { return new NativeDate(instant).toString(); },
  /** Só Date.now muda; parse, UTC e prototype continuam nativos. */
  get(target, property) { return property === 'now' ? () => instant : Reflect.get(target, property); },
});
