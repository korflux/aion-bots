# CodeInput

Campo de código de 6 dígitos do TOTP (ui/code-input.tsx): seis caixas desenhadas com um único `<input>` transparente por cima.

- O input único mantém colagem ("123 456"), autopreenchimento `one-time-code`, teclado numérico e um só nome acessível.
- Caixas de 48 px em bg-app, borda border-strong, dígitos em mono 20 px; a caixa que recebe o próximo dígito ganha o anel focus quando o campo tem foco.
- O sexto dígito dispara `onComplete`: o login envia sozinho.
- Erro: todas as caixas com borda danger.
