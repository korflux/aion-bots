# Textarea

Irmã do Input (ui/textarea.tsx): mesma superfície, borda border-strong e erro por `aria-invalid`. Usada em Regras, Memória e Regras Globais.

- Mínimo de 160 px; cresce com o conteúdo (`field-sizing: content`) até 60 dvh e então rola.
- 16 px no celular, 14 px com entrelinha de 24 px no desktop.
- Contador de caracteres (limite de 8.000 da memória) fica abaixo, em small text-muted, e vira danger ao passar do limite.
